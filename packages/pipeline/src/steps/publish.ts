import { ANALYTICS_DEFAULTS } from "@cre/config";
import { publicLinkUrl, transitionContent, transitionPublication, transitionVariant } from "@cre/core";
import type { DbClient, PublicationStatus } from "@cre/db";
import {
  PLATFORM_LIMITS,
  type PublishRequest,
  type PublishResult,
  type SocialPlatform,
} from "@cre/publishing";
import {
  addHours,
  addMinutes,
  classifyError,
  errorMessage,
  FatalError,
  idempotencyKey,
  ProviderError,
} from "@cre/shared";
import { assetLocalPath } from "../assets.ts";
import type { PipelineContext } from "../context.ts";
import { payloadString, type JobExecution } from "../job-types.ts";
import { accountRef, loadSocialCredentials, publisherFor } from "../social.ts";
import { enqueue } from "../outbox.ts";

const POLL_INTERVAL_MINUTES = 1;
const MAX_POLLS = 30;
const SIGNED_URL_TTL_SEC = 6 * 3600;

/**
 * Keep the project status consistent with its publications:
 * first publication out → PUBLISHED; all done → ANALYTICS_PENDING; nothing published and nothing left → FAILED.
 */
export async function syncProjectPublishState(db: DbClient, projectId: string): Promise<void> {
  const project = await db.contentProject.findUnique({
    where: { id: projectId },
    select: {
      status: true,
      publishedAt: true,
      variants: { select: { publications: { select: { status: true, publishedAt: true } } } },
    },
  });
  if (!project) return;
  const pubs = project.variants.flatMap((v) => v.publications);
  const has = (s: PublicationStatus) => pubs.some((p) => p.status === s);
  const pending = has("SCHEDULED") || has("PUBLISHING");
  const firstPublishedAt = pubs
    .filter((p) => p.publishedAt)
    .map((p) => p.publishedAt!.getTime())
    .sort((a, b) => a - b)[0];
  if (has("PUBLISHED")) {
    if (project.status === "SCHEDULED") {
      await transitionContent(db, { projectId, from: "SCHEDULED", to: "PUBLISHING", actor: "SYSTEM" });
    }
    if (project.status === "SCHEDULED" || project.status === "PUBLISHING") {
      await transitionContent(db, {
        projectId,
        from: "PUBLISHING",
        to: "PUBLISHED",
        actor: "SYSTEM",
        data: { publishedAt: firstPublishedAt ? new Date(firstPublishedAt) : new Date() },
      });
    }
    if (!pending) {
      const current = await db.contentProject.findUnique({
        where: { id: projectId },
        select: { status: true },
      });
      if (current?.status === "PUBLISHED") {
        await transitionContent(db, {
          projectId,
          from: "PUBLISHED",
          to: "ANALYTICS_PENDING",
          actor: "SYSTEM",
          reason: "all publications done",
        });
      }
    }
    return;
  }
  if (project.status === "PUBLISHING") {
    if (pending)
      await transitionContent(db, { projectId, from: "PUBLISHING", to: "SCHEDULED", actor: "SYSTEM" });
    else
      await transitionContent(db, {
        projectId,
        from: "PUBLISHING",
        to: "FAILED",
        actor: "SYSTEM",
        reason: "every publication failed",
        data: { resumeStatus: "SCHEDULED", failureReason: "Publishing failed on every platform" },
      });
  }
}

