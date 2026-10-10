import fsp from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "@cre/media";
import { lightSwitchFrame, type ShotClip } from "../contracts/media.ts";
import type { PlanShot, ReelPlan } from "../contracts/plan.ts";
import type { Rect } from "../contracts/profiles.ts";
import { boxThroughWindow, plateMove, trackTimes, windowAt, windowExprs, type PlateMove } from "./moves.ts";
import type { LocatedShotResult, StudioShotOutput } from "./run.ts";

/*
 * Studio output → a finished shot clip: 1080×1920 @ plan.fps, H.264 (CRF 14, an intermediate the master pass
 * re-encodes), BT.709, no audio, exactly round(durationMs·fps/1000) frames.
 *
 *   plate     one still → camera move as a sub-pixel crop window: `perspective` (cubic) evaluated per frame, then
 *             a lanczos scale. Measured on a synthetic dot plate (push 1.18×, 75 frames): mean position error
 *             0.08 px, frame-to-frame jitter ≤ 0.05 px — vs 0.6 px for 4×-supersampled zoompan and 2.2 px for
 *             scale(eval=frame)+crop, which both quantise the window to whole pixels.
 *   relight   off/on plates (16-bit) linearised (sRGB EOTF), cross-faded in linear light while the product light
 *             switches on (30 → 42 % of the shot, as shotlib.light_switch), re-encoded, plus a subtle push.
 *   sequence  Blender frames at renderFps → plan.fps with motion-compensated interpolation (minterpolate mci,
 *             aobmc, bilateral ME): best SSIM against real in-between renders among duplicate / blend / mci; on a
 *             moving dot it keeps one full-brightness dot within ±2.7 px of its ideal path, where blending ghosts
 *             two 72 % copies 16 px apart. Then a lanczos scale.
 *
 * Every argument is built by the pure buildShotClipArgs (unit-tested); file names were validated by the result
 * schema, numbers are formatted by code.
 */

export const SHOT_CLIP_VERSION = "shot-clip/1";
export const SHOT_CLIP_CRF = 14;

/** perspective's `in` counts from 1 in FFmpeg 6.1 (verified by the ffmpeg test): frame index = in − 1 */
const frameProgress = (frames: number) => `clip((in-1)/${Math.max(1, frames - 1)},0,1)`;

/** sRGB ⇄ linear on 16-bit code values (lutrgb `val` ∈ 0…65535) */
const TO_LINEAR = "if(lte(val,2651),val/12.92,65535*pow((val/65535+0.055)/1.055,2.4))";
const TO_SRGB = "if(lte(val,205),val*12.92,65535*(1.055*pow(val/65535,1/2.4)-0.055))";
const lut = (e: string) => `lutrgb=r='${e}':g='${e}':b='${e}'`;

/** RGB → BT.709 limited-range YUV (HD players decode untagged and tagged 1080p as 709) */
const toYuv709 = (w: number, h: number) =>
  `scale=${w}:${h}:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p`;

export interface ShotClipArgsInput {
  shot: Pick<
    StudioShotOutput,
    "technique" | "files" | "renderFps" | "productBoxes" | "overscan" | "width" | "height"
  >;
  /** directory of the shot's files */
  dir: string;
  planShot: Pick<PlanShot, "preset" | "params" | "technique" | "durationMs">;
  fps: number;
  width: number;
  height: number;
  outPath: string;
  crf?: number;
  x264Preset?: "veryfast" | "fast" | "medium" | "slow";
}

export interface ShotClipArgs {
  args: string[];
  frameCount: number;
  productTrack: { tMs: number; rect: Rect }[];
  move?: PlateMove;
}

