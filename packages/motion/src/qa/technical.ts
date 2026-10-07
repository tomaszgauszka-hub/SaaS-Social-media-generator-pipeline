import type { QaCheck, RenderPlan, Segment, TechnicalMetrics, TechnicalQaReport } from "@cre/creative";
import { probeMedia, runFfmpeg } from "@cre/media";
import { decodeGrayFrames, frameStats, staticSegments, type FrameStat } from "./frames.ts";

/**
 * Technical QA (spec §38): container, codecs, geometry, frame rate, duration, decode errors, black / blank /
 * frozen frames, loudness, true peak and silence — measured on the delivered file with FFmpeg and local frame
 * statistics. Deterministic and free.
 */
export const TECH_LIMITS = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationToleranceMs: 150,
  lufsTarget: -14,
  lufsWarn: 1.5,
  lufsFail: 3,
  truePeakMax: -1,
  frozenFailMs: 1500,
  frozenWarnMs: 800,
  silenceFailMs: 1000,
  maxSizeBytes: 50 * 1024 * 1024,
} as const;

function segs(stderr: string, startKey: string, endKey: string): Segment[] {
  const starts = [...stderr.matchAll(new RegExp(`${startKey}:\\s*(-?[0-9.]+)`, "g"))].map(
    (m) => Number(m[1]) * 1000,
  );
  const ends = [...stderr.matchAll(new RegExp(`${endKey}:\\s*(-?[0-9.]+)`, "g"))].map(
    (m) => Number(m[1]) * 1000,
  );
  return starts.map((s, i) => ({ startMs: Math.round(s), endMs: Math.round(ends[i] ?? s) }));
}

async function loudness(file: string): Promise<{ I: number | null; TP: number | null; LRA: number | null }> {
  const { stderr } = await runFfmpeg(
    ["-i", file, "-vn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"],
    { logLevel: "info" },
  );
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    return m ? Number(m[1]) : null;
  };
  return {
    I: num(/I:\s*(-?[0-9.]+)\s*LUFS/),
    TP: num(/Peak:\s*(-?[0-9.inf]+)\s*dBFS/),
    LRA: num(/LRA:\s*(-?[0-9.]+)\s*LU/),
  };
}

function runsBelow(
  stats: FrameStat[],
  pred: (s: FrameStat) => boolean,
  minMs: number,
  fpsMs: number,
): Segment[] {
  const out: Segment[] = [];
  let start: number | null = null;
  stats.forEach((s, i) => {
    if (pred(s)) {
      start ??= i === 0 ? 0 : stats[i - 1]!.ms;
    } else if (start !== null) {
      if (s.ms - start >= minMs) out.push({ startMs: start, endMs: s.ms });
      start = null;
    }
  });
  if (start !== null && stats.length && stats[stats.length - 1]!.ms + fpsMs - start >= minMs)
    out.push({ startMs: start, endMs: stats[stats.length - 1]!.ms + fpsMs });
  return out;
}