async function finalizePublished(
  ctx: PipelineContext,
  pub: { id: string; workspaceId: string; brandId: string; variantId: string; projectId: string },
  result: { externalPostId: string; externalUrl?: string | undefined; containerId?: string | undefined },
  isMock: boolean,
  runId: string | null,
): Promise<void> {
  const now = ctx.clock.now();
  const offsets = ANALYTICS_DEFAULTS.snapshotOffsetsHours;
  const firstAt = addHours(now, offsets[0] ?? 1);
  await ctx.prisma.$transaction(async (tx) => {
    await transitionPublication(tx, {
      publicationId: pub.id,
      from: "PUBLISHING",
      to: "PUBLISHED",
      data: {
        publishedAt: now,
        externalPostId: result.externalPostId,
        externalUrl: result.externalUrl ?? null,
        ...(result.containerId ? { externalContainerId: result.containerId } : {}),
        lastError: null,
        errorCode: null,
        isMock,
        analyticsUntil: addHours(now, ANALYTICS_DEFAULTS.windowDays * 24),
        nextAnalyticsAt: firstAt,
      },
    });
    await transitionVariant(tx, { variantId: pub.variantId, from: "PUBLISHING", to: "PUBLISHED" });
    await enqueue(ctx, tx, {
      type: "analytics.collect",
      payload: { publicationId: pub.id, index: 0 },
      idempotencyKey: idempotencyKey("analytics", { publicationId: pub.id, index: 0 }),
      workspaceId: pub.workspaceId,
      brandId: pub.brandId,
      projectId: pub.projectId,
      variantId: pub.variantId,
      publicationId: pub.id,
      runAt: firstAt,
      runId,
    });
  });
  await syncProjectPublishState(ctx.prisma, pub.projectId);
}

/**
 * publish.publication — post one approved variant to one social account at its scheduled time.
 * mode "poll" checks an asynchronous upload (IG container / TikTok publish id) until it is live.
 */
export async function publishHandler(exec: JobExecution) {
  const { ctx } = exec;
  const publicationId = payloadString(exec, "publicationId");
  const mode = exec.payload.mode === "poll" ? "poll" : "publish";
  const pub = await loadPublication(ctx, publicationId);
  if (pub.status === "PUBLISHED" || pub.status === "CANCELLED") return { skipped: true, status: pub.status };
  const now = ctx.clock.now();
  const project = pub.variant.project;
  const ids = {
    id: pub.id,
    workspaceId: pub.workspaceId,
    brandId: pub.brandId,
    variantId: pub.variantId,
    projectId: project.id,
  };

  // Rescheduled after this job was queued → defer to the new time.
  if (
    mode === "publish" &&
    pub.status === "SCHEDULED" &&
    pub.scheduledAt.getTime() > now.getTime() + 60_000
  ) {
    await enqueue(ctx, ctx.prisma, {
      type: "publish.publication",
      payload: { publicationId: pub.id },
      idempotencyKey: idempotencyKey("publish", { publicationId: pub.id, at: pub.scheduledAt.toISOString() }),
      workspaceId: pub.workspaceId,
      brandId: pub.brandId,
      projectId: project.id,
      variantId: pub.variantId,
      publicationId: pub.id,
      runAt: pub.scheduledAt,
    });
    return { deferred: true, scheduledAt: pub.scheduledAt.toISOString() };
  }

  try {
    return await publishOrPoll(exec, pub, mode, ids, now);
  } catch (err) {
    // pre-flight problems (kill switch, expired token, invalid post) leave the publication SCHEDULED with the reason
    await ctx.prisma.publication.updateMany({
      where: { id: pub.id, status: "SCHEDULED" },
      data: {
        lastError: errorMessage(err).slice(0, 1000),
        errorCode: String((err as { code?: string }).code ?? "ERROR").slice(0, 60),
      },
    });
    throw err;
  }
}

type LoadedPublication = Awaited<ReturnType<typeof loadPublication>>;

function loadPublication(ctx: PipelineContext, publicationId: string) {
  return ctx.prisma.publication.findUniqueOrThrow({
    where: { id: publicationId },
    include: {
      socialAccount: true,
      variant: { include: { project: true, media: { include: { asset: true } }, trackedLink: true } },
    },
  });
}

