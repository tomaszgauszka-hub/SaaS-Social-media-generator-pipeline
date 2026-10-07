import fs from "node:fs";
import path from "node:path";
import type { RenderPlan } from "@cre/creative";
import { probeMedia, runFfmpeg, type MediaInfo } from "@cre/media";
import { mixAudio } from "./audio/director.ts";
import { renderReelVideo, type RenderEnvOptions } from "./render.ts";

/**
 * Finishing (spec §21/§36): FFmpeg does what it is best at — loudness normalisation (EBU R128 two-pass,
 * −14 LUFS integrated, −1.5 dBTP), AAC encoding and the final mux with +faststart. The video stream from the
 * renderer is copied, never re-encoded twice.
 */
/** loudnorm aims 1.5 dB below the −1.5 dBTP delivery ceiling: AAC encoding adds inter-sample overshoot */
export const LOUDNESS_TARGET = { I: -14, TP: -3, LRA: 11 } as const;

interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export async function normalizeLoudness(
  inWav: string,
  outWav: string,
): Promise<{ measuredI: number; measuredTP: number }> {
  const { I, TP, LRA } = LOUDNESS_TARGET;
  const { stderr } = await runFfmpeg(
    ["-i", inWav, "-af", `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, "-f", "null", "-"],
    {
      logLevel: "info",
    },
  );
  const json = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
  const m = JSON.parse(json) as LoudnormMeasure;
  await runFfmpeg([
    "-i",
    inWav,
    "-af",
    `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    outWav,
  ]);
  return { measuredI: Number(m.input_i), measuredTP: Number(m.input_tp) };
}

export async function muxFinal(videoFile: string, audioWav: string, outFile: string): Promise<void> {
  await runFfmpeg([
    "-i",
    videoFile,
    "-i",
    audioWav,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-shortest",
    "-movflags",
    "+faststart",
    outFile,
  ]);
}

export async function extractPoster(videoFile: string, atMs: number, outFile: string): Promise<void> {
  await runFfmpeg(["-ss", (atMs / 1000).toFixed(3), "-i", videoFile, "-frames:v", "1", "-q:v", "3", outFile]);
}

export interface FinishedReel {
  file: string;
  poster: string;
  info: MediaInfo;
  renderMs: number;
  audioMs: number;
  finishMs: number;
  frames: number;
  /** render throughput (frames per wall-clock second) */
  renderFps: number;
  sourceLoudness: { measuredI: number; measuredTP: number };
}

/** Plan → silent master (Remotion) → audio mix → loudness → mux → poster. All local. */
export async function renderFinishedReel(
  plan: RenderPlan,
  outDir: string,
  opts: RenderEnvOptions & { onProgress?: (p: number) => void; posterAtMs?: number } = {},
): Promise<FinishedReel> {
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, plan.storyboardId);
  const silent = `${base}.video.mp4`;
  const rawWav = `${base}.mix.wav`;
  const normWav = `${base}.norm.wav`;
  const file = `${base}.mp4`;
  const poster = `${base}.poster.jpg`;

  const video = await renderReelVideo(plan, silent, opts);

  const a0 = Date.now();
  const mix = mixAudio(plan);
  fs.writeFileSync(rawWav, mix.wav);
  const audioMs = Date.now() - a0;

  const f0 = Date.now();
  const sourceLoudness = await normalizeLoudness(rawWav, normWav);
  await muxFinal(silent, normWav, file);
  const productBeat = plan.beats.find((b) => b.type === "PRODUCT_HERO") ?? plan.beats[0]!;
  await extractPoster(
    file,
    opts.posterAtMs ?? productBeat.startMs + Math.min(1600, productBeat.durationMs - 200),
    poster,
  );
  const finishMs = Date.now() - f0;
  for (const tmp of [silent, rawWav, normWav]) fs.rmSync(tmp, { force: true });

  const info = await probeMedia(file);
  return {
    file,
    poster,
    info,
    renderMs: video.renderMs,
    audioMs,
    finishMs,
    frames: video.frames,
    renderFps: video.fps,
    sourceLoudness,
  };
}
