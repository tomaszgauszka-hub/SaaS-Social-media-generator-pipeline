import { CONTENT_PAID_STATES, enqueueJob, requeueJob, transitionContent } from "@cre/core";
import { Prisma, type ContentStatus } from "@cre/db";
import { addDays, idempotencyKey, zonedParts, type BudgetBlockReason } from "@cre/shared";
import type { PipelineContext } from "../context.ts";
import type { JobExecution } from "../job-types.ts";
import { enqueueProfile } from "./analytics.ts";
import { concludeExperiments } from "./experiments.ts";

/** Projects still moving through the pipeline (count against a brand's ideation cycle). */
const IN_FLIGHT: ContentStatus[] = [
  "IDEA",
  "RESEARCHING",
  "SCRIPTING",
  "ASSET_PLANNING",
  "GENERATING_ASSETS",
  "RENDERING",
  "QA",
  "WAITING_APPROVAL",
];

/**
 * Resume BUDGET_BLOCKED work when the budget has headroom again (e.g. a new day): the blocked jobs are re-queued
 * exactly as they were (same payload), the project returns to the state it was blocked in.
 */
export async function resumeBudgetBlocked(ctx: PipelineContext, limit = 20): Promise<string[]> {
  const resumed: string[] = [];
  const projects = await ctx.prisma.contentProject.findMany({
    where: { status: "BUDGET_BLOCKED" },
    orderBy: { statusChangedAt: "asc" },
    take: limit,
  });
  for (const p of projects) {
    const reasons = (p.blockedReasons ?? []) as unknown as BudgetBlockReason[];
    const requested = Math.max(
      10_000,
      ...reasons.map((r) => (r.limit === "regenerations" ? 0 : r.requestedValue)),
    );
    const check = await ctx.guard.check({
      workspaceId: p.workspaceId,
      brandId: p.brandId,
      projectId: p.id,
      estimatedMicros: requested,
      isMock: false,
    });
    if (!check.allowed) continue;
    const target =
      p.resumeStatus &&
      (CONTENT_PAID_STATES as readonly ContentStatus[]).includes(p.resumeStatus) &&
      p.resumeStatus !== "IDEA"
        ? p.resumeStatus
        : null;
    if (!target) continue;
    await ctx.prisma.$transaction(async (tx) => {
      const jobs = await tx.generationJob.findMany({
        where: { projectId: p.id, status: "BUDGET_BLOCKED" },
        select: { id: true },
      });
      await transitionContent(tx, {
        projectId: p.id,
        from: "BUDGET_BLOCKED",
        to: target,
        actor: "SYSTEM",
        reason: "budget available again",
        data: { resumeStatus: null, blockedReasons: Prisma.DbNull },
      });
      for (const j of jobs) await requeueJob(tx, j.id, "budget available again", null, ctx.clock.now());
    });
    resumed.push(p.id);
  }
  // blocked jobs without a project (ideation)
  const orphanJobs = await ctx.prisma.generationJob.findMany({
    where: { status: "BUDGET_BLOCKED", projectId: null },
    take: limit,
  });
  for (const j of orphanJobs) {
    if (!j.workspaceId) continue;
    const check = await ctx.guard.check({
      workspaceId: j.workspaceId,
      brandId: j.brandId,
      projectId: null,
      estimatedMicros: 10_000,
      isMock: false,
    });
    if (check.allowed) await requeueJob(ctx.prisma, j.id, "budget available again", null, ctx.clock.now());
  }
  return resumed;
}

/** Brands with automatic ideation get new ideas once per local day while their pipeline is not full. */
export async function scheduleAutoIdeation(ctx: PipelineContext, now: Date): Promise<number> {
  const brands = await ctx.prisma.brand.findMany({ where: { status: "ACTIVE", autoIdeationEnabled: true } });
  let queued = 0;
  for (const b of brands) {
    const inFlight = await ctx.prisma.contentProject.count({
      where: { brandId: b.id, status: { in: IN_FLIGHT } },
    });
    if (inFlight >= b.ideasPerCycle) continue;
    const local = zonedParts(now, b.timezone);
    const day = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
    const res = await enqueueJob(ctx.prisma, {
      type: "strategy.ideate",
      payload: { brandId: b.id, count: b.ideasPerCycle - inFlight, trigger: "auto" },
      idempotencyKey: idempotencyKey("auto-ideate", { brandId: b.id, day }),
      workspaceId: b.workspaceId,
      brandId: b.id,
      runAt: now,
    });
    if (res.created) queued++;
  }
  return queued;
}

/** ANALYTICS_PENDING content whose analytics windows are over is archived (data is kept). */
export async function archiveFinished(ctx: PipelineContext, now: Date): Promise<number> {
  const candidates = await ctx.prisma.contentProject.findMany({
    where: { status: "ANALYTICS_PENDING" },
    select: {
      id: true,
      variants: { select: { publications: { select: { status: true, analyticsUntil: true } } } },
    },
    take: 100,
  });
  let archived = 0;
  for (const p of candidates) {
    const pubs = p.variants.flatMap((v) => v.publications).filter((x) => x.status === "PUBLISHED");
    if (
      pubs.length === 0 ||
      pubs.some((x) => !x.analyticsUntil || x.analyticsUntil.getTime() > now.getTime())
    )
      continue;
    await transitionContent(ctx.prisma, {
      projectId: p.id,
      from: "ANALYTICS_PENDING",
      to: "ARCHIVED",
      actor: "SYSTEM",
      reason: "analytics window closed",
      data: { archivedAt: now },
    });
    archived++;
  }
  return archived;
}

/**
 * Reservations left RESERVED by a crashed worker (no job runs longer than ~1 h): real ones are committed at their
 * estimate (we cannot know whether the provider charged — overstating spend is the safe direction for a budget);
 * mock ones are released. One policy, owned by the BudgetGuard.
 */
export async function settleStaleReservations(ctx: PipelineContext): Promise<number> {
  const { committed, released } = await ctx.guard.reconcileStale(STALE_RESERVATION_MS);
  return committed + released;
}

const STALE_RESERVATION_MS = 2 * 3_600_000;

/** maintenance.tick — periodic housekeeping (every minute from the worker). */
export async function maintenanceTickHandler(exec: JobExecution) {
  const { ctx } = exec;
  const now = ctx.clock.now();
  const resumed = await resumeBudgetBlocked(ctx);
  const ideation = await scheduleAutoIdeation(ctx, now);
  const archived = await archiveFinished(ctx, now);
  const staleReservations = await settleStaleReservations(ctx);
  const experiments = await concludeExperiments(ctx, now);
  // daily learning-profile refresh for brands that published in the last two weeks
  const active = await ctx.prisma.publication.findMany({
    where: { status: "PUBLISHED", publishedAt: { gte: addDays(now, -14) } },
    distinct: ["brandId"],
    select: { brandId: true, workspaceId: true },
  });
  if (now.getUTCHours() === 3)
    for (const a of active) await enqueueProfile(ctx, a.workspaceId, a.brandId, now);
  return { resumed: resumed.length, ideation, archived, staleReservations, experiments };
}