async function publishOrPoll(
  exec: JobExecution,
  pub: LoadedPublication,
  mode: "poll" | "publish",
  ids: { id: string; workspaceId: string; brandId: string; variantId: string; projectId: string },
  now: Date,
) {
  const { ctx } = exec;
  const project = pub.variant.project;
  const publisher = publisherFor(ctx, pub.socialAccount);
  const account = accountRef(pub.socialAccount);
  const credentials = await loadSocialCredentials(ctx, pub.socialAccount, publisher);

  // ---- asynchronous upload still processing --------------------------------------------------------------
  if (mode === "poll" || (pub.status === "PUBLISHING" && (pub.externalContainerId || pub.externalPostId))) {
    const status = await publisher.getStatus(
      { externalPostId: pub.externalPostId, containerId: pub.externalContainerId },
      { account, credentials, signal: exec.signal },
    );
    if (status.status === "PUBLISHED") {
      await finalizePublished(
        ctx,
        ids,
        {
          externalPostId: status.externalPostId ?? pub.externalPostId ?? pub.externalContainerId ?? pub.id,
          externalUrl: status.externalUrl,
        },
        publisher.isMock,
        exec.job.runId,
      );
      return { published: true, polled: true };
    }
    const polls = Number(exec.payload.polls ?? 0) + 1;
    if (status.status === "FAILED" || polls > MAX_POLLS) {
      const err = new FatalError(
        `Platform did not publish the post: ${status.error ?? "processing timed out"}`,
        { code: "PLATFORM_PROCESSING_FAILED" },
      );
      await recordPublishFailure(ctx, exec, ids, err);
      throw err;
    }
    await enqueue(ctx, ctx.prisma, {
      type: "publish.publication",
      payload: { publicationId: pub.id, mode: "poll", polls },
      idempotencyKey: idempotencyKey("publish-poll", { publicationId: pub.id, polls }),
      workspaceId: pub.workspaceId,
      brandId: pub.brandId,
      projectId: project.id,
      variantId: pub.variantId,
      publicationId: pub.id,
      runAt: addMinutes(now, POLL_INTERVAL_MINUTES),
    });
    return { processing: true, polls };
  }

  // ---- a previous attempt died mid-flight: never risk a duplicate public post -------------------------------
  if (pub.status === "PUBLISHING" && !publisher.isMock) {
    const err = new FatalError(
      "A previous publish attempt ended in an unknown state — check the account, then retry manually",
      { code: "UNKNOWN_OUTCOME" },
    );
    await recordPublishFailure(ctx, exec, ids, err);
    throw err;
  }
  if (pub.status === "PUBLISHING") {
    // mock publisher: a crashed attempt is simply retried
    await transitionPublication(ctx.prisma, { publicationId: pub.id, from: "PUBLISHING", to: "SCHEDULED" });
    await transitionVariant(ctx.prisma, { variantId: pub.variantId, from: "PUBLISHING", to: "SCHEDULED" });
  }

  const video = pub.variant.media.find((m) => m.role === "VIDEO")?.asset;
  const cover = pub.variant.media.find((m) => m.role === "COVER")?.asset;
  if (!video?.storageKey) throw new FatalError("Variant has no rendered video");
  const platform = pub.platform as SocialPlatform;
  const linkUrl =
    pub.variant.trackedLink && PLATFORM_LIMITS[platform].linkClickable
      ? publicLinkUrl(ctx.env.APP_URL, pub.variant.trackedLink)
      : null;
  if (!publisher.isMock && linkUrl && /localhost|127\.0\.0\.1/.test(linkUrl)) {
    throw new FatalError("APP_URL points to localhost — tracked links would be broken in a public post", {
      code: "APP_URL_NOT_PUBLIC",
    });
  }
  const req: PublishRequest = {
    publicationId: pub.id,
    platform,
    account,
    credentials,
    media: {
      kind: "video",
      videoPath: await assetLocalPath(ctx, video),
      ...(publisher.isMock ? {} : await publicUrls(ctx, video.storageKey, cover?.storageKey ?? null)),
      ...(video.durationMs ? { durationMs: video.durationMs } : {}),
      ...(video.width ? { width: video.width } : {}),
      ...(video.height ? { height: video.height } : {}),
      ...(video.sizeBytes ? { sizeBytes: video.sizeBytes } : {}),
    },
    caption: pub.variant.caption ?? "",
    firstComment: pub.variant.firstComment,
    aiGenerated: pub.variant.aiGenerated || project.aiGenerated,
    link: linkUrl,
    idempotencyKey: `${pub.id}:${pub.sequence}`,
  };
  const problems = publisher.validate(req);
  if (problems.length)
    throw new FatalError(`Post would be rejected by ${platform}: ${problems.join("; ")}`, {
      code: "INVALID_POST",
    });

  await ctx.prisma.$transaction(async (tx) => {
    if (pub.status === "FAILED") {
      // manual retry of a failed publication: back on the schedule first
      await transitionPublication(tx, { publicationId: pub.id, from: "FAILED", to: "SCHEDULED" });
      await transitionVariant(tx, { variantId: pub.variantId, from: "FAILED", to: "SCHEDULED" });
    }
    await transitionPublication(tx, {
      publicationId: pub.id,
      from: "SCHEDULED",
      to: "PUBLISHING",
      data: { attempts: { increment: 1 }, lastError: null, errorCode: null, isMock: publisher.isMock },
    });
    await transitionVariant(tx, { variantId: pub.variantId, from: "SCHEDULED", to: "PUBLISHING" });
    if (project.status === "SCHEDULED")
      await transitionContent(tx, {
        projectId: project.id,
        from: "SCHEDULED",
        to: "PUBLISHING",
        actor: "WORKER",
      });
  });

  let result: PublishResult;
  try {
    result = await publisher.publish(req, { signal: exec.signal, logger: exec.log });
  } catch (err) {
    await recordPublishFailure(ctx, exec, ids, err);
    throw err;
  }
  exec.log.info(
    { platform, externalPostId: result.externalPostId, status: result.status, mock: publisher.isMock },
    "published",
  );
  if (result.status === "PROCESSING") {
    await ctx.prisma.publication.update({
      where: { id: pub.id },
      data: {
        externalContainerId: result.containerId ?? null,
        externalPostId: result.externalPostId || null,
      },
    });
    await enqueue(ctx, ctx.prisma, {
      type: "publish.publication",
      payload: { publicationId: pub.id, mode: "poll", polls: 0 },
      idempotencyKey: idempotencyKey("publish-poll", { publicationId: pub.id, polls: 0 }),
      workspaceId: pub.workspaceId,
      brandId: pub.brandId,
      projectId: project.id,
      variantId: pub.variantId,
      publicationId: pub.id,
      runAt: addMinutes(now, POLL_INTERVAL_MINUTES),
    });
    return { processing: true, externalPostId: result.externalPostId };
  }
  await finalizePublished(ctx, ids, result, publisher.isMock, exec.job.runId);
  return {
    published: true,
    externalPostId: result.externalPostId,
    externalUrl: result.externalUrl ?? null,
    mock: publisher.isMock,
  };
}