/** Pure: FFmpeg arguments + the product track of one shot clip. */
export function buildShotClipArgs(input: ShotClipArgsInput): ShotClipArgs {
  const { shot, planShot, fps, width: W, height: H } = input;
  const N = Math.max(1, Math.round((planShot.durationMs * fps) / 1000));
  const seconds = ((N + 2) / fps).toFixed(4);
  const file = (f: string) => path.join(input.dir, f);
  const encode = [
    "-map",
    "[v]",
    "-an",
    "-frames:v",
    String(N),
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-preset",
    input.x264Preset ?? "fast",
    "-crf",
    String(input.crf ?? SHOT_CLIP_CRF),
    "-pix_fmt",
    "yuv420p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-g",
    String(fps),
    "-movflags",
    "+faststart",
    input.outPath,
  ];

  if (shot.technique === "sequence") {
    // the image2 pattern below reads f_0001.png, f_0002.png … — the studio must have written exactly those
    shot.files.forEach((f, k) => {
      if (f !== `f_${String(k + 1).padStart(4, "0")}.png`) throw new Error(`sequence frame ${k} is ${f}`);
    });
    const R = shot.renderFps;
    // minterpolate only emits frames up to the second-to-last input: two cloned frames let it reach the end
    const retime =
      R >= fps
        ? `fps=${fps}`
        : `tpad=stop_mode=clone:stop=2,minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bilat:vsbmc=1`;
    const graph =
      `[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv444p,${retime},` +
      `tpad=stop_mode=clone:stop_duration=1,scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p[v]`;
    const lastMs = ((N - 1) * 1000) / fps;
    const productTrack = shot.productBoxes
      .map((b, k) => ({
        tMs: Math.round((k * 1000) / R),
        rect: boxThroughWindow(b, { x: 0, y: 0, s: 1 }, W, H),
      }))
      .filter((p, k, all) => p.tMs <= lastMs || (k > 0 && all[k - 1]!.tMs < lastMs));
    return {
      args: [
        "-framerate",
        String(R),
        "-start_number",
        "1",
        "-i",
        file("f_%04d.png"),
        "-filter_complex",
        graph,
        ...encode,
      ],
      frameCount: N,
      productTrack,
    };
  }

  const overscan = shot.overscan ?? 1;
  // the planned technique's move: the studio sized the overscan and the product margin for it (job.ts)
  const move = plateMove(planShot.preset, planShot.params, planShot.technique);
  const w = windowExprs(move, overscan, frameProgress(N));
  const persp =
    `perspective=x0='${w.left}*W':y0='${w.top}*H':x1='${w.right}*W':y1='${w.top}*H':` +
    `x2='${w.left}*W':y2='${w.bottom}*H':x3='${w.right}*W':y3='${w.bottom}*H':interpolation=cubic:eval=frame`;
  const box = shot.productBoxes[shot.productBoxes.length - 1]!;
  const productTrack = trackTimes(planShot.durationMs, fps).map((tMs) => {
    const n = Math.round((tMs * fps) / 1000);
    return {
      tMs,
      rect: boxThroughWindow(box, windowAt(move, overscan, Math.min(1, n / Math.max(1, N - 1))), W, H),
    };
  });
  const still = (f: string) => ["-loop", "1", "-framerate", String(fps), "-t", seconds, "-i", file(f)];

  if (shot.technique === "relight") {
    // frame-aligned: xfade starts on the first frame at / after the offset (progress 0 there)
    const offset = (lightSwitchFrame(N) / fps).toFixed(4);
    const fade = (Math.max(2, Math.round(0.12 * N)) / fps).toFixed(4);
    const graph =
      `[0:v]format=gbrp16le,${lut(TO_LINEAR)}[off];[1:v]format=gbrp16le,${lut(TO_LINEAR)}[on];` +
      `[off][on]xfade=transition=fade:duration=${fade}:offset=${offset},${lut(TO_SRGB)},format=gbrp,` +
      `${persp},${toYuv709(W, H)}[v]`;
    return {
      args: [...still(shot.files[0]!), ...still(shot.files[1]!), "-filter_complex", graph, ...encode],
      frameCount: N,
      productTrack,
      move,
    };
  }

  const graph = `[0:v]format=gbrp,${persp},${toYuv709(W, H)}[v]`;
  return {
    args: [...still(shot.files[0]!), "-filter_complex", graph, ...encode],
    frameCount: N,
    productTrack,
    move,
  };
}

/**
 * Encodes one shot clip (1080×1920 @ plan.fps) from a studio shot result and returns the ShotClip (product track
 * included for QA). `outPath` is written atomically by the caller's cache; this function writes it directly.
 */
export async function encodeShotClip(
  shotResult: LocatedShotResult,
  planShot: PlanShot,
  plan: Pick<ReelPlan, "fps" | "resolution">,
  outPath: string,
  opts: { signal?: AbortSignal; crf?: number; x264Preset?: ShotClipArgsInput["x264Preset"] } = {},
): Promise<ShotClip> {
  const t0 = Date.now();
  const built = buildShotClipArgs({
    shot: shotResult,
    dir: shotResult.dir,
    planShot,
    fps: plan.fps,
    width: plan.resolution.width,
    height: plan.resolution.height,
    outPath,
    ...(opts.crf !== undefined ? { crf: opts.crf } : {}),
    ...(opts.x264Preset ? { x264Preset: opts.x264Preset } : {}),
  });
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await runFfmpeg(built.args, opts.signal ? { signal: opts.signal } : {});
  return {
    shotId: planShot.id,
    path: outPath,
    durationMs: planShot.durationMs,
    width: plan.resolution.width,
    height: plan.resolution.height,
    fps: plan.fps,
    productTrack: built.productTrack,
    cacheHit: false,
    renderMs: shotResult.renderMs,
    encodeMs: Date.now() - t0,
  };
}
