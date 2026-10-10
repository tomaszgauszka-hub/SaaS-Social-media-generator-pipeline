import type { WordTime } from "../../contracts/media.ts";
import { decodeAudio } from "../pcm.ts";
import { language, pauseAfter, wordTokens, wordWeight } from "./text.ts";

/**
 * Local, deterministic forced alignment for TTS clips without word timings:
 *
 *   1. energy voice-activity detection on the PCM (10 ms frames, adaptive threshold with hysteresis, short
 *      closures inside words bridged) → speech regions; a fragment shorter than a syllable (a stop release,
 *      the onset of an affricate) joins its nearest neighbour, so no word is forced into it;
 *   2. the script's words are assigned to regions in order by dynamic programming: a region's duration should
 *      match its words' speaking weight (syllables), and pauses should fall after punctuation;
 *   3. inside a region, words share its time by weight; the first / last word snap to the region edges.
 *
 * TTS speech is clean (digital silence between phrases), so region edges are exact and words between them are
 * typically within ~100 ms — enough for word-highlight captions. `estimateWords` is the no-audio fallback.
 */

export interface SpeechRegion {
  startMs: number;
  endMs: number;
}

export interface AlignmentResult {
  words: WordTime[];
  timingsSource: "alignment" | "estimate";
  regions: SpeechRegion[];
  durationMs: number;
}

const FRAME_MS = 10;

/** speech regions of a mono signal */
export function detectSpeech(
  samples: Float32Array,
  sampleRate: number,
  opts: { minGapMs?: number; minRegionMs?: number } = {},
): SpeechRegion[] {
  const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frames = Math.floor(samples.length / frame);
  if (!frames) return [];
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) acc += samples[i]! * samples[i]!;
    db[f] = 10 * Math.log10(acc / frame + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const floor = Math.min(-45, Math.max(-90, sorted[Math.floor(frames * 0.1)]!));
  const loud = sorted[Math.floor(frames * 0.95)]!;
  if (loud < -60) return [];
  const open = Math.max(floor + 12, loud - 32);
  const close = open - 4;
  const raw: [number, number][] = [];
  let start = -1;
  for (let f = 0; f < frames; f++) {
    if (start < 0 && db[f]! > open) start = f;
    else if (start >= 0 && db[f]! < close) {
      raw.push([start, f]);
      start = -1;
    }
  }
  if (start >= 0) raw.push([start, frames]);
  // bridge short closures (stop consonants), drop clicks
  const minGap = (opts.minGapMs ?? 80) / FRAME_MS;
  const minRegion = (opts.minRegionMs ?? 40) / FRAME_MS;
  const merged: [number, number][] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < minGap) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged
    .filter(([a, b]) => b - a >= minRegion)
    .map(([a, b]) => ({ startMs: a * FRAME_MS, endMs: b * FRAME_MS }));
}

/** proportional word timings over a span (punctuation adds pauses) — the no-audio fallback */
export function estimateWords(text: string, durationMs: number, locale = "en", offsetMs = 0): WordTime[] {
  const words = wordTokens(text);
  if (!words.length || durationMs <= 0) return [];
  const lang = language(locale);
  const w = words.map((t) => wordWeight(t, lang));
  const p = words.map((t, i) => (i < words.length - 1 ? pauseAfter(t) : 0));
  const total = w.reduce((s, v) => s + v, 0) + p.reduce((s, v) => s + v, 0);
  const unit = durationMs / Math.max(1e-6, total);
  let t = offsetMs;
  return words.map((text, i) => {
    const start = t;
    const end = start + w[i]! * unit;
    t = end + p[i]! * unit;
    return { text, startMs: Math.round(start), endMs: Math.round(end) };
  });
}

/**
 * Join every region shorter than `minMs` to its nearer neighbour (across a gap ≤ `maxGapMs`): a fragment that
 * short is part of a word (Piper's Polish "Link" can come out as "Lin" 140 ms + a 60 ms "k" release), and the
 * assignment would otherwise have to give it a whole word ("znajdziesz" squeezed into the 60 ms).
 */
export function absorbShortRegions(
  regions: readonly SpeechRegion[],
  minMs = 150,
  maxGapMs = 200,
): SpeechRegion[] {
  const r = regions.map((x) => ({ ...x }));
  const len = (x: SpeechRegion) => x.endMs - x.startMs;
  for (;;) {
    // the shortest fragment with a neighbour close enough (an isolated short region is a word of its own)
    let k = -1;
    let j = -1;
    for (let i = 0; i < r.length; i++) {
      if (len(r[i]!) >= minMs || (k >= 0 && len(r[i]!) >= len(r[k]!))) continue;
      const before = i > 0 ? r[i]!.startMs - r[i - 1]!.endMs : Number.POSITIVE_INFINITY;
      const after = i < r.length - 1 ? r[i + 1]!.startMs - r[i]!.endMs : Number.POSITIVE_INFINITY;
      if (Math.min(before, after) > maxGapMs) continue;
      k = i;
      j = before <= after ? i - 1 : i + 1;
    }
    if (k < 0) return r;
    const a = Math.min(j, k);
    r.splice(a, 2, { startMs: r[a]!.startMs, endMs: r[a + 1]!.endMs });
  }
}

