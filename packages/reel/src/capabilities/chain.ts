import type { BudgetGate } from "../cost/tracker.ts";
import type { FallbackRecord } from "../contracts/manifest.ts";
import type { Capability } from "../contracts/ids.ts";
import type { ProviderBase } from "./types.ts";

export class ChainExhaustedError extends Error {
  constructor(
    readonly capability: Capability,
    readonly attempts: { provider: string; reason: string }[],
  ) {
    super(
      `${capability}: no provider succeeded (${attempts.map((a) => `${a.provider}: ${a.reason}`).join("; ") || "chain empty"})`,
    );
    this.name = "ChainExhaustedError";
  }
}

export interface ChainOutcome<P, R> {
  result: R;
  provider: P;
  /** providers skipped or failed before the one that succeeded */
  skipped: { provider: string; reason: string }[];
  fallback?: FallbackRecord;
}

/**
 * Runs a capability through its ordered provider chain:
 *   unavailable (no key / binary / disabled) → skip · estimate over budget → skip · error → next provider.
 * The first success wins. Local providers estimate 0 and always pass the budget gate, so a chain that ends in a
 * local provider never fails for budget reasons.
 */
export async function runChain<P extends ProviderBase, R>(opts: {
  capability: Capability;
  providers: readonly P[];
  budget: BudgetGate;
  estimate: (p: P) => number;
  run: (p: P) => Promise<R>;
  signal?: AbortSignal;
}): Promise<ChainOutcome<P, R>> {
  const skipped: { provider: string; reason: string }[] = [];
  for (const p of opts.providers) {
    opts.signal?.throwIfAborted();
    const avail = await p.available().catch((e: unknown) => ({ ok: false, reason: errMsg(e) }));
    if (!avail.ok) {
      skipped.push({ provider: p.name, reason: avail.reason ?? "unavailable" });
      continue;
    }
    const est = p.local ? 0 : Math.max(0, Math.round(opts.estimate(p)));
    if (!opts.budget.canSpend(est)) {
      skipped.push({
        provider: p.name,
        reason: `estimate ${(est / 1e6).toFixed(4)} USD exceeds remaining budget ${(opts.budget.remainingMicros() / 1e6).toFixed(4)} USD`,
      });
      continue;
    }
    const release = opts.budget.reserve(est);
    try {
      const result = await opts.run(p);
      release();
      const head = opts.providers[0];
      return {
        result,
        provider: p,
        skipped,
        ...(head && head.name !== p.name
          ? {
              fallback: {
                capability: opts.capability,
                wanted: head.name,
                used: p.name,
                reason: skipped
                  .map((s) => `${s.provider}: ${s.reason}`)
                  .join("; ")
                  .slice(0, 400),
              },
            }
          : {}),
      };
    } catch (e) {
      release();
      if (opts.signal?.aborted) throw e;
      skipped.push({ provider: p.name, reason: errMsg(e).slice(0, 300) });
    }
  }
  throw new ChainExhaustedError(opts.capability, skipped);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
