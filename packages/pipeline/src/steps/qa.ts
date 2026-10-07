import { textReviewPrompt } from "@cre/ai";
import { CONTENT_DEFAULTS } from "@cre/config";
import {
  requestRegeneration,
  runTextChecks,
  scoreIssues,
  transitionContent,
  transitionVariant,
  type QaIssue,
} from "@cre/core";
import {
  decimalFieldToMicros,
  type Asset,
  type Prisma,
  type RegenerationScope,
  type RejectionReason,
} from "@cre/db";
import { inspectVideo, VideoProject, type LayoutViolation, type VideoInspection } from "@cre/media";
import { BudgetBlockedError, errorMessage, toJson } from "@cre/shared";
import { assetLocalPath } from "../assets.ts";
import { payloadString, type JobExecution } from "../job-types.ts";
import { runPaidPrompt } from "../paid.ts";
import {
  brandContext,
  isPriceFresh,
  productContext,
  productFacts,
  recentCaptions,
  recentHooks,
} from "../prompt-context.ts";
import { resolveLinkTarget } from "../variants.ts";
import { voiceoverText } from "./assets.ts";
import { armOverrides } from "./experiments.ts";
import type { StoredScript } from "./script.ts";

/** Automatic retries after a QA auto-reject (script rewrite with the findings as feedback). */
export const QA_AUTO_RETRIES = 1;

/** Technical checks on the rendered master video. */
export async function mediaChecks(
  video: Asset | null,
  localPath: string | null,
  expected: { width: number; height: number },
  opts: { placeholderProduct: boolean; mockMedia: boolean; signal?: AbortSignal },
): Promise<{
  issues: QaIssue[];
  inspection: (Omit<VideoInspection, "info"> & { durationMs: number; width: number; height: number }) | null;
}> {
  const issues: QaIssue[] = [];
  if (!video || video.status !== "READY" || !localPath) {
    return {
      issues: [{ code: "missing_video", severity: "blocker", message: "No rendered video" }],
      inspection: null,
    };
  }
  const insp = await inspectVideo(localPath, opts.signal);
  const { info } = insp;
  if (!info.hasVideo)
    issues.push({
      code: "no_video_stream",
      severity: "blocker",
      message: "Rendered file has no video stream",
    });
  if (!info.hasAudio)
    issues.push({ code: "no_audio", severity: "major", message: "Video has no audio track" });
  if (info.width !== expected.width || info.height !== expected.height) {
    issues.push({
      code: "wrong_resolution",
      severity: "major",
      message: `Resolution ${info.width}×${info.height}, expected ${expected.width}×${expected.height}`,
    });
  }
  if (info.durationMs < CONTENT_DEFAULTS.shortVideoMinMs - 3000) {
    issues.push({
      code: "too_short",
      severity: "major",
      message: `Video is only ${(info.durationMs / 1000).toFixed(1)} s`,
    });
  } else if (info.durationMs > CONTENT_DEFAULTS.shortVideoMaxMs + 15_000) {
    issues.push({
      code: "too_long",
      severity: "major",
      message: `Video is ${(info.durationMs / 1000).toFixed(1)} s — short-form performs best under ${CONTENT_DEFAULTS.shortVideoMaxMs / 1000} s`,
    });
  }
  const black = insp.blackSegments.reduce((s, b) => s + b.durationMs, 0);
  if (black > 0)
    issues.push({
      code: "black_frames",
      severity: "major",
      message: `${(black / 1000).toFixed(1)} s of black frames`,
    });
  for (const f of insp.freezeSegments.slice(0, 2)) {
    issues.push({
      code: "static_segment",
      severity: "minor",
      message: `No motion for ${(f.durationMs / 1000).toFixed(1)} s at ${(f.startMs / 1000).toFixed(1)} s`,
    });
  }
  if (insp.integratedLufs !== null && Math.abs(insp.integratedLufs + 14) > 3) {
    issues.push({
      code: "loudness",
      severity: "minor",
      message: `Loudness ${insp.integratedLufs.toFixed(1)} LUFS (target -14)`,
    });
  }
  const violations = (
    (video.metadata as { layoutViolations?: LayoutViolation[] } | null)?.layoutViolations ?? []
  ).slice(0, 3);
  for (const v of violations)
    issues.push({ code: `layout_${v.kind}`, severity: "major", message: v.message });
  if (opts.placeholderProduct) {
    issues.push({
      code: "placeholder_product_image",
      severity: opts.mockMedia ? "info" : "major",
      message: "Product shown as a generated placeholder packshot — add a real product photo",
    });
  }
  return {
    issues,
    inspection: {
      durationMs: info.durationMs,
      width: info.width ?? 0,
      height: info.height ?? 0,
      blackSegments: insp.blackSegments,
      freezeSegments: insp.freezeSegments,
      integratedLufs: insp.integratedLufs,
    },
  };
}

