import {
  estimatePromptCost,
  runPrompt,
  StructuredOutputError,
  sumUsage,
  type PromptRun,
  type RegisteredPrompt,
} from "@cre/ai";
import type { UsageOperation } from "@cre/db";
import type { CostEstimate, ExecContext } from "@cre/providers";
import { idempotencyKey } from "@cre/shared";
import type { JobExecution } from "./job-types.ts";
import { ensurePromptVersion } from "./prompts-sync.ts";

export interface CostScope {
  workspaceId: string;
  brandId: string | null;
  projectId: string | null;
  assetId?: string | null;
  /** stable identifier of the logical operation (combined with the attempt for the usage key) */
  opKey: string;
}

/**
 * Run a versioned prompt as a paid operation: estimate → BudgetGuard reservation → call → commit actual tokens.
 * Throws BudgetBlockedError before calling the LLM when a budget would be exceeded.
 */
export async function runPaidPrompt<Ctx, Out>(
  exec: JobExecution,
  prompt: RegisteredPrompt<Ctx, Out>,
  promptCtx: Ctx,
  scope: CostScope,
): Promise<PromptRun<Out> & { promptVersionId: string }> {
  const { ctx } = exec;
  const promptVersionId = await ensurePromptVersion(ctx.prisma, prompt as RegisteredPrompt<unknown, unknown>);
  const estimate = estimatePromptCost(ctx.llm, prompt, promptCtx, 1);
  const run = await ctx.ledger.run(
    {
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      projectId: scope.projectId,
      jobId: exec.job.id,
      runId: exec.job.runId,
      provider: ctx.llm.name,
      model: estimate.model,
      operation: "LLM_COMPLETION",
      estimatedMicros: estimate.estimatedMicros,
      isMock: ctx.llm.isMock,
      idempotencyKey: idempotencyKey("usage", {
        op: scope.opKey,
        prompt: prompt.id,
        job: exec.job.id,
        attempt: exec.attempt,
      }),
      promptVersionId,
      metadata: { promptKey: prompt.key },
    },
    () => runPrompt(ctx.llm, prompt, promptCtx, { signal: exec.signal }),
    (r) => {
      const usage = sumUsage(r.calls);
      const model = r.calls.at(-1)?.model ?? estimate.model;
      return {
        ...usage,
        estimatedMicros: ctx.llm.costForUsage(model, usage),
        model,
        metadata: { promptKey: prompt.key, attempts: r.attempts },
      };
    },
    (err) => {
      if (!(err instanceof StructuredOutputError)) return null;
      const usage = sumUsage(err.calls);
      const model = err.calls.at(-1)?.model ?? estimate.model;
      return { ...usage, estimatedMicros: ctx.llm.costForUsage(model, usage), model };
    },
  );
  exec.log.debug({ prompt: prompt.id, attempts: run.attempts }, "prompt completed");
  return { ...run, promptVersionId };
}

/**
 * Run a media provider call as a paid operation. `execute` receives the ExecContext with resumable
 * external job ids for async providers.
 */
export async function runPaidMedia<T extends { actualCostMicros?: number; model: string }>(
  exec: JobExecution,
  estimate: CostEstimate,
  scope: CostScope & { operation: UsageOperation },
  execute: () => Promise<T>,
): Promise<T> {
  return exec.ctx.ledger.run(
    {
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      projectId: scope.projectId,
      assetId: scope.assetId ?? null,
      jobId: exec.job.id,
      runId: exec.job.runId,
      provider: estimate.provider,
      model: estimate.model,
      operation: scope.operation,
      estimatedMicros: estimate.estimatedMicros,
      isMock: estimate.isMock,
      isAiVideo: estimate.isAiVideo ?? false,
      units: {
        imageCount: estimate.units.images ?? 0,
        videoSeconds: estimate.units.videoSeconds ?? 0,
        audioSeconds: estimate.units.audioSeconds ?? 0,
        characters: estimate.units.characters ?? 0,
      },
      idempotencyKey: idempotencyKey("usage", { op: scope.opKey, job: exec.job.id, attempt: exec.attempt }),
    },
    execute,
    (r) => ({ model: r.model, actualMicros: r.actualCostMicros ?? null }),
  );
}

export function execContext(exec: JobExecution, extra: Partial<ExecContext> = {}): ExecContext {
  return { signal: exec.signal, workDir: exec.workDir, logger: exec.log, ...extra };
}
