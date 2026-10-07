import { spawn } from "node:child_process";
import { getFfmpegConfig } from "@cre/media";

/**
 * Local frame analysis (spec §38–§40): FFmpeg decodes a downscaled grey proxy (default 10 fps, 108×192) and the
 * statistics are computed here — luma mean / spread, frame-to-frame difference and a 64-bit difference hash
 * (dHash) for perceptual similarity. No vision model, no API call.
 */
export const PROXY = { w: 108, h: 192, fps: 10 } as const;

export interface FrameStat {
  index: number;
  ms: number;
  mean: number;
  std: number;
  /** mean absolute difference to the previous sample (0–255) */
  diff: number;
  /** dHash as 16 hex chars */
  hash: string;
}

export async function decodeGrayFrames(
  file: string,
  opts: { fps?: number; signal?: AbortSignal } = {},
): Promise<Buffer[]> {
  const fps = opts.fps ?? PROXY.fps;
  const size = PROXY.w * PROXY.h;
  return new Promise((resolve, reject) => {
    const child = spawn(
      getFfmpegConfig().ffmpegPath,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        file,
        "-vf",
        `fps=${fps},scale=${PROXY.w}:${PROXY.h}:flags=area,format=gray`,
        "-f",
        "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"], ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg frame decode failed (${code}): ${err.slice(-400)}`));
      const all = Buffer.concat(chunks);
      const frames: Buffer[] = [];
      for (let o = 0; o + size <= all.length; o += size) frames.push(all.subarray(o, o + size));
      resolve(frames);
    });
  });
}

/** 9×8 block means → 64 horizontal comparisons */
export function dHash(frame: Buffer, w = PROXY.w, h = PROXY.h): string {
  const cols = 9;
  const rows = 8;
  const cells = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * w) / cols);
      const x1 = Math.floor(((c + 1) * w) / cols);
      const y0 = Math.floor((r * h) / rows);
      const y1 = Math.floor(((r + 1) * h) / rows);
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += frame[y * w + x]!;
      cells[r * cols + c] = s / Math.max(1, (x1 - x0) * (y1 - y0));
    }
  }
  let bits = "";
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols - 1; c++) bits += cells[r * cols + c]! > cells[r * cols + c + 1]! ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = Number.parseInt(a[i]!, 16) ^ Number.parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export function frameStats(frames: Buffer[], fps = PROXY.fps): FrameStat[] {
  const out: FrameStat[] = [];
  let prev: Buffer | null = null;
  frames.forEach((f, index) => {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i]!;
    const mean = sum / f.length;
    let v = 0;
    for (let i = 0; i < f.length; i++) v += (f[i]! - mean) ** 2;
    let diff = 0;
    if (prev) {
      let d = 0;
      for (let i = 0; i < f.length; i++) d += Math.abs(f[i]! - prev[i]!);
      diff = d / f.length;
    }
    out.push({
      index,
      ms: Math.round((index * 1000) / fps),
      mean,
      std: Math.sqrt(v / f.length),
      diff,
      hash: dHash(f),
    });
    prev = f;
  });
  return out;
}

/**
 * Visually unchanged stretches (spec: "no unchanged scene longer than ~2.5 s"): a sample is static when the
 * frame `windowMs` later is still nearly identical (mean |Δ| < maxDiff of 255 and dHash distance ≤ maxHash).
 * Consecutive static windows merge into one segment covering their whole span.
 */
export function staticSegments(
  frames: Buffer[],
  opts: { fps?: number; windowMs?: number; maxDiff?: number; maxHash?: number } = {},
): { startMs: number; endMs: number }[] {
  const fps = opts.fps ?? PROXY.fps;
  const w = Math.round(((opts.windowMs ?? 2500) / 1000) * fps);
  const maxDiff = opts.maxDiff ?? 4;
  const maxHash = opts.maxHash ?? 5;
  const hashes = frames.map((f) => dHash(f));
  const out: { startMs: number; endMs: number }[] = [];
  let cur: { s: number; e: number } | null = null;
  for (let i = 0; i + w < frames.length; i++) {
    const a = frames[i]!;
    const b = frames[i + w]!;
    let d = 0;
    for (let k = 0; k < a.length; k++) d += Math.abs(a[k]! - b[k]!);
    const still = d / a.length < maxDiff && hamming(hashes[i]!, hashes[i + w]!) <= maxHash;
    if (still) {
      if (cur && i <= cur.e) cur.e = i + w;
      else {
        if (cur)
          out.push({ startMs: Math.round((cur.s * 1000) / fps), endMs: Math.round((cur.e * 1000) / fps) });
        cur = { s: i, e: i + w };
      }
    }
  }
  if (cur) out.push({ startMs: Math.round((cur.s * 1000) / fps), endMs: Math.round((cur.e * 1000) / fps) });
  return out;
}
