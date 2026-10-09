import { JOB_DEFAULTS } from "@cre/config";
import type { DbClient, JobEventType, Prisma } from "@cre/db";
import { toJson } from "@cre/shared";

/**
 * Transactional outbox. A job is a GenerationJob row written in the SAME transaction as the state change that
 * requires it. The worker's dispatcher later pushes due rows to BullMQ (jobId = row id). Consequences:
 *   - no lost work if Redis restarts; no orphan jobs if the transaction rolls back
 *   - idempotencyKey makes enqueueing safe to repeat (ON CONFLICT DO NOTHING)
 *   - the web app never needs Redis
 */
export type JobType =
  | "strategy.ideate"
  | "pipeline.research"
  | "pipeline.script"
  | "pipeline.plan_assets"
  | "pipeline.assets"
  | "asset.image"
  | "asset.product_image"
  | "asset.video"
  | "asset.tts"
  | "asset.music"
  | "pipeline.render"
  | "pipeline.qa"
  | "reel.produce"
  | "publish.publication"
  | "analytics.collect"
  | "analytics.profile"
  | "maintenance.tick";

const DEFAULT_FOR_UNLISTED = { queue: "research", timeoutMs: 120_000, maxAttempts: 3 };

export function jobDefaults(type: JobType): { queue: string; timeoutMs: number; maxAttempts: number } {
  if (type === "pipeline.assets") return JOB_DEFAULTS["pipeline.plan_assets"] ?? DEFAULT_FOR_UNLISTED;
  return JOB_DEFAULTS[type] ?? DEFAULT_FOR_UNLISTED;
}

export interface EnqueueJobInput {
  type: JobType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  workspaceId?: string | null;
  brandId?: string | null;
  projectId?: string | null;
  variantId?: string | null;
  assetId?: string | null;
  publicationId?: string | null;
  runId?: string | null;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  timeoutMs?: number;
}

export async function enqueueJob(
  db: DbClient,
  input: EnqueueJobInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await db.generationJob.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  const d = jobDefaults(input.type);
  await db.generationJob.createMany({
    data: [
      {
        type: input.type,
        queue: d.queue,
        payload: toJson(input.payload) as Prisma.InputJsonValue,
        idempotencyKey: input.idempotencyKey,
        workspaceId: input.workspaceId ?? null,
        brandId: input.brandId ?? null,
        projectId: input.projectId ?? null,
        variantId: input.variantId ?? null,
        assetId: input.assetId ?? null,
        publicationId: input.publicationId ?? null,
        runId: input.runId ?? null,
        runAt: input.runAt ?? new Date(),
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? d.maxAttempts,
        timeoutMs: input.timeoutMs ?? d.timeoutMs,
      },
    ],
    skipDuplicates: true,
  });
  const job = await db.generationJob.findUniqueOrThrow({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  return { id: job.id, created: true };
}

export async function recordJobEvent(
  db: DbClient,
  e: {
    jobId: string;
    runId?: string | null;
    type: JobEventType;
    message: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await db.jobEvent.create({
    data: {
      jobId: e.jobId,
      runId: e.runId ?? null,
      type: e.type,
      message: e.message.slice(0, 2000),
      ...(e.data ? { data: toJson(e.data) as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Manual retry from the dashboard: failed / dead-lettered / budget-blocked jobs go back to the queue. */
export async function requeueJob(
  db: DbClient,
  jobId: string,
  reason: string,
  userId?: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const res = await db.generationJob.updateMany({
    where: { id: jobId, status: { in: ["FAILED", "DEAD_LETTER", "BUDGET_BLOCKED", "CANCELLED"] } },
    data: {
      status: "QUEUED",
      attempts: 0,
      dispatchedAt: null,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      errorClass: null,
      runAt: now,
      dispatchCount: { increment: 1 },
    },
  });
  if (res.count === 0) return false;
  await recordJobEvent(db, {
    jobId,
    type: "RETRY",
    message: `Manual retry: ${reason}`,
    data: { userId: userId ?? null },
  });
  return true;
}
