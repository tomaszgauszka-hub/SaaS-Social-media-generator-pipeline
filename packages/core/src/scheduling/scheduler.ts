import { ANALYTICS_DEFAULTS, SCHEDULER_DEFAULTS } from "@cre/config";
import type { DbClient, Publication } from "@cre/db";
import { addMinutes, idempotencyKey, NotFoundError } from "@cre/shared";
import { enqueueJob } from "../jobs/outbox.ts";
import { transitionVariant } from "../lifecycle/transitions.ts";
import { nextSlot } from "./slots.ts";

export type ScheduleMode = "slots" | "asap";

/**
 * Schedule every APPROVED variant of a project: pick the brand's social account for the platform, find the next
 * free slot and create a SCHEDULED Publication (the maintenance tick publishes it when due).
 * One publication per (variant, account) — re-publishing requires an explicit new sequence.
 */
export async function scheduleApprovedVariants(
  db: DbClient,
  projectId: string,
  opts: { now: Date; mode?: ScheduleMode } = { now: new Date() },
): Promise<Publication[]> {
  const project = await db.contentProject.findUnique({
    where: { id: projectId },
    include: {
      brand: { include: { socialAccounts: true, publishingSlots: { where: { isActive: true } } } },
      variants: { where: { status: "APPROVED" } },
    },
  });
  if (!project) throw new NotFoundError("ContentProject", projectId);
  const created: Publication[] = [];
  for (const variant of project.variants) {
    const account =
      project.brand.socialAccounts.find(
        (a) => a.platform === variant.platform && a.status !== "DISCONNECTED",
      ) ?? null;
    if (!account) continue; // no account for this platform: variant stays APPROVED (visible on dashboard)
    const existing = await db.publication.findFirst({
      where: { variantId: variant.id, socialAccountId: account.id, status: { not: "CANCELLED" } },
    });
    if (existing) continue;

    let scheduledAt: Date;
    if (opts.mode === "asap") {
      scheduledAt = addMinutes(opts.now, 1);
    } else {
      const taken = await db.publication.findMany({
        where: { socialAccountId: account.id, status: { in: ["SCHEDULED", "PUBLISHING"] } },
        select: { scheduledAt: true },
      });
      scheduledAt =
        nextSlot(
          project.brand.publishingSlots.map((s) => ({
            platform: s.platform,
            dayOfWeek: s.dayOfWeek,
            timeOfDay: s.timeOfDay,
          })),
          {
            platform: variant.platform,
            timeZone: project.brand.timezone,
            from: opts.now,
            minLeadMinutes: SCHEDULER_DEFAULTS.minLeadMinutes,
            horizonDays: SCHEDULER_DEFAULTS.horizonDays,
            taken: taken.map((t) => t.scheduledAt),
          },
        ) ?? addMinutes(opts.now, 60); // no slot configured → one hour from now
    }

    const publication = await db.publication.create({
      data: {
        workspaceId: project.workspaceId,
        brandId: project.brandId,
        variantId: variant.id,
        socialAccountId: account.id,
        platform: variant.platform,
        status: "SCHEDULED",
        scheduledAt,
        isMock: account.isMock,
        analyticsUntil: new Date(scheduledAt.getTime() + ANALYTICS_DEFAULTS.windowDays * 86_400_000),
      },
    });
    await transitionVariant(db, { variantId: variant.id, from: "APPROVED", to: "SCHEDULED" });
    await enqueueJob(db, {
      type: "publish.publication",
      payload: { publicationId: publication.id },
      idempotencyKey: idempotencyKey("publish", { publicationId: publication.id, attempt: 1 }),
      workspaceId: project.workspaceId,
      brandId: project.brandId,
      projectId: project.id,
      variantId: variant.id,
      publicationId: publication.id,
      runAt: scheduledAt,
    });
    created.push(publication);
  }
  return created;
}