export async function technicalQa(
  file: string,
  plan: RenderPlan,
): Promise<{ report: TechnicalQaReport; stats: FrameStat[] }> {
  const t0 = Date.now();
  const info = await probeMedia(file);
  const [blackErr, silenceErr, decodeErr, loud, frames] = await Promise.all([
    runFfmpeg(["-i", file, "-vf", "blackdetect=d=0.03:pic_th=0.97:pix_th=0.06", "-an", "-f", "null", "-"], {
      logLevel: "info",
    }).then((r) => r.stderr),
    runFfmpeg(
      [
        "-i",
        file,
        "-vn",
        "-af",
        `silencedetect=n=-45dB:d=${TECH_LIMITS.silenceFailMs / 1000}`,
        "-f",
        "null",
        "-",
      ],
      { logLevel: "info" },
    ).then((r) => r.stderr),
    runFfmpeg(["-i", file, "-f", "null", "-"], { logLevel: "error" }).then((r) => r.stderr),
    loudness(file),
    decodeGrayFrames(file),
  ]);
  const stats = frameStats(frames);
  const stepMs = 100;
  const blackSegments = segs(blackErr, "black_start", "black_end");
  const silenceSegments = segs(silenceErr, "silence_start", "silence_end").filter(
    (s) => s.startMs < info.durationMs - 900,
  );
  const decodeErrors = decodeErr.split("\n").filter((l) => l.trim()).length;
  const blank = stats.filter((s) => s.std < 2.5);
  // a frozen picture repeats identical frames; slow camera moves are not frozen (see staticSegments)
  const frozen = runsBelow(stats.slice(1), (s) => s.diff < 0.06, TECH_LIMITS.frozenWarnMs, stepMs);
  const stillStretches = staticSegments(frames);
  const sceneCuts = stats.filter((s) => s.diff > 18).length;
  const avgMotion =
    stats.length > 1 ? stats.slice(1).reduce((a, s) => a + s.diff, 0) / (stats.length - 1) : 0;
  const beats = plan.beats.map((b) => {
    const inBeat = stats.filter((s) => s.ms >= b.startMs + 120 && s.ms < b.startMs + b.durationMs - 120);
    const mid = stats.reduce(
      (best, s) =>
        Math.abs(s.ms - (b.startMs + b.durationMs * 0.6)) <
        Math.abs(best.ms - (b.startMs + b.durationMs * 0.6))
          ? s
          : best,
      stats[0]!,
    );
    return {
      beatId: b.id,
      motion: inBeat.length ? inBeat.reduce((a, s) => a + s.diff, 0) / inBeat.length : 0,
      hash: mid?.hash ?? "",
      meanLuma: mid?.mean ?? 0,
    };
  });

  const metrics: TechnicalMetrics = {
    durationMs: info.durationMs,
    expectedDurationMs: Math.round((plan.durationInFrames / plan.format.fps) * 1000),
    width: info.width ?? 0,
    height: info.height ?? 0,
    fps: info.fps ?? 0,
    videoCodec: info.videoCodec ?? "",
    pixFmt: info.pixFmt ?? "",
    audioCodec: info.audioCodec ?? "",
    audioSampleRate: info.audioSampleRate ?? 0,
    audioChannels: info.audioChannels ?? 0,
    sizeBytes: info.sizeBytes,
    bitRate: info.bitRate ?? 0,
    integratedLufs: loud.I,
    truePeakDb: loud.TP,
    loudnessRange: loud.LRA,
    blackSegments,
    blankSamples: blank.length,
    frozenSegments: frozen,
    staticSegments: stillStretches,
    silenceSegments,
    decodeErrors,
    sceneCuts,
    avgMotion,
    beats,
  };

  const L = TECH_LIMITS;
  const checks: QaCheck[] = [];
  const add = (c: QaCheck) => checks.push(c);
  add({
    id: "codec",
    label: "Container & codecs",
    status:
      metrics.videoCodec === "h264" && metrics.pixFmt === "yuv420p" && metrics.audioCodec === "aac"
        ? "pass"
        : "fail",
    value: `${metrics.videoCodec}/${metrics.pixFmt} + ${metrics.audioCodec || "no audio"}`,
    expected: "h264/yuv420p + aac",
  });
  add({
    id: "geometry",
    label: "Resolution 9:16",
    status: metrics.width === L.width && metrics.height === L.height ? "pass" : "fail",
    value: `${metrics.width}×${metrics.height}`,
    expected: `${L.width}×${L.height}`,
  });
  add({
    id: "fps",
    label: "Frame rate",
    status: Math.abs(metrics.fps - L.fps) < 0.05 ? "pass" : "fail",
    value: `${metrics.fps}`,
    expected: `${L.fps}`,
  });
  add({
    id: "duration",
    label: "Duration matches the plan",
    status:
      Math.abs(metrics.durationMs - metrics.expectedDurationMs) <= L.durationToleranceMs ? "pass" : "fail",
    value: `${(metrics.durationMs / 1000).toFixed(2)} s`,
    expected: `${(metrics.expectedDurationMs / 1000).toFixed(2)} s ±${L.durationToleranceMs} ms`,
  });
  add({
    id: "audio",
    label: "Stereo audio track",
    status: metrics.audioChannels === 2 && metrics.audioSampleRate === 48000 ? "pass" : "fail",
    value: metrics.audioChannels ? `${metrics.audioChannels} ch · ${metrics.audioSampleRate} Hz` : "missing",
    expected: "2 ch · 48000 Hz",
  });
  add({
    id: "decode",
    label: "Decodes without errors",
    status: decodeErrors === 0 ? "pass" : "fail",
    value: `${decodeErrors} errors`,
    expected: "0",
  });
  add({
    id: "black",
    label: "No black frames",
    status: blackSegments.length === 0 ? "pass" : "fail",
    value: blackSegments.length ? blackSegments.map((s) => `${s.startMs}–${s.endMs} ms`).join(", ") : "none",
    expected: "none",
  });
  add({
    id: "blank",
    label: "No blank (uniform) frames",
    status: blank.length === 0 ? "pass" : blank.length <= 1 ? "warn" : "fail",
    value: `${blank.length} samples`,
    expected: "0",
  });
  const longFrozen = frozen.filter((s) => s.endMs - s.startMs >= L.frozenFailMs);
  add({
    id: "frozen",
    label: "No frozen video",
    status: longFrozen.length ? "fail" : frozen.length ? "warn" : "pass",
    value: frozen.length ? frozen.map((s) => `${s.startMs}–${s.endMs} ms`).join(", ") : "none",
    expected: `no hold ≥ ${L.frozenFailMs} ms`,
  });
  const lufsOff = metrics.integratedLufs === null ? 99 : Math.abs(metrics.integratedLufs - L.lufsTarget);
  add({
    id: "loudness",
    label: "Loudness (EBU R128)",
    status: lufsOff <= L.lufsWarn ? "pass" : lufsOff <= L.lufsFail ? "warn" : "fail",
    value: metrics.integratedLufs === null ? "n/a" : `${metrics.integratedLufs.toFixed(1)} LUFS`,
    expected: `${L.lufsTarget} ±${L.lufsWarn} LUFS`,
  });
  add({
    id: "truepeak",
    label: "True peak",
    status: metrics.truePeakDb !== null && metrics.truePeakDb <= L.truePeakMax ? "pass" : "fail",
    value: metrics.truePeakDb === null ? "n/a" : `${metrics.truePeakDb.toFixed(1)} dBTP`,
    expected: `≤ ${L.truePeakMax} dBTP`,
  });
  add({
    id: "silence",
    label: "No dropouts / silence",
    status: silenceSegments.length === 0 ? "pass" : "fail",
    value: silenceSegments.length
      ? silenceSegments.map((s) => `${s.startMs}–${s.endMs} ms`).join(", ")
      : "none",
    expected: `no silence ≥ ${L.silenceFailMs} ms`,
  });
  add({
    id: "size",
    label: "Upload size",
    status: metrics.sizeBytes <= L.maxSizeBytes ? "pass" : "warn",
    value: `${(metrics.sizeBytes / 1024 / 1024).toFixed(1)} MB · ${(metrics.bitRate / 1e6).toFixed(1)} Mbps`,
    expected: `≤ ${L.maxSizeBytes / 1024 / 1024} MB`,
  });
  const status = checks.some((c) => c.status === "fail") ? "FAIL" : "PASS";
  return { report: { version: 1, status, checks, metrics, analysisMs: Date.now() - t0 }, stats };
}
