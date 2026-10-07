import { mapWithConcurrency } from "@cre/shared";
import { ManualClock, type PipelineContext } from "../context.ts";
import { runJob, type RunJobOptions, type RunOutcome } from "../runner.ts";

export interface InlineDispatcherOptions extends RunJobOptions {
  concurrency?: number;
  onJob?: (job: { id: string; type: string }, outcome: RunOutcome) => void;
}

/**
 * In-process dispatcher for tests, the CLI demo and single-process development: runs due GenerationJob rows
 * directly (no Redis). Same runner, same idempotency and retry semantics as the BullMQ worker.
 */
export class InlineDispatcher {
  constructor(
    private readonly ctx: PipelineContext,
    private readonly opts: InlineDispatcherOptions = {},
  ) {}

  private async due(limit: number) {
    return this.ctx.prisma.generationJob.findMany({
      where: { status: { in: ["QUEUED", "RETRYING"] }, runAt: { lte: this.ctx.clock.now() } },
      orderBy: [{ priority: "desc" }, { runAt: "asc" }, { createdAt: "asc" }],
      take: limit,
      select: { id: true, type: true },
    });
  }

  /** Run one batch of due jobs; returns how many ran. */
  async runDue(limit = 25): Promise<number> {
    const jobs = await this.due(limit);
    await mapWithConcurrency(jobs, this.opts.concurrency ?? 1, async (j) => {
      const outcome = await runJob(this.ctx, j.id, this.opts);
      this.opts.onJob?.(j, outcome);
    });
    return jobs.length;
  }

  /** Earliest runAt of waiting jobs (scheduled publications, analytics snapshots, retries). */
  async nextRunAt(): Promise<Date | null> {
    const next = await this.ctx.prisma.generationJob.findFirst({
      where: { status: { in: ["QUEUED", "RETRYING"] } },
      orderBy: { runAt: "asc" },
      select: { runAt: true },
    });
    return next?.runAt ?? null;
  }

  /**
   * Run until nothing is due. With a ManualClock, short waits (retry backoff) up to `advanceUpToMs` are skipped
   * by moving the clock forward; longer waits (scheduled posts) are left for `runUntil`.
   */
  async runUntilIdle(opts: { maxJobs?: number; advanceUpToMs?: number } = {}): Promise<number> {
    const maxJobs = opts.maxJobs ?? 1000;
    let total = 0;
    for (;;) {
      const ran = await this.runDue();
      total += ran;
      if (total >= maxJobs) throw new Error(`InlineDispatcher: more than ${maxJobs} jobs — possible loop`);
      if (ran > 0) continue;
      const clock = this.ctx.clock;
      const next = await this.nextRunAt();
      if (!next || !(clock instanceof ManualClock) || !opts.advanceUpToMs) return total;
      const wait = next.getTime() - clock.now().getTime();
      if (wait > opts.advanceUpToMs) return total;
      clock.set(next);
    }
  }

  /** Fast-forward a ManualClock to `until`, running every job that becomes due on the way. */
  async runUntil(until: Date, opts: { maxJobs?: number } = {}): Promise<number> {
    const clock = this.ctx.clock;
    if (!(clock instanceof ManualClock)) throw new Error("runUntil requires a ManualClock");
    let total = await this.runUntilIdle(opts);
    for (;;) {
      const next = await this.nextRunAt();
      if (!next || next.getTime() > until.getTime()) break;
      clock.set(next);
      total += await this.runUntilIdle(opts);
    }
    clock.set(until);
    return total + (await this.runUntilIdle(opts));
  }
}
