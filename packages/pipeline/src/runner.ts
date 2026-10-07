import fs from "node:fs";
import path from "node:path";
import {
  CONTENT_PAID_STATES,
  CONTENT_WORKING_STATES,
  recordJobEvent,
  transitionContent,
  type JobType,
} from "@cre/core";
import { decimalFieldToMicros, type ContentStatus, type GenerationJob, type Prisma } from "@cre/db";
import {
  backoffDelay,
  BudgetBlockedError,
  classifyError,
  errorMessage,
  FatalError,
  LogEvent,
  pipelineLogger,
  StateConflictError,
  toJson,
  withTimeout,
} from "@cre/shared";
import type { PipelineContext } from "./context.ts";
import { HANDLERS, type HandlerMap } from "./handlers.ts";

/** Job types whose permanent failure stops the content project (FAILED, resumable from the dashboard). */
const PROJECT_STEP_TYPES = new Set<string>([
  "pipeline.research",
  "pipeline.script",
  "pipeline.plan_assets",
  "pipeline.assets",
  "asset.image",
  "asset.product_image",
  "asset.video",
  "asset.tts",
  "asset.music",
  "pipeline.render",
  "pipeline.qa",
]);

export type RunOutcome =
  | { status: "skipped" }
  | { status: "succeeded"; result: Record<string, unknown> }
  | { status: "retrying"; error: string; runAt: Date }
  | { status: "failed" | "dead_letter" | "budget_blocked"; error: string };

export interface RunJobOptions {
  handlers?: HandlerMap;
  /** process shutdown signal: running jobs are aborted and retried later */
  signal?: AbortSignal;
  onDeadLetter?: (job: GenerationJob, error: string) => Promise<void> | void;
  /** keep per-job scratch directories (debugging) */
  keepWorkDir?: boolean;
}

/**
 * Execute one GenerationJob row: claim (optimistic, so duplicate deliveries are no-ops) → handler with timeout →
 * SUCCEEDED | RETRYING (exponential backoff) | FAILED | DEAD_LETTER | BUDGET_BLOCKED. Every transition is
 * written to the job timeline (JobEvent) and logged with runId / brandId / contentId / jobId.
 */
