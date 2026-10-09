import type { MusicTrack, SfxCueFile, VoiceTrack } from "../contracts/media.ts";
import type { DuckingParams } from "../contracts/plan.ts";

/**
 * Audio pass of the localized composer, as pure argument builders:
 *
 *   music (trim · fade in/out · gain · DUCKING envelope) + voice (already on the reel timeline) + SFX (delayed,
 *   gained) → amix (no normalisation) → limiter → 48 kHz float WAV → two-pass loudnorm to the platform target.
 *
 * Ducking is a deterministic gain envelope computed from the voice's word timings (we know exactly when speech
 * happens, so the music can dip *before* the first syllable instead of reacting to it like a sidechain
 * compressor): gain(t) = 10^(−depthDb · s(t) / 20), s(t) ∈ [0, 1] a trapezoid per speech region with
 * attack before the onset and release after the end.
 */

export interface Region {
  startMs: number;
  endMs: number;
}

/** Speech regions from word timings (gaps shorter than `mergeGapMs` do not release the duck). */
export function speechRegions(voice: Pick<VoiceTrack, "words" | "segments">, mergeGapMs = 320): Region[] {
  const src: Region[] = voice.words.length
    ? voice.words.map((w) => ({ startMs: w.startMs, endMs: w.endMs }))
    : voice.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs }));
  const sorted = src.filter((r) => r.endMs > r.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: Region[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMs - last.endMs <= mergeGapMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

const s3 = (ms: number) => (ms / 1000).toFixed(3);

/**
 * FFmpeg `volume` expression (evaluated per audio frame of 5 ms) for the ducking envelope, or null when there
 * is nothing to duck.
 */
export function duckingExpression(regions: readonly Region[], d: DuckingParams): string | null {
  if (!d.enabled || d.depthDb <= 0 || !regions.length) return null;
  const a = Math.max(5, d.attackMs);
  const r = Math.max(20, d.releaseMs);
  const terms = regions.map(
    (g) => `clip((t-${s3(g.startMs - a)})/${s3(a)},0,1)*clip((${s3(g.endMs + r)}-t)/${s3(r)},0,1)`,
  );
  const s = terms.reduceRight((acc, t) => (acc ? `max(${t},${acc})` : t), "");
  return `pow(10,-${(d.depthDb / 20).toFixed(4)}*${s})`;
}

/** Same envelope evaluated in JS (tests, QA, reports). */
export function duckingGainDb(regions: readonly Region[], d: DuckingParams, tMs: number): number {
  if (!d.enabled || !regions.length) return 0;
  const a = Math.max(5, d.attackMs);
  const r = Math.max(20, d.releaseMs);
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  const s = Math.max(
    ...regions.map((g) => clip((tMs - (g.startMs - a)) / a) * clip((g.endMs + r - tMs) / r)),
  );
  return -d.depthDb * s;
}

export interface AudioMixInput {
  durationMs: number;
  music?: Pick<MusicTrack, "path">;
  musicGainDb: number;
  ducking: DuckingParams;
  voice?: Pick<VoiceTrack, "path" | "words" | "segments">;
  voiceGainDb?: number;
  sfx: readonly Pick<SfxCueFile, "path" | "atMs" | "gainDb">[];
  outWav: string;
}

const STEREO = "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/** Pure: arguments that mix every source into one float WAV of exactly durationMs. */
export function buildMixArgs(m: AudioMixInput): { args: string[]; duckExpr: string | null } {
  const D = s3(m.durationMs);
  const args: string[] = [];
  const graph: string[] = [];
  const labels: string[] = [];
  let n = 0;
  let duckExpr: string | null = null;

  if (m.music) {
    args.push("-i", m.music.path);
    const fadeIn = Math.min(0.25, m.durationMs / 4000);
    const fadeOut = Math.min(0.35, m.durationMs / 4000);
    duckExpr = m.voice ? duckingExpression(speechRegions(m.voice), m.ducking) : null;
    graph.push(
      `[${n}:a]${STEREO},atrim=duration=${D},apad=whole_dur=${D},` +
        `afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${s3(m.durationMs - fadeOut * 1000)}:d=${fadeOut.toFixed(3)},` +
        `volume=${m.musicGainDb.toFixed(2)}dB` +
        (duckExpr ? `,asetnsamples=n=240:p=0,volume='${duckExpr}':eval=frame` : "") +
        `[mus]`,
    );
    labels.push("[mus]");
    n++;
  }
  if (m.voice) {
    args.push("-i", m.voice.path);
    graph.push(
      `[${n}:a]${STEREO},atrim=duration=${D},apad=whole_dur=${D},volume=${(m.voiceGainDb ?? 0).toFixed(2)}dB[vo]`,
    );
    labels.push("[vo]");
    n++;
  }
  m.sfx
    .filter((c) => c.atMs < m.durationMs)
    .forEach((c, k) => {
      args.push("-i", c.path);
      const delay = Math.max(0, Math.round(c.atMs));
      graph.push(
        `[${n}:a]${STEREO},volume=${c.gainDb.toFixed(2)}dB,adelay=delays=${delay}:all=1,apad=whole_dur=${D},atrim=duration=${D}[fx${k}]`,
      );
      labels.push(`[fx${k}]`);
      n++;
    });
  if (!labels.length) {
    args.push("-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${D}`);
    graph.push(`[0:a]atrim=duration=${D}[mix]`);
  } else {
    // the first input is padded to D, so duration=first gives exactly D; normalize=0 keeps every gain as planned
    graph.push(
      `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0,` +
        `alimiter=limit=0.95:attack=5:release=60:level=0,atrim=duration=${D}[mix]`,
    );
  }
  args.push(
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[mix]",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_f32le",
    m.outWav,
  );
  return { args, duckExpr };
}

export interface LoudnessTarget {
  lufs: number;
  truePeakDb: number;
  lra?: number;
}

/**
 * loudnorm aims below the delivery ceiling by `marginDb`: AAC encoding adds inter-sample overshoot, so a
 * −1.5 dBTP delivery spec is mastered at −3 dBTP (same convention as @cre/motion).
 */
export function loudnormTarget(t: LoudnessTarget, marginDb = 1.5): { I: number; TP: number; LRA: number } {
  return { I: t.lufs, TP: t.truePeakDb - marginDb, LRA: t.lra ?? 11 };
}

export function buildLoudnessMeasureArgs(inWav: string, t: { I: number; TP: number; LRA: number }): string[] {
  return [
    "-i",
    inWav,
    "-af",
    `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}:print_format=json`,
    "-f",
    "null",
    "-",
  ];
}

export interface LoudnormMeasured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
  output_i?: string;
  output_tp?: string;
}

export function parseLoudnormJson(stderr: string): LoudnormMeasured {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm printed no measurement");
  const m = JSON.parse(stderr.slice(start, end + 1)) as LoudnormMeasured;
  for (const k of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const) {
    // silence measures as -inf; loudnorm cannot normalise it — the caller keeps the mix as is
    if (!Number.isFinite(Number(m[k]))) throw new Error(`loudnorm measurement ${k}=${m[k]}`);
  }
  return m;
}

export function buildLoudnessApplyArgs(
  inWav: string,
  outWav: string,
  t: { I: number; TP: number; LRA: number },
  m: LoudnormMeasured,
  durationMs: number,
): string[] {
  return [
    "-i",
    inWav,
    "-af",
    `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
      `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json,` +
      `aresample=48000,atrim=duration=${s3(durationMs)}`,
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    outWav,
  ];
}
