import fs from "node:fs";
import path from "node:path";
import type { ClipQaReport, QaCheck } from "../contracts/asset.ts";
import type { EngineRenderOutput } from "../contracts/engine.ts";
import { runEngineProcess } from "../engines/proc.ts";

/*
 * Automatic technical QA of a rendered 3D clip. It detects technical faults — it does not pretend to judge
 * aesthetics: every clip still goes to the owner for approval.
 *
 * Checked: resolution, fps, duration, sequence completeness, black frames, missing textures (engine report +
 * magenta pixels), product out of frame / too small, exposure on the product (too dark / blown out), temporal
 * stability (frame-to-frame jumps), alpha artifacts on transparent clips, model proportions against the
 * product's real dimensions, control views. Geometry intersections are NOT reliably detectable from pixels and
 * are reported as "not checked" rather than guessed.
 */

export interface ClipQaInput {
  video: string;
  render: EngineRenderOutput;
  expected: { width: number; height: number; fps: number; frames: number };
  /** the product's real dimensions (m), when known */
  dimensionsM?: readonly [number, number, number] | null;
  /** fly-in templates start with parts outside the frame on purpose */
  allowEarlyOutOfFrame?: boolean;
  controlViewsRequested?: boolean;
  ffmpeg: string;
  ffprobe: string;
}

export interface FrameStats {
  mean: number;
  max: number;
  clipped: number;
  crushed: number;
  magenta: number;
  /** mean luma inside the product box */
  productMean: number | null;
  productClipped: number | null;
  productCrushed: number | null;
}

const SAMPLE_W = 96;
const SAMPLE_H = 170;

/** Pixel statistics of one RGB24 frame (optionally restricted stats inside a normalised box). */
export function frameStats(rgb: Buffer, w: number, h: number, box: readonly number[] | null): FrameStats {
  let sum = 0;
  let max = 0;
  let clipped = 0;
  let crushed = 0;
  let magenta = 0;
  let pSum = 0;
  let pN = 0;
  let pClip = 0;
  let pCrush = 0;
  const [u0, v0, u1, v1] = box ?? [2, 2, -1, -1];
  const x0 = Math.floor(Math.max(0, u0!) * w);
  const x1 = Math.ceil(Math.min(1, u1!) * w);
  const y0 = Math.floor(Math.max(0, v0!) * h);
  const y1 = Math.ceil(Math.min(1, v1!) * h);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += y;
    if (y > max) max = y;
    if (y >= 250) clipped++;
    if (y <= 6) crushed++;
    if (r > 190 && b > 190 && g < 70) magenta++;
    const px = i % w;
    const py = Math.floor(i / w);
    if (px >= x0 && px < x1 && py >= y0 && py < y1) {
      pSum += y;
      pN++;
      if (y >= 250) pClip++;
      if (y <= 6) pCrush++;
    }
  }
  return {
    mean: sum / n,
    max,
    clipped: clipped / n,
    crushed: crushed / n,
    magenta: magenta / n,
    productMean: pN ? pSum / pN : null,
    productClipped: pN ? pClip / pN : null,
    productCrushed: pN ? pCrush / pN : null,
  };
}

/** Fraction of a box's area that lies outside the frame. */
export function outsideFraction(box: readonly number[]): number {
  const [u0, v0, u1, v1] = box as [number, number, number, number];
  const area = Math.max(1e-9, (u1 - u0) * (v1 - v0));
  const inside =
    Math.max(0, Math.min(1, u1) - Math.max(0, u0)) * Math.max(0, Math.min(1, v1) - Math.max(0, v0));
  return Math.max(0, 1 - inside / area);
}

export async function probeVideo(
  ffprobe: string,
  file: string,
): Promise<{ width: number; height: number; fps: number; frames: number; durationSec: number }> {
  const r = await runEngineProcess(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=width,height,r_frame_rate,nb_read_frames,duration",
      "-of",
      "json",
      file,
    ],
    { timeoutMs: 120_000 },
  );
  const s = (JSON.parse(r.stdout) as { streams?: Record<string, string | number>[] }).streams?.[0] ?? {};
  const [num, den] = String(s.r_frame_rate ?? "0/1")
    .split("/")
    .map(Number);
  return {
    width: Number(s.width ?? 0),
    height: Number(s.height ?? 0),
    fps: den ? num! / den : 0,
    frames: Number(s.nb_read_frames ?? 0),
    durationSec: Number(s.duration ?? 0),
  };
}