/** Map QA findings to the owner-facing rejection reasons. */
export function rejectionReasonsFor(issues: QaIssue[]): RejectionReason[] {
  const reasons = new Set<RejectionReason>(["QA_FAILED"]);
  for (const i of issues) {
    if (i.severity === "info" || i.severity === "minor") continue;
    if (/claim|price|fact|number|contradiction|placeholder/.test(i.code)) reasons.add("FACTUAL_PROBLEM");
    else if (/hook/.test(i.code)) reasons.add("WEAK_HOOK");
    else if (/cta/.test(i.code)) reasons.add("BAD_CTA");
    else if (/video|black|resolution|layout|too_|static|audio|loudness/.test(i.code))
      reasons.add("BAD_VIDEO");
    else if (/product/.test(i.code)) reasons.add("INCORRECT_PRODUCT");
  }
  return [...reasons];
}

/** Which scoped regeneration can fix the findings automatically (null = needs a human). */
export function autoFixScope(issues: QaIssue[]): RegenerationScope | null {
  const serious = issues.filter((i) => i.severity === "blocker" || i.severity === "major");
  if (serious.length === 0) return null;
  if (
    serious.some((i) =>
      /video|black|resolution|audio|missing_link|broken_url|disclosure|ai_label/.test(i.code),
    )
  )
    return null;
  return serious.every((i) => i.platform || i.field?.includes("caption")) ? "CAPTION" : "SCRIPT";
}

