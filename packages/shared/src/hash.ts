import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Deterministic JSON serialisation (sorted object keys) so equal inputs always hash equally.
 * `undefined` values are dropped like JSON.stringify does.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

/**
 * Idempotency key from structured parts: `<prefix>:<sha256(stable json)[0..32]>`.
 * Use the same parts for the same logical operation (e.g. project id + scene index + revision + prompt).
 */
export function idempotencyKey(prefix: string, parts: unknown): string {
  return `${prefix}:${sha256Hex(stableStringify(parts)).slice(0, 32)}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Unbiased random base62 string (crypto RNG). */
export function randomCode(length = 8): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[randomInt(0, BASE62.length)];
  return out;
}

/** Deterministic pseudo-random generator (mulberry32) seeded from a string — used by mocks/simulations. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
