import { DEAD_LETTER_QUEUE, QUEUE_NAMES, type QueueName } from "@cre/config";
import { enqueueJob, recordJobEvent } from "@cre/core";
import { errorMessage, idempotencyKey } from "@cre/shared";
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { PipelineContext } from "../context.ts";
import { runJob } from "../runner.ts";

/** ioredis options from a redis:// or rediss:// URL (BullMQ workers need maxRetriesPerRequest = null). */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  const db = u.pathname.replace(/^\//, "");
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(db ? { db: Number(db) } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export interface BullMqDispatcherOptions {
  redisUrl: string;
  /** default worker concurrency per queue */
  concurrency: number;
  renderConcurrency: number;
  pollMs: number;
  /** run workers in this process (false = dispatcher only) */
  workers?: boolean;
  /** only these queues get workers (horizontal scaling: one process per heavy queue) */
  queues?: readonly QueueName[];
}

interface ClaimedRow {
  id: string;
  queue: string;
  type: string;
  dispatchCount: number;
  attempts: number;
}

/**
 * Production dispatcher: the PostgreSQL outbox is the source of truth, BullMQ/Redis is the transport.
 *  - poll: due rows are claimed with FOR UPDATE SKIP LOCKED (safe with many dispatchers) and pushed to their queue
 *  - workers: per-queue concurrency (render is CPU-bound and limited separately)
 *  - retries, timeouts and backoff live in the DB-backed runner, so a Redis loss never loses work
 *  - permanently failed retryable jobs are copied to the dead_letter queue for inspection
 */
export class BullMqDispatcher {
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private deadLetter: Queue | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;
  private lastTickMinute = "";
  private readonly abort = new AbortController();
  private readonly connection: ConnectionOptions;

  constructor(
    private readonly ctx: PipelineContext,
    private readonly opts: BullMqDispatcherOptions,
  ) {
    this.connection = redisConnection(opts.redisUrl);
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async start(): Promise<void> {
    this.deadLetter = new Queue(DEAD_LETTER_QUEUE, { connection: this.connection });
    await this.deadLetter.waitUntilReady(); // fail fast when Redis is unreachable
    for (const name of QUEUE_NAMES) this.queue(name);
    if (this.opts.workers !== false) {
      const names = this.opts.queues ?? QUEUE_NAMES;
      for (const name of names) {
        const concurrency =
          name === "render"
            ? this.opts.renderConcurrency
            : name === "video_generation"
              ? Math.min(2, this.opts.concurrency)
              : this.opts.concurrency;
        const worker = new Worker(name, (job: Job<{ jobId: string }>) => this.process(job), {
          connection: this.connection,
          concurrency,
        });
        worker.on("error", (err) =>
          this.ctx.logger.error({ err: errorMessage(err), queue: name }, "worker error"),
        );
        this.workers.push(worker);
      }
    }
    this.ctx.logger.info(
      { queues: QUEUE_NAMES, workers: this.workers.length, pollMs: this.opts.pollMs },
      "dispatcher started",
    );
    this.schedulePoll(0);
  }

  private async process(job: Job<{ jobId: string }>): Promise<{ status: string }> {
    const outcome = await runJob(this.ctx, job.data.jobId, {
      signal: this.abort.signal,
      onDeadLetter: async (row, error) => {
        await this.deadLetter?.add(
          "dead",
          { jobId: row.id, type: row.type, error },
          { removeOnComplete: false, removeOnFail: false },
        );
      },
    });
    return { status: outcome.status };
  }

  private schedulePoll(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.pollOnce()
        .catch((err: unknown) => this.ctx.logger.error({ err: errorMessage(err) }, "dispatch poll failed"))
        .finally(() => this.schedulePoll(this.opts.pollMs));
    }, delay);
  }

  /** One dispatch cycle (exposed for tests). */
  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      await this.enqueueMaintenanceTick();
      await this.recoverStale();
      const rows = await this.ctx.prisma.$queryRaw<ClaimedRow[]>`
        UPDATE "GenerationJob" SET status = 'DISPATCHED', "dispatchedAt" = (now() AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC')
        WHERE id IN (
          SELECT id FROM "GenerationJob"
          WHERE status IN ('QUEUED', 'RETRYING') AND "runAt" <= (now() AT TIME ZONE 'UTC')
          ORDER BY priority DESC, "runAt" ASC
          LIMIT 100
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, queue, type, "dispatchCount", attempts`;
      for (const row of rows) {
        await this.queue(row.queue).add(
          row.type,
          { jobId: row.id },
          {
            jobId: `${row.id}-${row.dispatchCount}-${row.attempts}`,
            attempts: 1, // retries are decided by the runner (DB), not by BullMQ
            removeOnComplete: { age: 24 * 3600, count: 5000 },
            removeOnFail: { age: 7 * 24 * 3600 },
          },
        );
        await recordJobEvent(this.ctx.prisma, {
          jobId: row.id,
          type: "DISPATCH",
          message: `queued on ${row.queue}`,
        });
      }
      return rows.length;
    } finally {
      this.polling = false;
    }
  }

  /** A maintenance tick per minute (idempotent across dispatcher processes). */
  private async enqueueMaintenanceTick(): Promise<void> {
    const minute = new Date().toISOString().slice(0, 16);
    if (minute === this.lastTickMinute) return;
    this.lastTickMinute = minute;
    await enqueueJob(this.ctx.prisma, {
      type: "maintenance.tick",
      payload: {},
      idempotencyKey: idempotencyKey("tick", { minute }),
    });
  }

  /** Dispatched but never started (Redis lost it) → re-queue; running far past its timeout (worker died) → retry. */
  private async recoverStale(): Promise<void> {
    await this.ctx.prisma.$executeRaw`
      UPDATE "GenerationJob" SET status = 'QUEUED', "dispatchedAt" = NULL, "dispatchCount" = "dispatchCount" + 1
      WHERE status = 'DISPATCHED' AND "dispatchedAt" < (now() AT TIME ZONE 'UTC') - interval '30 minutes'`;
    await this.ctx.prisma.$executeRaw`
      UPDATE "GenerationJob"
      SET status = CASE WHEN attempts < "maxAttempts" THEN 'RETRYING'::"JobStatus" ELSE 'DEAD_LETTER'::"JobStatus" END,
          "runAt" = (now() AT TIME ZONE 'UTC'),
          "lastError" = 'worker lost while running (timeout exceeded twice)',
          "errorClass" = 'retryable'
      WHERE status = 'RUNNING' AND "startedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => ("timeoutMs" * 2) / 1000.0)`;
  }

  /** Graceful shutdown: stop dispatching, let running jobs finish (or abort → retried later), close connections. */
  async stop(opts: { graceMs?: number } = {}): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const closing = Promise.all(this.workers.map((w) => w.close()));
    const grace = new Promise<void>((resolve) =>
      setTimeout(() => {
        this.abort.abort(new Error("worker shutting down"));
        resolve();
      }, opts.graceMs ?? 25_000).unref(),
    );
    await Promise.race([closing, grace]);
    await closing;
    await Promise.all(
      [...this.queues.values(), ...(this.deadLetter ? [this.deadLetter] : [])].map((q) => q.close()),
    );
  }
}
