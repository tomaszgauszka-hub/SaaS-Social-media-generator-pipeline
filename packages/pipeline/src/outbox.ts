import { enqueueJob, type EnqueueJobInput } from "@cre/core";
import type { DbClient } from "@cre/db";
import type { PipelineContext } from "./context.ts";

/** Enqueue with "as soon as possible" measured on the pipeline clock (simulated time in demos and tests). */
export function enqueue(ctx: PipelineContext, db: DbClient, input: EnqueueJobInput) {
  return enqueueJob(db, { ...input, runAt: input.runAt ?? ctx.clock.now() });
}