async function sampledFrames(ffmpeg: string, video: string, every: number): Promise<Buffer[]> {
  const r = await new Promise<Buffer>((resolve, reject) => {
    // decoded through FFmpeg into raw RGB24 thumbnails (no shell; stdout is binary)
    import("node:child_process")
      .then(({ spawn }) => {
        const child = spawn(
          ffmpeg,
          [
            "-v",
            "error",
            "-i",
            video,
            "-vf",
            `select=not(mod(n\\,${every})),scale=${SAMPLE_W}:${SAMPLE_H}`,
            "-vsync",
            "0",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
          ],
          { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true },
        );
        const chunks: Buffer[] = [];
        child.stdout.on("data", (d: Buffer) => chunks.push(d));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`)),
        );
      })
      .catch(reject);
  });
  const size = SAMPLE_W * SAMPLE_H * 3;
  const out: Buffer[] = [];
  for (let o = 0; o + size <= r.length; o += size) out.push(r.subarray(o, o + size));
  return out;
}

/** Alpha of the outer border of a PNG frame: a transparent clip must be fully transparent at its edges. */
async function borderAlphaLeak(ffmpeg: string, png: string): Promise<number> {
  const w = 64;
  const h = 114;
  const { spawn } = await import("node:child_process");
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-v", "error", "-i", png, "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
      { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`)),
    );
  });
  let leak = 0;
  let n = 0;
  const bx = Math.round(w * 0.06);
  const by = Math.round(h * 0.04);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x >= bx && x < w - bx && y >= by) continue; // the bottom edge holds the contact shadow
      n++;
      if (buf[(y * w + x) * 4 + 3]! > 8) leak++;
    }
  return n ? leak / n : 0;
}

function check(
  id: string,
  ok: boolean,
  severity: QaCheck["severity"],
  value: QaCheck["value"],
  message: string,
): QaCheck {
  return { id, ok, severity, value, message };
}

