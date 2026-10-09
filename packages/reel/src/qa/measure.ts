import fsp from "node:fs/promises";
import path from "node:path";
import { getFfmpegConfig, probeMedia, runFfmpeg } from "@cre/media";
import { runProcess } from "../util/proc.ts";
import type { TechMeasure } from "./checks.ts";

/**
 * Measurements of a delivered MP4 with FFmpeg (deterministic, local, free): probe, full decode (integrity),
 * frame count, EBU R128 loudness + true peak, black and frozen stretches, representative frames.
 */

function segments(stderr: string, start: string, end: string): { startMs: number; endMs: number }[] {
  const s = [...stderr.matchAll(new RegExp(`${start}[:=]\\s*(-?[0-9.]+)`, "g"))].map(
    (m) => Number(m[1]) * 1000,
  );
  const e = [...stderr.matchAll(new RegExp(`${end}[:=]\\s*(-?[0-9.]+)`, "g"))].map(
    (m) => Number(m[1]) * 1000,
  );
  return s.map((v, i) => ({ startMs: Math.round(v), endMs: Math.round(e[i] ?? v) }));
}

export function parseEbur128(stderr: string): TechMeasure["loudness"] {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  return {
    I: num(/I:\s*(-?[0-9.]+)\s*LUFS/),
    TP: num(/Peak:\s*(-?[0-9.]+)\s*dBFS/),
    LRA: num(/LRA:\s*(-?[0-9.]+)\s*LU/),
  };
}

async function frameCount(file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await runProcess(
    getFfmpegConfig().ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_packets",
      "-show_entries",
      "stream=nb_read_packets",
      "-of",
      "csv=p=0",
      file,
    ],
    { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
  );
  return Number(stdout.trim()) || 0;
}

export async function measureVideo(file: string, opts: { signal?: AbortSignal } = {}): Promise<TechMeasure> {
  const o = opts.signal ? { signal: opts.signal } : {};
  const info = await probeMedia(file, o);
  const [analysis, decode, frames] = await Promise.all([
    runFfmpeg(
      [
        "-i",
        file,
        "-filter_complex",
        "[0:v]blackdetect=d=0.1:pic_th=0.97:pix_th=0.06,freezedetect=n=0.0005:d=1.2[v];[0:a]ebur128=peak=true:framelog=quiet[a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-f",
        "null",
        "-",
      ],
      { ...o, logLevel: "info" },
    ).catch(async () =>
      // no audio stream: video analysis only
      runFfmpeg(
        [
          "-i",
          file,
          "-vf",
          "blackdetect=d=0.1:pic_th=0.97:pix_th=0.06,freezedetect=n=0.0005:d=1.2",
          "-an",
          "-f",
          "null",
          "-",
        ],
        {
          ...o,
          logLevel: "info",
        },
      ),
    ),
    runFfmpeg(["-i", file, "-f", "null", "-"], { ...o, logLevel: "error" }),
    frameCount(file, opts.signal),
  ]);
  const err = analysis.stderr;
  return {
    durationMs: info.durationMs,
    width: info.width ?? 0,
    height: info.height ?? 0,
    fps: info.fps ?? 0,
    videoCodec: info.videoCodec ?? "",
    pixFmt: info.pixFmt ?? "",
    audioCodec: info.audioCodec ?? "",
    audioSampleRate: info.audioSampleRate ?? 0,
    audioChannels: info.audioChannels ?? 0,
    frameCount: frames,
    decodeErrors: decode.stderr.split("\n").filter((l) => l.trim()).length,
    sizeBytes: info.sizeBytes,
    loudness: info.hasAudio ? parseEbur128(err) : { I: null, TP: null, LRA: null },
    black: segments(err, "black_start", "black_end"),
    freezes: segments(err, "lavfi.freezedetect.freeze_start", "lavfi.freezedetect.freeze_end"),
  };
}

/** JPEG frames at the given percentages of the duration (default 10/30/50/70/90 %). */
export async function extractRepresentativeFrames(
  videoPath: string,
  durationMs: number,
  outDir: string,
  percents: readonly number[] = [10, 30, 50, 70, 90],
  opts: { signal?: AbortSignal } = {},
): Promise<{ atMs: number; path: string }[]> {
  await fsp.mkdir(outDir, { recursive: true });
  const out: { atMs: number; path: string }[] = [];
  for (const p of percents) {
    const atMs = Math.round((durationMs * p) / 100);
    const file = path.join(outDir, `frame_${String(p).padStart(2, "0")}.jpg`);
    await runFfmpeg(
      ["-ss", (atMs / 1000).toFixed(3), "-i", videoPath, "-frames:v", "1", "-q:v", "2", file],
      opts.signal ? { signal: opts.signal } : {},
    );
    out.push({ atMs, path: file });
  }
  return out;
}
