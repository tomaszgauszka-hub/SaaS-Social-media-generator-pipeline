import fsp from "node:fs/promises";
import path from "node:path";
import { probeMedia, runFfmpeg } from "@cre/media";
import { billedCostOf, type GeminiUsage } from "@cre/providers";
import { errorMessage } from "@cre/shared";
import type { CallContext } from "../../capabilities/types.ts";
import type { Capability } from "../../contracts/ids.ts";
import { FileCache } from "../../util/cache.ts";
import { withResourceLock } from "../../util/lock.ts";

/*
 * Shared plumbing of the Google capability wrappers: every call is recorded in the job's CostTracker (a cache
 * hit as cost 0 / cached), results live in the content-addressed FileCache, and a paid call for one cache key
 * runs under a host-wide lock so parallel variants never pay twice for the same asset.
 */

export const GOOGLE = "google";

export interface CallRecord {
  capability: Capability;
  model: string;
  costMicros: number;
  estimated?: boolean | undefined;
  usage?: GeminiUsage | undefined;
  units?: Record<string, number>;
  latencyMs?: number | undefined;
  note?: string;
}

export function recordCall(ctx: CallContext, r: CallRecord): void {
  ctx.tracker.record({
    capability: r.capability,
    provider: GOOGLE,
    model: r.model,
    costMicros: Math.max(0, Math.round(r.costMicros)),
    estimated: r.estimated ?? false,
    cached: false,
    inputTokens: r.usage?.inputTokens ?? 0,
    // thinking tokens are billed as output
    outputTokens: (r.usage?.outputTokens ?? 0) + (r.usage?.thoughtsTokens ?? 0),
    units: {
      ...(r.usage?.thoughtsTokens ? { thoughtsTokens: r.usage.thoughtsTokens } : {}),
      ...(r.usage?.cachedTokens ? { cachedTokens: r.usage.cachedTokens } : {}),
      ...r.units,
    },
    latencyMs: Math.max(0, Math.round(r.latencyMs ?? 0)),
    scope: ctx.scope,
    ...(r.note ? { note: r.note.slice(0, 300) } : {}),
  });
}

export function recordCacheHit(
  ctx: CallContext,
  capability: Capability,
  model: string,
  units: Record<string, number> = {},
): void {
  ctx.tracker.record({
    capability,
    provider: GOOGLE,
    model,
    costMicros: 0,
    estimated: false,
    cached: true,
    units,
    scope: ctx.scope,
  });
}

/** A failed call Google may still have billed (details.costMicros): record the spend before falling back. */
export function recordFailure(ctx: CallContext, capability: Capability, model: string, err: unknown): void {
  const costMicros = billedCostOf(err);
  if (costMicros > 0) {
    recordCall(ctx, { capability, model, costMicros, estimated: true, note: `failed: ${errorMessage(err)}` });
  }
}

/** Run a Google call; on failure record any billed spend, then rethrow (the chain falls back). */
export async function paid<T>(
  ctx: CallContext,
  capability: Capability,
  model: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    recordFailure(ctx, capability, model, err);
    throw err;
  }
}

export interface CachedResult<M> {
  meta: M;
  dir: string;
  cached: boolean;
}

/**
 * Cache-or-produce for one key. A hit needs `meta.json` (written last, so it marks a complete entry) and every
 * `required` file. `produce(dir)` makes the paid call, records it, writes its files into `dir` and returns the
 * metadata. A hit is recorded as a cost-0 cached entry.
 */
export async function cachedCall<M>(opts: {
  ctx: CallContext;
  namespace: string;
  key: string;
  /** files that must exist for a hit (a function when the names are in the metadata) */
  required: readonly string[] | ((meta: M) => readonly string[]);
  capability: Capability;
  model: string;
  produce: (dir: string) => Promise<M>;
  hitUnits?: Record<string, number>;
}): Promise<CachedResult<M>> {
  const { ctx, namespace, key } = opts;
  const cache = new FileCache(ctx.cacheDir);
  const dir = cache.dir(namespace, key);
  const lookup = async (): Promise<M | undefined> => {
    const meta = await cache.readJson<M>(namespace, key, "meta.json");
    if (meta === undefined) return undefined;
    const required = typeof opts.required === "function" ? opts.required(meta) : opts.required;
    return required.every((f) => /^[\w.-]+$/.test(f) && cache.has(namespace, key, f)) ? meta : undefined;
  };
  const hit = (meta: M): CachedResult<M> => {
    recordCacheHit(ctx, opts.capability, opts.model, opts.hitUnits);
    ctx.logger?.debug({ namespace, key, model: opts.model }, "google cache hit");
    return { meta, dir, cached: true };
  };
  const early = await lookup();
  if (early !== undefined) return hit(early);
  return await withResourceLock(
    path.join(ctx.cacheDir, ".locks"),
    `${namespace}.${key.slice(0, 24)}`,
    1,
    async () => {
      const again = await lookup();
      if (again !== undefined) return hit(again);
      await fsp.mkdir(dir, { recursive: true });
      const meta = await opts.produce(dir);
      await cache.writeJson(namespace, key, meta, "meta.json");
      return { meta, dir, cached: false };
    },
    { ...(ctx.signal ? { signal: ctx.signal } : {}), pollMs: 250 },
  );
}

/* ---------------------------------------------------------------- local media steps --------------- */

/** Decode / resample any audio file to 16-bit PCM WAV at 48 kHz (the reel's audio rate). */
export async function toWav48k(
  input: string,
  output: string,
  channels: 1 | 2,
  signal?: AbortSignal,
): Promise<void> {
  const tmp = `${output}.tmp-${process.pid}.wav`;
  try {
    await runFfmpeg(
      ["-i", input, "-vn", "-ar", "48000", "-ac", String(channels), "-c:a", "pcm_s16le", tmp],
      signal ? { signal } : {},
    );
    await fsp.rename(tmp, output);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/** Cut a generated clip to the requested length, drop its audio (the reel has its own mix), H.264 yuv420p. */
export async function trimClip(
  input: string,
  output: string,
  seconds: number,
  signal?: AbortSignal,
): Promise<number> {
  const tmp = `${output}.tmp-${process.pid}.mp4`;
  try {
    await runFfmpeg(
      [
        "-i",
        input,
        "-t",
        seconds.toFixed(3),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        tmp,
      ],
      signal ? { signal } : {},
    );
    await fsp.rename(tmp, output);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  return (await probeMedia(output)).durationMs;
}

/** Stable uint32 seed from a plan seed string (Veo on Agent Platform). */
export function numericSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Collapse whitespace / brackets of free text that goes into a prompt (keeps the prompt's structure intact). */
export function promptSafe(text: string, max: number): string {
  return text
    .replace(/[\r\n\t[\]{}<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** "minimal" thinking only where the model accepts it (Flash-Lite); full Flash models error on it → "low". */
export function thinkingFor(model: string): "minimal" | "low" {
  return /flash-lite/i.test(model) ? "minimal" : "low";
}