async function publicUrls(
  ctx: PipelineContext,
  videoKey: string,
  coverKey: string | null,
): Promise<{ videoUrl?: string; coverUrl?: string }> {
  const videoUrl = await ctx.media.storage.getSignedUrl(videoKey, SIGNED_URL_TTL_SEC);
  const coverUrl = coverKey ? await ctx.media.storage.getSignedUrl(coverKey, SIGNED_URL_TTL_SEC) : null;
  return { ...(videoUrl ? { videoUrl } : {}), ...(coverUrl ? { coverUrl } : {}) };
}

/** Failed attempt: back to SCHEDULED for a retry, or FAILED when retrying cannot help. */
async function recordPublishFailure(
  ctx: PipelineContext,
  exec: JobExecution,
  ids: { id: string; variantId: string; projectId: string },
  err: unknown,
): Promise<void> {
  const final = classifyError(err) !== "retryable" || exec.attempt >= exec.job.maxAttempts;
  const code =
    err instanceof ProviderError
      ? err.status
        ? `HTTP_${err.status}`
        : err.code
      : ((err as { code?: string }).code ?? "ERROR");
  await ctx.prisma.$transaction(async (tx) => {
    await transitionPublication(tx, {
      publicationId: ids.id,
      from: "PUBLISHING",
      to: final ? "FAILED" : "SCHEDULED",
      data: { lastError: errorMessage(err).slice(0, 1000), errorCode: String(code).slice(0, 60) },
    });
    await transitionVariant(tx, {
      variantId: ids.variantId,
      from: "PUBLISHING",
      to: final ? "FAILED" : "SCHEDULED",
    });
  });
  await syncProjectPublishState(ctx.prisma, ids.projectId);
}