export async function runJob(
  ctx: PipelineContext,
  jobId: string,
  opts: RunJobOptions = {},
): Promise<RunOutcome> {
  const claimedAt = ctx.clock.now();
  const claim = await ctx.prisma.generationJob.updateMany({
    where: { id: jobId, status: { in: ["QUEUED", "DISPATCHED", "RETRYING"] } },
    data: { status: "RUNNING", attempts: { increment: 1 }, startedAt: claimedAt, finishedAt: null },
  });
  if (claim.count === 0) return { status: "skipped" };
  const job = await ctx.prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
  const log = pipelineLogger(ctx.logger, {
    runId: job.runId,
    brandId: job.brandId,
    contentId: job.projectId,
    jobId: job.id,
    queue: job.queue,
    jobType: job.type,
  });
  const handlers = opts.handlers ?? HANDLERS;
  const handler = handlers[job.type as JobType];
  const workDir = path.join(ctx.workRoot, "jobs", `${job.id}-${job.attempts}`);
  const started = Date.now();
  log.info(
    { event: LogEvent.START, attempt: job.attempts, maxAttempts: job.maxAttempts },
    `${job.type} started`,
  );
  await recordJobEvent(ctx.prisma, {
    jobId: job.id,
    runId: job.runId,
    type: "START",
    message: `attempt ${job.attempts}/${job.maxAttempts}`,
  });

  try {
    if (!handler) throw new FatalError(`No handler registered for job type "${job.type}"`);
    await fs.promises.mkdir(workDir, { recursive: true });
    const result =
      (await withTimeout(
        job.timeoutMs,
        (signal) =>
          handler({
            job,
            payload: (job.payload ?? {}) as Record<string, unknown>,
            ctx,
            log,
            signal,
            workDir,
            attempt: job.attempts,
          }),
        { label: job.type, ...(opts.signal ? { parent: opts.signal } : {}) },
      )) ?? {};
    const durationMs = Date.now() - started;
    await ctx.prisma.generationJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        result: toJson(result) as Prisma.InputJsonValue,
        finishedAt: ctx.clock.now(),
        lastError: null,
        errorClass: null,
      },
    });
    await recordJobEvent(ctx.prisma, {
      jobId: job.id,
      runId: job.runId,
      type: "SUCCESS",
      message: `done in ${durationMs} ms`,
      data: { durationMs },
    });
    await recordCostEvent(ctx, job, log);
    log.info({ event: LogEvent.SUCCESS, durationMs }, `${job.type} succeeded`);
    return { status: "succeeded", result };
  } catch (err) {
    return await handleFailure(ctx, job, err, log, Date.now() - started, opts);
  } finally {
    if (!opts.keepWorkDir)
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function recordCostEvent(
  ctx: PipelineContext,
  job: GenerationJob,
  log: ReturnType<typeof pipelineLogger>,
): Promise<void> {
  const usage = await ctx.prisma.generationUsage.findMany({
    where: { jobId: job.id, status: "COMMITTED" },
    select: { estimatedCostUsd: true, actualCostUsd: true, provider: true, model: true, isMock: true },
  });
  if (usage.length === 0) return;
  const micros = usage.reduce((s, u) => s + decimalFieldToMicros(u.actualCostUsd ?? u.estimatedCostUsd), 0);
  const mock = usage.every((u) => u.isMock);
  await recordJobEvent(ctx.prisma, {
    jobId: job.id,
    runId: job.runId,
    type: "COST",
    message: `${usage.length} paid call(s): $${(micros / 1_000_000).toFixed(4)}${mock ? " (simulated)" : ""}`,
    data: {
      micros,
      calls: usage.length,
      providers: [...new Set(usage.map((u) => `${u.provider}/${u.model}`))],
      mock,
    },
  });
  log.info({ event: LogEvent.COST, costMicros: micros, calls: usage.length, mock }, "job cost");
}

async function handleFailure(
  ctx: PipelineContext,
  job: GenerationJob,
  err: unknown,
  log: ReturnType<typeof pipelineLogger>,
  durationMs: number,
  opts: RunJobOptions,
): Promise<RunOutcome> {
  const cls = classifyError(err);
  const message = errorMessage(err).slice(0, 2000);
  const now = ctx.clock.now();

  if (err instanceof BudgetBlockedError) {
    await ctx.prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "BUDGET_BLOCKED", lastError: message, errorClass: cls, finishedAt: now },
    });
    await recordJobEvent(ctx.prisma, {
      jobId: job.id,
      runId: job.runId,
      type: "BUDGET_BLOCKED",
      message,
      data: { reasons: err.reasons },
    });
    if (job.projectId) await blockProject(ctx, job.projectId, err);
    if (job.runId)
      await ctx.prisma.pipelineRun.updateMany({
        where: { id: job.runId, status: "RUNNING" },
        data: { status: "BUDGET_BLOCKED", error: message },
      });
    log.warn(
      { event: LogEvent.BUDGET_BLOCKED, reasons: err.reasons },
      `${job.type} blocked by budget — not executed`,
    );
    return { status: "budget_blocked", error: message };
  }

  const aborted = opts.signal?.aborted ?? false;
  if ((cls === "retryable" && job.attempts < job.maxAttempts) || aborted) {
    const delay = aborted ? 5_000 : Math.max(1_000, backoffDelay(job.attempts, 2_000, 120_000));
    const runAt = new Date(now.getTime() + delay);
    await ctx.prisma.generationJob.update({
      where: { id: job.id },
      data: {
        status: "RETRYING",
        runAt,
        lastError: message,
        errorClass: cls,
        // a shutdown is not the job's fault: give the attempt back
        ...(aborted ? { attempts: { decrement: 1 } } : {}),
      },
    });
    await recordJobEvent(ctx.prisma, {
      jobId: job.id,
      runId: job.runId,
      type: "RETRY",
      message,
      data: { delayMs: delay, attempt: job.attempts, durationMs },
    });
    log.warn(
      { event: LogEvent.RETRY, err: message, delayMs: delay, attempt: job.attempts },
      `${job.type} failed — retrying`,
    );
    return { status: "retrying", error: message, runAt };
  }

  const final = cls === "retryable" ? "DEAD_LETTER" : "FAILED";
  await ctx.prisma.generationJob.update({
    where: { id: job.id },
    data: { status: final, lastError: message, errorClass: cls, finishedAt: now },
  });
  await recordJobEvent(ctx.prisma, {
    jobId: job.id,
    runId: job.runId,
    type: "FAILURE",
    message,
    data: {
      final,
      attempt: job.attempts,
      durationMs,
      ...(err instanceof Error && err.stack ? { stack: err.stack.split("\n").slice(0, 6).join("\n") } : {}),
    },
  });
  log.error(
    { event: LogEvent.FAILURE, err: message, final, attempt: job.attempts },
    `${job.type} failed permanently`,
  );
  // A state conflict means another actor moved the project on — not a pipeline failure.
  if (job.projectId && PROJECT_STEP_TYPES.has(job.type) && !(err instanceof StateConflictError)) {
    await failProject(ctx, job.projectId, `${job.type}: ${message}`);
    if (job.runId)
      await ctx.prisma.pipelineRun.updateMany({
        where: { id: job.runId, status: "RUNNING" },
        data: { status: "FAILED", error: message, finishedAt: now },
      });
  }
  if (final === "DEAD_LETTER") await opts.onDeadLetter?.(job, message);
  return { status: final === "DEAD_LETTER" ? "dead_letter" : "failed", error: message };
}

async function blockProject(ctx: PipelineContext, projectId: string, err: BudgetBlockedError): Promise<void> {
  const project = await ctx.prisma.contentProject.findUnique({
    where: { id: projectId },
    select: { status: true },
  });
  if (!project || !(CONTENT_PAID_STATES as readonly ContentStatus[]).includes(project.status)) return;
  try {
    await transitionContent(ctx.prisma, {
      projectId,
      from: project.status,
      to: "BUDGET_BLOCKED",
      actor: "SYSTEM",
      reason: err.message,
      data: { resumeStatus: project.status, blockedReasons: toJson(err.reasons) as Prisma.InputJsonValue },
    });
  } catch (e) {
    if (!(e instanceof StateConflictError)) throw e;
  }
}

async function failProject(ctx: PipelineContext, projectId: string, reason: string): Promise<void> {
  const project = await ctx.prisma.contentProject.findUnique({
    where: { id: projectId },
    select: { status: true },
  });
  if (!project || !(CONTENT_WORKING_STATES as readonly ContentStatus[]).includes(project.status)) return;
  try {
    await transitionContent(ctx.prisma, {
      projectId,
      from: project.status,
      to: "FAILED",
      actor: "SYSTEM",
      reason,
      data: { resumeStatus: project.status, failureReason: reason.slice(0, 1000) },
    });
  } catch (e) {
    if (!(e instanceof StateConflictError)) throw e;
  }
}