/** pipeline.qa — deterministic text checks + LLM copy review + media checks → score → approval queue or auto-reject. */
export async function qaHandler(exec: JobExecution) {
  const { ctx } = exec;
  const projectId = payloadString(exec, "projectId");
  const project = await ctx.prisma.contentProject.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      brand: { include: { disclosureRules: true } },
      product: true,
      scenes: { orderBy: { index: "asc" } },
      variants: { include: { trackedLink: true } },
      masterAsset: true,
      approvals: { where: { decision: "AUTO_REJECTED" }, select: { id: true } },
    },
  });
  if (project.status !== "QA") return { skipped: true, status: project.status };
  const now = ctx.clock.now();
  const brand = project.brand;
  const script = (project.script ?? null) as StoredScript | null;
  const spec = VideoProject.safeParse(project.renderSpec);
  const onScreenTexts = [
    ...(spec.success
      ? spec.data.texts.map((t) => t.text.replace(/\s*\n\s*/g, " "))
      : project.scenes.map((s) => s.onScreenText ?? "").filter(Boolean)),
    // A/B arm hooks are checked like the original hook
    ...project.variants.map((v) => armOverrides(v).hook).filter((h): h is string => Boolean(h)),
  ];
  const voiceover = voiceoverText(project.scenes);
  const target = await resolveLinkTarget(ctx.prisma, project);
  const variants = project.variants.filter((v) => v.status === "PENDING");
  const facts = project.product
    ? [...productFacts(project.product), { id: "title", claim: project.product.title, source: "product" }]
    : [];

  // 1. deterministic checks ---------------------------------------------------------------------------
  const textIssues = runTextChecks({
    brand: { bannedWords: brand.bannedWords, disclosureRules: brand.disclosureRules },
    product: project.product
      ? {
          title: project.product.title,
          priceMicros: project.product.price ? decimalFieldToMicros(project.product.price) : null,
          priceFresh: isPriceFresh(project.product, now),
          facts,
        }
      : null,
    content: {
      hook: project.hook ?? "",
      cta: project.cta ?? "",
      onScreenTexts,
      voiceover,
      caption: project.caption ?? "",
      hashtags: project.hashtags,
      claimsUsed: script?.claimsUsed ?? [],
      isMonetized: target?.isAffiliate ?? false,
      aiGenerated: project.aiGenerated,
      sceneKinds: project.scenes.map((s) => s.kind),
    },
    variants: variants.map((v) => ({
      platform: v.platform,
      caption: v.caption ?? "",
      hashtags: v.hashtags,
      disclosureText: v.disclosureText,
      destinationUrl: v.trackedLink?.destinationUrl ?? null,
    })),
    recentHooks: await recentHooks(ctx.prisma, project.brandId, now, project.id),
    recentCaptions: await recentCaptions(ctx.prisma, project.brandId, now, project.id),
  });

  // 2. LLM copy review (cheap model; budget-guarded) --------------------------------------------------
  let llm: { score: number; assessment: string } | null = null;
  const llmIssues: QaIssue[] = [];
  if (project.product) {
    const review = await runPaidPrompt(
      exec,
      textReviewPrompt,
      {
        brand: brandContext(brand),
        product: productContext(project.product, now),
        hook: project.hook ?? "",
        onScreenTexts,
        voiceover,
        caption: variants[0]?.caption ?? project.caption ?? "",
      },
      {
        workspaceId: project.workspaceId,
        brandId: project.brandId,
        projectId: project.id,
        opKey: `qa:${project.id}:${project.revision}`,
      },
    );
    llm = { score: review.data.score, assessment: review.data.overallAssessment };
    for (const i of review.data.issues) {
      llmIssues.push({
        code: `llm_${i.type}`,
        severity: i.severity,
        message: `${i.explanation}${i.excerpt ? ` — "${i.excerpt}"` : ""}${i.suggestion ? ` (suggestion: ${i.suggestion})` : ""}`,
        field: "copy",
      });
    }
  }

  // 3. media checks -------------------------------------------------------------------------------------
  const productAsset = project.product?.primaryImageAssetId
    ? await ctx.prisma.asset.findUnique({ where: { id: project.product.primaryImageAssetId } })
    : null;
  const placeholderProduct = Boolean(
    (productAsset?.metadata as { placeholder?: boolean } | null)?.placeholder,
  );
  const media = await mediaChecks(
    project.masterAsset,
    project.masterAsset?.status === "READY" ? await assetLocalPath(ctx, project.masterAsset) : null,
    { width: ctx.render.width, height: ctx.render.height },
    { placeholderProduct, mockMedia: ctx.env.MOCK_MEDIA, signal: exec.signal },
  );

  // 4. score ---------------------------------------------------------------------------------------------
  const issues = [...textIssues, ...llmIssues, ...media.issues];
  const threshold = brand.qaThreshold;
  const globalIssues = issues.filter((i) => !i.platform);
  const perVariant = variants.map((v) => {
    const vIssues = issues.filter((i) => !i.platform || i.platform === v.platform);
    return { variant: v, issues: vIssues, score: scoreIssues(vIssues, threshold) };
  });
  const global = scoreIssues(globalIssues, threshold);
  const passed = perVariant.length ? perVariant.some((p) => p.score.passed) : global.passed;
  const score = perVariant.length ? Math.max(...perVariant.map((p) => p.score.score)) : global.score;
  const report = {
    score,
    passed,
    threshold,
    issues,
    variants: Object.fromEntries(
      perVariant.map((p) => [p.variant.platform, { score: p.score.score, passed: p.score.passed }]),
    ),
    llm,
    media: media.inspection,
    checkedAt: now.toISOString(),
    revision: project.revision,
  };
  const reasons = rejectionReasonsFor(issues);
  const blockerSummary = issues
    .filter((i) => i.severity === "blocker" || i.severity === "major")
    .slice(0, 6)
    .map((i) => `${i.platform ? `[${i.platform}] ` : ""}${i.message}`);

  await ctx.prisma.$transaction(async (tx) => {
    for (const p of perVariant) {
      await tx.contentVariant.update({
        where: { id: p.variant.id },
        data: {
          qaScore: p.score.score,
          qaIssues: toJson(
            p.issues.filter((i) => i.platform === p.variant.platform),
          ) as Prisma.InputJsonValue,
        },
      });
      if (passed)
        await transitionVariant(tx, {
          variantId: p.variant.id,
          from: "PENDING",
          to: p.score.passed ? "READY" : "SKIPPED",
        });
    }
    if (passed) {
      await transitionContent(tx, {
        projectId: project.id,
        from: "QA",
        to: "WAITING_APPROVAL",
        actor: "WORKER",
        reason: `QA ${score}/100`,
        data: {
          qaScore: score,
          qaPassed: true,
          qaReport: toJson(report) as Prisma.InputJsonValue,
          failureReason: null,
        },
      });
    } else {
      await transitionContent(tx, {
        projectId: project.id,
        from: "QA",
        to: "REJECTED",
        actor: "SYSTEM",
        reason: `QA auto-reject ${score}/100`,
        data: {
          qaScore: score,
          qaPassed: false,
          qaReport: toJson(report) as Prisma.InputJsonValue,
          failureReason: blockerSummary.join("; ").slice(0, 1000) || `QA score ${score} below ${threshold}`,
        },
      });
      for (const p of perVariant)
        await transitionVariant(tx, { variantId: p.variant.id, from: "PENDING", to: "REJECTED" });
      await tx.approval.create({
        data: {
          projectId: project.id,
          decision: "AUTO_REJECTED",
          reasons,
          note: blockerSummary.join("\n").slice(0, 2000) || null,
          revision: project.revision,
        },
      });
    }
    if (exec.job.runId) {
      await tx.pipelineRun.updateMany({
        where: { id: exec.job.runId, status: "RUNNING" },
        data: {
          status: passed ? "SUCCEEDED" : "FAILED",
          finishedAt: now,
          error: passed ? null : `QA auto-reject (${score}/100)`,
        },
      });
    }
  });
  exec.log.info(
    { score, passed, issues: issues.length },
    passed ? "QA passed — waiting for approval" : "QA auto-rejected",
  );

  // 5. one automatic, budget-guarded fix attempt for text problems -----------------------------------------
  let autoRegeneration: string | null = null;
  const scope = passed ? null : autoFixScope(issues);
  if (scope && project.approvals.length < QA_AUTO_RETRIES) {
    try {
      await requestRegeneration(ctx.prisma, {
        projectId: project.id,
        userId: null,
        scope,
        actor: "SYSTEM",
        now: ctx.clock.now(),
        note: `Automatic QA fix. Address these findings:\n${blockerSummary.join("\n")}`,
      });
      autoRegeneration = scope;
    } catch (err) {
      if (!(err instanceof BudgetBlockedError)) throw err;
      exec.log.warn({ err: errorMessage(err) }, "automatic QA fix skipped (regeneration limit)");
    }
  }
  return { score, passed, issues: issues.length, autoRegeneration };
}