export async function runClipQa(input: ClipQaInput): Promise<ClipQaReport> {
  const checks: QaCheck[] = [];
  const { render: r, expected } = input;
  const probe = await probeVideo(input.ffprobe, input.video);
  checks.push(
    check(
      "resolution",
      probe.width === expected.width && probe.height === expected.height,
      "blocker",
      `${probe.width}x${probe.height}`,
      `expected ${expected.width}x${expected.height}`,
    ),
    check(
      "fps",
      Math.abs(probe.fps - expected.fps) < 0.01,
      "blocker",
      probe.fps,
      `expected ${expected.fps} fps`,
    ),
    check(
      "duration",
      Math.abs(probe.frames - expected.frames) <= 1,
      "blocker",
      probe.frames,
      `expected ${expected.frames} frames (${(expected.frames / expected.fps).toFixed(2)} s)`,
    ),
  );
  const pngs = fs.existsSync(r.framesDir)
    ? fs.readdirSync(r.framesDir).filter((f) => f.endsWith(".png")).length
    : 0;
  checks.push(
    check(
      "sequence_complete",
      r.frameCount === expected.frames && pngs >= expected.frames,
      "blocker",
      pngs,
      `${expected.frames} rendered frames expected`,
    ),
  );

  const every = Math.max(1, Math.floor(probe.frames / 24));
  const frames = await sampledFrames(input.ffmpeg, input.video, every);
  const stats = frames.map((f, k) => frameStats(f, SAMPLE_W, SAMPLE_H, r.productBoxes[k * every] ?? null));
  const black = stats.filter((s) => s.mean < 8 && s.max < 40).length;
  checks.push(
    check("no_black_frames", black === 0, "blocker", black, "frames that are (almost) entirely black"),
  );
  const magenta = Math.max(0, ...stats.map((s) => s.magenta));
  const missing = r.warnings.filter((w) => w.startsWith("missing texture")).length;
  checks.push(
    check(
      "textures_present",
      missing === 0 && magenta < 0.002,
      "blocker",
      missing ? `${missing} missing` : magenta,
      "missing textures (engine report / magenta placeholder pixels)",
    ),
  );

  const outside = r.productBoxes.map(outsideFraction);
  const start = input.allowEarlyOutOfFrame ? Math.floor(outside.length * 0.4) : 0;
  const worst = Math.max(0, ...outside.slice(start));
  checks.push(
    check(
      "product_in_frame",
      worst <= 0.04,
      "blocker",
      Number(worst.toFixed(3)),
      "share of the product box outside the frame (worst frame)",
    ),
  );
  const heights = r.productBoxes.map((b) => Math.min(1, b[3]!) - Math.max(0, b[1]!)).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)]! : 0;
  checks.push(
    check(
      "product_size",
      medianH >= 0.16,
      "warning",
      Number(medianH.toFixed(3)),
      "median product height in frame (≥ 16 % keeps it readable on a phone)",
    ),
  );

  const pm = stats.map((s) => s.productMean).filter((x): x is number => x !== null);
  const pMean = pm.length ? pm.reduce((a, b) => a + b, 0) / pm.length : (stats[0]?.mean ?? 0);
  checks.push(
    check(
      "product_exposure",
      pMean >= 28 && pMean <= 228,
      "warning",
      Math.round(pMean),
      "mean luma on the product (28–228)",
    ),
  );
  const blown = Math.max(0, ...stats.map((s) => s.productClipped ?? s.clipped));
  checks.push(
    check(
      "no_blown_highlights",
      blown <= 0.03,
      "warning",
      Number(blown.toFixed(4)),
      "share of clipped pixels on the product",
    ),
  );
  const crushedP = Math.max(0, ...stats.map((s) => s.productCrushed ?? 0));
  checks.push(
    check(
      "no_crushed_product",
      crushedP <= 0.35,
      "warning",
      Number(crushedP.toFixed(3)),
      "share of pure-black pixels on the product",
    ),
  );
  let jump = 0;
  for (let k = 1; k < stats.length; k++) jump = Math.max(jump, Math.abs(stats[k]!.mean - stats[k - 1]!.mean));
  checks.push(
    check(
      "temporal_stability",
      jump <= 28,
      "warning",
      Number(jump.toFixed(1)),
      "largest luma jump between sampled frames (flicker / pop)",
    ),
  );

  if (r.alpha) {
    const first = path.join(
      r.framesDir,
      r.framePattern.replace("%04d", String(r.startNumber).padStart(4, "0")),
    );
    const leak = fs.existsSync(first) ? await borderAlphaLeak(input.ffmpeg, first) : 1;
    checks.push(
      check(
        "alpha_clean",
        leak <= 0.01,
        "warning",
        Number(leak.toFixed(4)),
        "opaque pixels at the border of a transparent clip (background leak / halo)",
      ),
    );
  }
  const dims = r.exports.dimensionsM;
  if (input.dimensionsM && dims && dims.length === 3) {
    const a = [...input.dimensionsM].sort((x, y) => x - y);
    const b = [...dims].sort((x, y) => x - y);
    const dev = Math.max(...a.map((x, i) => Math.abs(b[i]! - x) / Math.max(1e-6, x)));
    checks.push(
      check(
        "proportions",
        dev <= 0.1,
        "blocker",
        Number(dev.toFixed(3)),
        "largest deviation of the model's dimensions from the product's real dimensions",
      ),
    );
  } else {
    checks.push(
      check("proportions", true, "info", null, "no reference dimensions — proportions not checked"),
    );
  }
  checks.push(
    check(
      "geometry_intersections",
      true,
      "info",
      null,
      "not checked: intersections are not reliably detectable from pixels (review the control views)",
    ),
  );
  if (input.controlViewsRequested)
    checks.push(
      check(
        "control_views",
        r.controlViews.length >= 6,
        "warning",
        r.controlViews.length,
        "multi-direction control renders",
      ),
    );

  const blockers = checks.filter((c) => !c.ok && c.severity === "blocker").length;
  const warnings = checks.filter((c) => !c.ok && c.severity === "warning").length;
  return {
    passed: blockers === 0,
    score: Math.max(0, 100 - 25 * blockers - 6 * warnings),
    checks,
    note: "automatic technical checks; aesthetics need owner review",
  };
}

/**
 * Cut between two clips: luma / colour jump between the last frame of `a` and the first of `b` (storyboard
 * transitions). A large jump is flagged so the 2D layer can use a softer transition there.
 */
export async function transitionJump(ffmpeg: string, a: string, b: string): Promise<number> {
  const last = await sampledFrames(ffmpeg, a, 1);
  const first = await sampledFrames(ffmpeg, b, 1);
  const fa = last.at(-1);
  const fb = first[0];
  if (!fa || !fb) return 0;
  const sa = frameStats(fa, SAMPLE_W, SAMPLE_H, null);
  const sb = frameStats(fb, SAMPLE_W, SAMPLE_H, null);
  return Math.abs(sa.mean - sb.mean);
}
