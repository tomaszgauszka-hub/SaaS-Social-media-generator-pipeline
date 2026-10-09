import { runChain } from "../../capabilities/chain.ts";
import type { CallContext, SfxProvider } from "../../capabilities/types.ts";
import type { SfxKind } from "../../contracts/ids.ts";
import type { FallbackRecord } from "../../contracts/manifest.ts";
import type { SfxCueFile } from "../../contracts/media.ts";
import type { ReelPlan } from "../../contracts/plan.ts";
import { BudgetGate, CostTracker } from "../../cost/tracker.ts";
import { decodeAudio, REEL_SR } from "../pcm.ts";
import { SFX_LENGTH_MS } from "./synth.ts";

/**
 * plan.sfx → timed SFX files. Each cue runs the SFX chain (typically cache → local synthesis → API, as the
 * orchestrator orders it); providers that cannot make a kind are skipped with a reason. Sounds that LAND on
 * their cue (whoosh peak, transition hit, riser arrival) start early by their measured landing offset, so the
 * peak — not the file start — sits on the cut.
 */

/** share of the default length where a "landing" sound peaks (used to shorten sounds cued near 0 ms) */
export const SFX_LANDING: Partial<Record<SfxKind, number>> = { whoosh: 0.6, transition: 0.78, riser: 1 };

/** offset (ms) of the loudest 20 ms window — where a landing sound lands */
export async function landingOffsetMs(file: string, signal?: AbortSignal): Promise<number> {
  const [mono] = await decodeAudio(file, { channels: 1, ...(signal ? { signal } : {}) });
  const win = Math.round(0.02 * REEL_SR);
  let best = 0;
  let bestAt = 0;
  for (let s = 0; s + win <= mono!.length; s += win / 2) {
    let acc = 0;
    for (let i = s; i < s + win; i++) acc += mono![i]! * mono![i]!;
    if (acc > best) {
      best = acc;
      bestAt = s + win / 2;
    }
  }
  return Math.round((bestAt * 1000) / REEL_SR);
}

/** a provider wrapper that reports "cannot make this kind" through available() (keeps the chain's reasons) */
function forKind(p: SfxProvider, kind: SfxKind): SfxProvider {
  return {
    name: p.name,
    capability: p.capability,
    local: p.local,
    model: p.model,
    available: () =>
      p.has(kind) ? p.available() : Promise.resolve({ ok: false, reason: `cannot make "${kind}"` }),
    has: (k) => p.has(k),
    estimateMicros: (k) => p.estimateMicros(k),
    get: (req, ctx) => p.get(req, ctx),
  };
}

export async function buildSfxCues(
  plan: Pick<ReelPlan, "sfx" | "metadata" | "durationMs">,
  chain: readonly SfxProvider[],
  ctx: CallContext,
  opts: {
    /** the job's budget gate; default: free providers only */
    budget?: BudgetGate;
    onFallback?: (f: FallbackRecord) => void;
  } = {},
): Promise<SfxCueFile[]> {
  const budget = opts.budget ?? new BudgetGate(0, new CostTracker());
  const done = new Map<string, { path: string; provider: string; cached: boolean; leadMs: number }>();
  const out: SfxCueFile[] = [];
  for (const [i, cue] of plan.sfx.entries()) {
    if (cue.atMs >= plan.durationMs) continue;
    const landing = SFX_LANDING[cue.kind];
    // a landing sound cued before its natural lead is made shorter so it still lands on the cue
    const def = SFX_LENGTH_MS[cue.kind];
    const durationMs =
      landing && cue.atMs < def.default * landing
        ? Math.max(def.min, Math.floor(cue.atMs / landing))
        : undefined;
    const req = {
      kind: cue.kind,
      seed: `${plan.metadata.seed}:sfx:${i}`,
      ...(durationMs ? { durationMs } : {}),
    };
    const memo = `${cue.kind}|${durationMs ?? ""}|${req.seed}`;
    let got = done.get(memo);
    if (!got) {
      const outcome = await runChain({
        capability: "sfx",
        providers: chain.map((p) => forKind(p, cue.kind)),
        budget,
        estimate: (p) => p.estimateMicros(cue.kind),
        run: (p) => p.get(req, ctx),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (outcome.fallback) opts.onFallback?.(outcome.fallback);
      const leadMs = landing ? await landingOffsetMs(outcome.result.path, ctx.signal) : 0;
      got = {
        path: outcome.result.path,
        provider: outcome.provider.name,
        cached: outcome.result.cached,
        leadMs,
      };
      done.set(memo, got);
    }
    out.push({
      atMs: Math.max(0, Math.round(cue.atMs - got.leadMs)),
      kind: cue.kind,
      gainDb: cue.gainDb,
      path: got.path,
      provider: got.provider,
      cached: got.cached,
    });
  }
  return out;
}
