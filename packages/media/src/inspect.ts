import { probeMedia, runFfmpeg, type MediaInfo } from "./ffmpeg.ts";

/**
 * Media QA probes: technical checks on rendered output before it reaches the approval queue.
 */
export interface Segment {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface VideoInspection {
  info: MediaInfo;
  blackSegments: Segment[];
  freezeSegments: Segment[];
  integratedLufs: number | null;
}

function parseSegments(stderr: string, startKey: string, endKey: string): Segment[] {
  const segments: Segment[] = [];
  const startRe = new RegExp(`${startKey}:\\s*([0-9.]+)`, "g");
  const endRe = new RegExp(`${endKey}:\\s*([0-9.]+)`, "g");
  const starts = [...stderr.matchAll(startRe)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(endRe)].map((m) => Number(m[1]));
  starts.forEach((s, i) => {
    const e = ends[i] ?? s;
    segments.push({
      startMs: Math.round(s * 1000),
      endMs: Math.round(e * 1000),
      durationMs: Math.round((e - s) * 1000),
    });
  });
  return segments;
}

export async function detectBlackSegments(
  path: string,
  minDurationSec = 0.5,
  signal?: AbortSignal,
): Promise<Segment[]> {
  const { stderr } = await runFfmpeg(
    ["-i", path, "-vf", `blackdetect=d=${minDurationSec}:pic_th=0.98:pix_th=0.10`, "-an", "-f", "null", "-"],
    { logLevel: "info", ...(signal ? { signal } : {}) },
  );
  return parseSegments(stderr, "black_start", "black_end");
}

export async function detectFreezeSegments(
  path: string,
  minDurationSec = 2.5,
  signal?: AbortSignal,
): Promise<Segment[]> {
  const { stderr } = await runFfmpeg(
    ["-i", path, "-vf", `freezedetect=n=-60dB:d=${minDurationSec}`, "-an", "-f", "null", "-"],
    { logLevel: "info", ...(signal ? { signal } : {}) },
  );
  const segments = parseSegments(
    stderr,
    "lavfi\\.freezedetect\\.freeze_start",
    "lavfi\\.freezedetect\\.freeze_end",
  );
  return segments;
}

export async function measureLoudness(path: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const { stderr } = await runFfmpeg(
      ["-i", path, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
      {
        logLevel: "info",
        ...(signal ? { signal } : {}),
      },
    );
    const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
    const m = /I:\s*(-?[0-9.]+)\s*LUFS/.exec(summary);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export async function inspectVideo(path: string, signal?: AbortSignal): Promise<VideoInspection> {
  const info = await probeMedia(path, signal ? { signal } : {});
  const [blackSegments, freezeSegments, integratedLufs] = await Promise.all([
    detectBlackSegments(path, 0.5, signal),
    detectFreezeSegments(path, 2.5, signal),
    info.hasAudio ? measureLoudness(path, signal) : Promise.resolve(null),
  ]);
  return { info, blackSegments, freezeSegments, integratedLufs };
}
