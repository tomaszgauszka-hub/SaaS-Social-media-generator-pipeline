import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeMedia, runFfmpeg } from "@cre/media";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlanShot } from "../contracts/plan.ts";
import { encodeShotClip } from "./encode.ts";
import { plateMove, windowAt } from "./moves.ts";
import type { LocatedShotResult } from "./run.ts";

/*
 * Real FFmpeg on synthetic studio output: the clip's pixels must land where the pure math (productTrack) says,
 * the relight must cross-fade in linear light on schedule, and sequences must be interpolated smoothly.
 */

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const W = 1080;
const H = 1920;
const plan = { fps: 30, resolution: { width: W, height: H } };
const params = {
  intensity: 1,
  angleDeg: -25,
  height: 0.55,
  focus: "whole" as const,
  fill: 0.62,
  sweepDeg: 40,
};
const planShot = (
  preset: PlanShot["preset"],
  technique: PlanShot["technique"],
  durationMs: number,
): PlanShot => ({
  id: "sh01",
  role: "HOOK",
  startMs: 0,
  durationMs,
  preset,
  technique,
  environment: "dark_premium",
  lighting: "three_point",
  params,
  productAnimation: "none",
  transitionIn: { type: "cut", ms: 0 },
  source: "blender",
});

/** grey canvas with soft dots (σ 3 px) at the given pixel centres → PNG */
async function dotsPng(file: string, w: number, h: number, dots: [number, number][]): Promise<void> {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0.15;
      for (const [cx, cy] of dots) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 < 400) v += 0.8 * Math.exp(-d2 / 18);
      }
      buf.fill(Math.round(Math.min(1, v) * 255), (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  const raw = `${file}.rgb`;
  fs.writeFileSync(raw, buf);
  await runFfmpeg([
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    `${w}x${h}`,
    "-i",
    raw,
    "-frames:v",
    "1",
    file,
  ]);
  fs.rmSync(raw);
}

/** every frame of a clip as 8-bit grey */
async function greyFrames(clip: string, dir: string): Promise<Uint8Array[]> {
  const out = path.join(dir, `${path.basename(clip)}.gray`);
  await runFfmpeg(["-i", clip, "-f", "rawvideo", "-pix_fmt", "gray", out]);
  const all = fs.readFileSync(out);
  const frames: Uint8Array[] = [];
  for (let o = 0; o + W * H <= all.length; o += W * H) frames.push(all.subarray(o, o + W * H));
  return frames;
}

/** intensity centroid (pixel-index units) in a window around (x, y) */
function centroid(f: Uint8Array, x: number, y: number, r = 40): [number, number] {
  let sx = 0;
  let sy = 0;
  let s = 0;
  for (let j = Math.round(y) - r; j <= Math.round(y) + r; j++)
    for (let i = Math.round(x) - r; i <= Math.round(x) + r; i++) {
      const v = Math.max(0, f[j * W + i]! - 60);
      sx += v * i;
      sy += v * j;
      s += v;
    }
  return [sx / s, sy / s];
}

describe.skipIf(!hasFfmpeg)("shot clip encoding (real FFmpeg, synthetic studio output)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ffmpeg-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("plate: the move lands every dot within half a pixel of the predicted track", async () => {
    const pw = 956;
    const ph = 1699;
    const dots: [number, number][] = [
      [140, 300],
      [800, 1450],
      [478, 850],
    ];
    await dotsPng(path.join(dir, "plate.png"), pw, ph, dots);
    const shot: LocatedShotResult = {
      id: "sh01",
      technique: "plate",
      files: ["plate.png"],
      width: pw,
      height: ph,
      renderFps: 15,
      productBoxes: [{ x: 0.2, y: 0.25, w: 0.6, h: 0.5 }],
      samples: 4,
      renderMs: 1,
      engine: "CYCLES",
      blenderVersion: "test",
      overscan: 1.18,
      dir,
    };
    const ps = planShot("hero_reveal", "plate", 1000);
    const out = path.join(dir, "plate.mp4");
    const clip = await encodeShotClip(shot, ps, plan, out);
    const info = await probeMedia(out);
    expect([info.width, info.height, info.fps, info.hasAudio]).toEqual([W, H, 30, false]);
    expect(info.durationMs).toBeCloseTo(1000, -1);
    const frames = await greyFrames(out, dir);
    expect(frames).toHaveLength(30);
    const move = plateMove("hero_reveal", params);
    let worst = 0;
    for (const n of [0, 8, 15, 22, 29]) {
      const win = windowAt(move, 1.18, n / 29);
      for (const [px, py] of dots) {
        const ex = (((px + 0.5) / pw - win.x) / win.s) * W - 0.5;
        const ey = (((py + 0.5) / ph - win.y) / win.s) * H - 0.5;
        const [cx, cy] = centroid(frames[n]!, ex, ey);
        worst = Math.max(worst, Math.hypot(cx - ex, cy - ey));
      }
    }
    // an off-by-one frame in perspective's counter would be ≈ 5 px at mid-shot here
    expect(worst).toBeLessThan(0.5);
    expect(clip.productTrack[0]!.rect.h).toBeLessThan(clip.productTrack.at(-1)!.rect.h);
  }, 60_000);

  it("relight: cross-fades off → on in linear light from 30 % to 42 % of the shot", async () => {
    for (const [name, hex] of [
      ["off.png", "0x333333"],
      ["on.png", "0xCCCCCC"],
    ] as const)
      await runFfmpeg([
        "-f",
        "lavfi",
        "-i",
        `color=c=${hex}:s=320x568`,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb48be",
        path.join(dir, name),
      ]);
    const shot: LocatedShotResult = {
      id: "sh01",
      technique: "relight",
      files: ["off.png", "on.png"],
      width: 320,
      height: 568,
      renderFps: 15,
      productBoxes: [
        { x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
        { x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
      ],
      samples: 4,
      renderMs: 1,
      engine: "CYCLES",
      blenderVersion: "test",
      overscan: 1.18,
      dir,
    };
    const out = path.join(dir, "relight.mp4");
    await encodeShotClip(shot, planShot("silhouette_reveal", "relight", 2500), plan, out);
    const frames = await greyFrames(out, dir);
    expect(frames).toHaveLength(75);
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
    const [a, b] = [lin(0x33 / 255), lin(0xcc / 255)];
    for (let n = 0; n < 75; n++) {
      const p = Math.min(1, Math.max(0, (n - 23) / 9)); // round(0.3·75) = frame 23, round(0.12·75) = 9 frames
      const expected = srgb(a + (b - a) * p) * 255;
      expect(Math.abs(frames[n]![W * (H / 2) + W / 2]! - expected)).toBeLessThan(3);
    }
    // past half-way (p = 5/9) a linear-light blend gives ≈ 159, a naive sRGB mix ≈ 136
    expect(frames[28]![W * (H / 2) + W / 2]!).toBeGreaterThan(152);
  }, 60_000);

  it("sequence: 10 fps frames become a smooth 30 fps clip", async () => {
    const sw = 270;
    const sh = 480;
    const files: string[] = [];
    for (let k = 0; k < 11; k++) {
      const f = `f_${String(k + 1).padStart(4, "0")}.png`;
      await dotsPng(path.join(dir, f), sw, sh, [[60 + 12 * k, 240]]);
      files.push(f);
    }
    const shot: LocatedShotResult = {
      id: "sh01",
      technique: "sequence",
      files,
      width: sw,
      height: sh,
      renderFps: 10,
      productBoxes: files.map((_, k) => ({ x: (50 + 12 * k) / sw, y: 0.45, w: 20 / sw, h: 0.05 })),
      samples: 4,
      renderMs: 1,
      engine: "CYCLES",
      blenderVersion: "test",
      dir,
    };
    const out = path.join(dir, "seq.mp4");
    const clip = await encodeShotClip(shot, planShot("turntable", "sequence", 1000), plan, out);
    const frames = await greyFrames(out, dir);
    expect(frames).toHaveLength(30);
    const xs = frames.map(
      (f, n) => centroid(f, ((60 + 12 * (n / 3) + 0.5) / sw) * W - 0.5, (240.5 / sh) * H - 0.5, 60)[0],
    );
    // interpolated frames sit between their neighbours: the dot moves forward every frame by ≈ 16 px
    const steps = xs.slice(1).map((x, k) => x - xs[k]!);
    expect(Math.min(...steps)).toBeGreaterThan(8);
    expect(Math.max(...steps)).toBeLessThan(24);
    expect(clip.productTrack.map((p) => p.tMs)).toEqual([
      0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    ]);
  }, 60_000);
});
