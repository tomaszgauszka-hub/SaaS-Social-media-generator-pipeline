import fs from "node:fs";
import path from "node:path";
import { FatalError } from "@cre/shared";
import type { EngineRenderOutput } from "../contracts/engine.ts";
import { runEngineProcess } from "./proc.ts";

/*
 * Engine-independent post-processing of a rendered PNG sequence: H.264 master clip (yuv420p, faststart), an
 * optional VP9 clip with alpha (Remotion OffthreadVideo `transparent`), a thumbnail (the frame where the product
 * is largest) and a 3 × 2 control sheet of the multi-view renders. FFmpeg runs without a shell.
 */

export interface EncodeOptions {
  ffmpeg: string;
  quality: "preview" | "production";
  /** clip fps: a sequence rendered at a lower rate is interpolated to it (motion-compensated) */
  fps: number;
  /** clip length in output frames */
  frames: number;
  signal?: AbortSignal;
}

export interface EncodedClip {
  video: string;
  alphaVideo: string | null;
  thumbnail: string;
  controlSheet: string | null;
  encodeMs: number;
}

/** Index (0-based) of the frame where the product box is largest — the thumbnail frame. */
export function bestFrame(boxes: readonly number[][], count: number): number {
  let best = Math.floor(count / 2);
  let area = -1;
  boxes.forEach((b, i) => {
    const [u0, v0, u1, v1] = b as [number, number, number, number];
    const inside =
      Math.max(0, Math.min(1, u1) - Math.max(0, u0)) * Math.max(0, Math.min(1, v1) - Math.max(0, v0));
    if (inside > area * 1.02) {
      area = inside;
      best = i;
    }
  });
  return Math.min(Math.max(0, best), Math.max(0, count - 1));
}

/**
 * Video filter: a sequence rendered below the clip fps is interpolated with motion compensation (as the product
 * studio does for its FAST previews); two cloned tail frames let minterpolate reach the last input frame.
 */
export function videoFilter(renderFps: number, fps: number): string {
  const interp =
    renderFps < fps
      ? `tpad=stop_mode=clone:stop=2,minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bilat:vsbmc=1,`
      : "";
  return `${interp}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`;
}

export function h264Args(
  input: string,
  startNumber: number,
  renderFps: number,
  out: string,
  quality: "preview" | "production",
  fps = renderFps,
  frames?: number,
): string[] {
  return [
    "-y",
    "-loglevel",
    "error",
    "-framerate",
    String(renderFps),
    "-start_number",
    String(startNumber),
    "-i",
    input,
    "-vf",
    videoFilter(renderFps, fps),
    "-r",
    String(fps),
    ...(frames ? ["-frames:v", String(frames)] : []),
    "-c:v",
    "libx264",
    "-preset",
    quality === "production" ? "slow" : "veryfast",
    "-crf",
    quality === "production" ? "14" : "18",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-movflags",
    "+faststart",
    "-an",
    out,
  ];
}

/** xstack layout of `n` equally sized tiles in rows of `cols` ("0_0|w0_0|w0+w1_0|0_h0|…"). */
export function xstackLayout(n: number, cols: number): string {
  const sum = (prefix: string, count: number, step = 1) =>
    count === 0 ? "0" : Array.from({ length: count }, (_, k) => `${prefix}${k * step}`).join("+");
  return Array.from(
    { length: n },
    (_, i) => `${sum("w", i % cols)}_${sum("h", Math.floor(i / cols), cols)}`,
  ).join("|");
}

export async function encodeClip(
  r: EngineRenderOutput,
  outDir: string,
  opts: EncodeOptions,
): Promise<EncodedClip> {
  const t0 = Date.now();
  if (r.frameCount < 1) throw new FatalError("no frames to encode");
  fs.mkdirSync(outDir, { recursive: true });
  const input = path.join(r.framesDir, r.framePattern);
  const video = path.join(outDir, "clip.mp4");
  const run = (args: string[]) =>
    runEngineProcess(opts.ffmpeg, args, {
      timeoutMs: 30 * 60_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  await run(h264Args(input, r.startNumber, r.fps, video, opts.quality, opts.fps, opts.frames));
  let alphaVideo: string | null = null;
  if (r.alpha) {
    alphaVideo = path.join(outDir, "clip_alpha.webm");
    await run([
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(r.fps),
      "-start_number",
      String(r.startNumber),
      "-i",
      input,
      ...(r.fps < opts.fps ? ["-vf", `fps=${opts.fps}`, "-frames:v", String(opts.frames)] : []),
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-b:v",
      "0",
      "-crf",
      opts.quality === "production" ? "18" : "28",
      "-row-mt",
      "1",
      "-an",
      alphaVideo,
    ]);
  }
  const idx = bestFrame(r.productBoxes, r.frameCount);
  const frameFile = path.join(
    r.framesDir,
    r.framePattern.replace("%04d", String(idx + r.startNumber).padStart(4, "0")),
  );
  const thumbnail = path.join(outDir, "thumbnail.jpg");
  await run(["-y", "-loglevel", "error", "-i", frameFile, "-q:v", "3", thumbnail]);
  let controlSheet: string | null = null;
  if (r.controlViews.length >= 2) {
    controlSheet = path.join(outDir, "control_sheet.jpg");
    const inputs = r.controlViews.flatMap((v) => ["-i", v]);
    await run([
      "-y",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      `${r.controlViews.map((_, i) => `[${i}:v]`).join("")}xstack=inputs=${r.controlViews.length}:layout=${xstackLayout(r.controlViews.length, 3)}:fill=black[v]`,
      "-map",
      "[v]",
      "-q:v",
      "3",
      controlSheet,
    ]);
  }
  return { video, alphaVideo, thumbnail, controlSheet, encodeMs: Date.now() - t0 };
}