/** merge the closest regions until there are at most `max` */
function mergeRegions(regions: SpeechRegion[], max: number): SpeechRegion[] {
  const r = regions.map((x) => ({ ...x }));
  while (r.length > Math.max(1, max)) {
    let k = 0;
    for (let i = 1; i < r.length - 1; i++)
      if (r[i + 1]!.startMs - r[i]!.endMs < r[k + 1]!.startMs - r[k]!.endMs) k = i;
    r[k] = { startMs: r[k]!.startMs, endMs: r[k + 1]!.endMs };
    r.splice(k + 1, 1);
  }
  return r;
}

/**
 * Assign words (in order) to regions (in order); every region gets ≥ 1 word. Returns, per region, the index
 * of its first word.
 */
export function assignWords(
  weights: readonly number[],
  breaks: readonly number[],
  regions: readonly SpeechRegion[],
): number[] {
  const W = weights.length;
  const R = regions.length;
  const prefix = [0];
  for (const w of weights) prefix.push(prefix[prefix.length - 1]! + w);
  const totalW = prefix[W]!;
  const totalMs = regions.reduce((s, r) => s + (r.endMs - r.startMs), 0);
  const cost = (a: number, b: number, r: number) => {
    // words a..b (inclusive) in region r
    const expected = (totalMs * (prefix[b + 1]! - prefix[a]!)) / totalW;
    const dur = regions[r]!.endMs - regions[r]!.startMs;
    let c = Math.log(Math.max(1, dur) / Math.max(1, expected)) ** 2;
    if (r < R - 1) {
      const gap = regions[r + 1]!.startMs - regions[r]!.endMs;
      // a real pause should follow punctuation
      c += breaks[b]! > 0 ? -0.15 * Math.min(1, gap / 150) : 0.25 * Math.min(1, gap / 150);
    }
    return c;
  };
  const INF = Number.POSITIVE_INFINITY;
  // best[r][b]: words 0..b placed in regions 0..r, region r ends with word b
  const best = Array.from({ length: R }, () => new Float64Array(W).fill(INF));
  const from = Array.from({ length: R }, () => new Int32Array(W).fill(-1));
  for (let b = 0; b <= W - R; b++) best[0]![b] = cost(0, b, 0);
  for (let r = 1; r < R; r++)
    for (let b = r; b <= W - R + r; b++)
      for (let a = r; a <= b; a++) {
        const prev = best[r - 1]![a - 1]!;
        if (prev === INF) continue;
        const v = prev + cost(a, b, r);
        if (v < best[r]![b]!) {
          best[r]![b] = v;
          from[r]![b] = a;
        }
      }
  const starts = new Array<number>(R).fill(0);
  let b = W - 1;
  for (let r = R - 1; r > 0; r--) {
    const a = from[r]![b]!;
    starts[r] = a;
    b = a - 1;
  }
  return starts;
}

/** align a script to mono PCM */
export function alignWordsToPcm(
  samples: Float32Array,
  sampleRate: number,
  text: string,
  locale: string,
): AlignmentResult {
  const durationMs = Math.round((samples.length * 1000) / sampleRate);
  const words = wordTokens(text);
  const detected = detectSpeech(samples, sampleRate);
  if (!words.length || !detected.length) {
    return {
      words: estimateWords(text, durationMs, locale),
      timingsSource: "estimate",
      regions: detected,
      durationMs,
    };
  }
  const lang = language(locale);
  const weights = words.map((w) => wordWeight(w, lang));
  const breaks = words.map((w) => pauseAfter(w));
  const regions = mergeRegions(absorbShortRegions(detected), words.length);
  const starts = assignWords(weights, breaks, regions);
  const out: WordTime[] = [];
  regions.forEach((reg, r) => {
    const a = starts[r]!;
    const b = r + 1 < regions.length ? starts[r + 1]! : words.length;
    const sum = weights.slice(a, b).reduce((s, v) => s + v, 0);
    let t = reg.startMs;
    for (let i = a; i < b; i++) {
      const d = ((reg.endMs - reg.startMs) * weights[i]!) / sum;
      const end = i === b - 1 ? reg.endMs : t + d;
      out.push({ text: words[i]!, startMs: Math.round(t), endMs: Math.round(end) });
      t = end;
    }
  });
  return { words: out, timingsSource: "alignment", regions, durationMs };
}

/** align a script to an audio file (decoded to 16 kHz mono by FFmpeg) */
export async function alignWords(
  audioPath: string,
  text: string,
  locale: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AlignmentResult> {
  const sr = 16_000;
  const [mono] = await decodeAudio(audioPath, {
    sampleRate: sr,
    channels: 1,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return alignWordsToPcm(mono!, sr, text, locale);
}
