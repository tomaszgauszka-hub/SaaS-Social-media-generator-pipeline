import type { MusicIntent } from "../../contracts/plan.ts";
import { correlation, onsetStrength, toDb } from "../analysis.ts";
import { decodeAudio, REEL_SR, writeWav16, type Channels } from "../pcm.ts";
import { energyFunction, resolveEvents } from "./arrange.ts";

/**
 * fitMusicToTimeline — makes music of ANY length (an API song, a library track) fit one reel exactly:
 *
 *   1. decode to 48 kHz stereo (time-stretched with atempo when the source BPM differs from the intent);
 *   2. find the musical start (first window within 26 dB of the loudest) and lay the bar grid from there;
 *   3. a source shorter than the reel is extended by looping whole bars with short equal-power crossfades;
 *   4. choose the window start: bar-aligned candidates + "final-hit" candidates (a strong onset placed exactly
 *      on the intent's final_hit), scored by hit strength, energy-curve correlation and bar alignment;
 *   5. cut exactly targetMs, fade in / out (short after an aligned final hit, so its tail rings), keep the
 *      peak ≤ −1 dBFS, write 16-bit 48 kHz stereo WAV.
 */

export const MUSIC_FIT_VERSION = "music-fit/1";

export interface FitResult {
  path: string;
  durationMs: number;
  /** window start in the (stretched / extended) source */
  startMs: number;
  /** a strong onset of the source lands on the intent's final hit (± 10 ms) */
  finalHitAligned: boolean;
  /** the source was shorter than the reel and was extended by looping bars */
  looped: boolean;
  /** atempo ratio applied (1 = none) */
  tempoRatio: number;
}

const HOP = Math.round(0.01 * REEL_SR);

function windowLevels(mono: Float32Array, win: number): number[] {
  const out: number[] = [];
  for (let s = 0; s + win <= mono.length; s += win) {
    let acc = 0;
    for (let i = s; i < s + win; i++) acc += mono[i]! * mono[i]!;
    out.push(Math.sqrt(acc / win));
  }
  return out;
}

function monoOf(ch: Channels): Float32Array {
  const n = ch[0]!.length;
  const out = new Float32Array(n);
  for (const c of ch) for (let i = 0; i < n; i++) out[i]! += c[i]! / ch.length;
  return out;
}

/** first sample where the music really starts (50 ms window within 26 dB of the loudest window) */
export function musicalStart(mono: Float32Array): number {
  const win = Math.round(0.05 * REEL_SR);
  const lv = windowLevels(mono, win);
  const max = Math.max(0, ...lv);
  const k = lv.findIndex((v) => v > max * 0.05);
  return k > 0 ? k * win : 0;
}

/** extend `src` (from `start`) to at least `minLength` samples by looping whole bars with 25 ms crossfades */
export function loopBars(src: Channels, start: number, bar: number, minLength: number): Channels {
  const n = src[0]!.length;
  const bars = Math.floor((n - start) / bar);
  // loop body: bars 1 … last (keep the first bar as the intro) — or everything when the source is tiny
  const bodyStart = bars >= 3 ? start + Math.round(bar) : start;
  const bodyEnd = bars >= 2 ? start + Math.round(bars * bar) : n;
  const body = bodyEnd - bodyStart;
  const xf = Math.min(Math.round(0.025 * REEL_SR), Math.floor(body / 4));
  const out = src.map(() => new Float32Array(Math.max(minLength, n - start) + body + xf));
  for (let c = 0; c < src.length; c++) out[c]!.set(src[c]!.subarray(start, bodyEnd), 0);
  let w = bodyEnd - start;
  while (w < minLength) {
    // equal-power crossfade of the loop start into the running tail
    for (let c = 0; c < src.length; c++) {
      const o = out[c]!;
      const s = src[c]!;
      for (let i = 0; i < xf; i++) {
        const a = Math.cos(((i / xf) * Math.PI) / 2);
        const b = Math.sin(((i / xf) * Math.PI) / 2);
        o[w - xf + i] = o[w - xf + i]! * a + s[bodyStart + i]! * b;
      }
      o.set(s.subarray(bodyStart + xf, bodyEnd), w);
    }
    w += body - xf;
  }
  return out.map((o) => o.subarray(0, w));
}

interface Candidate {
  start: number;
  score: number;
  hit: boolean;
}

export async function fitMusicToTimeline(
  sourcePath: string,
  intent: MusicIntent,
  targetMs: number,
  opts: { outPath: string; sourceBpm?: number; signal?: AbortSignal },
): Promise<FitResult> {
  const tempoRatio = opts.sourceBpm && opts.sourceBpm > 0 ? intent.bpm / opts.sourceBpm : 1;
  const decoded = await decodeAudio(sourcePath, {
    channels: 2,
    tempo: tempoRatio,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const T = Math.round((targetMs * REEL_SR) / 1000);
  const bar = (4 * 60 * REEL_SR) / intent.bpm;
  let src = decoded;
  let mono = monoOf(src);
  let s0 = musicalStart(mono);
  let looped = false;
  if (src[0]!.length - s0 < T) {
    src = loopBars(src, s0, bar, T + Math.round(bar));
    mono = monoOf(src);
    s0 = 0;
    looped = true;
  }
  const N = src[0]!.length;
  const lastStart = N - T;

  // onset strength (10 ms hops, broadband + kick band) normalised to its maximum
  const onset = onsetStrength(mono, HOP);
  const low = onsetStrength(mono, HOP, 160);
  const strength = Array.from(onset, (v, i) => v + (low[i] ?? 0));
  const maxStrength = Math.max(1e-6, ...strength);
  const strengthAt = (sample: number) => {
    const k = Math.round(sample / HOP);
    let best = 0;
    for (let j = k - 1; j <= k + 1; j++) best = Math.max(best, strength[j] ?? 0);
    return best / maxStrength;
  };
  const finalHitMs = resolveEvents({ ...intent, durationMs: targetMs }).finalHitMs;
  const F = finalHitMs !== undefined ? Math.round((finalHitMs * REEL_SR) / 1000) : undefined;
  const hasCurve = intent.events.some((e) => e.energy !== undefined);
  const energyAt = energyFunction({ ...intent, durationMs: targetMs });
  const beat = bar / 4;
  const beats = Math.max(1, Math.floor(T / beat));
  const curve = Array.from({ length: beats }, (_, k) => energyAt(((k + 0.5) * beat * 1000) / REEL_SR));
  const levelDb = (from: number, to: number) => {
    let acc = 0;
    for (let i = from; i < to; i++) acc += mono[i]! * mono[i]!;
    return toDb(Math.sqrt(acc / Math.max(1, to - from)));
  };

  const score = (start: number): Candidate => {
    const hitStrength = F !== undefined ? strengthAt(start + F) : 0;
    const corr = hasCurve
      ? correlation(
          curve,
          Array.from({ length: beats }, (_, k) =>
            levelDb(start + Math.round(k * beat), start + Math.round((k + 1) * beat)),
          ),
        )
      : 0;
    const off = (((start - s0) % bar) + bar) % bar;
    const misalign = Math.min(off, bar - off) / bar;
    return { start, score: 2 * hitStrength + corr - misalign, hit: hitStrength >= 0.5 };
  };

  const starts = new Set<number>();
  for (let k = 0; s0 + Math.round(k * bar) <= lastStart; k++) starts.add(s0 + Math.round(k * bar));
  if (F !== undefined) {
    // the strongest onsets of the source, each placed exactly on the final hit
    const peaks = strength
      .map((v, i) => ({ v, at: i * HOP }))
      .filter((p, i) => p.v > (strength[i - 1] ?? 0) && p.v >= (strength[i + 1] ?? 0))
      .sort((a, b) => b.v - a.v)
      .slice(0, 12);
    for (const p of peaks) if (p.at - F >= s0 && p.at - F <= lastStart) starts.add(p.at - F);
  }
  if (!starts.size) starts.add(Math.max(0, Math.min(s0, lastStart)));
  const best = [...starts].map(score).sort((a, b) => b.score - a.score || a.start - b.start)[0]!;

  // cut, fades, peak safety
  const out = src.map((c) => Float32Array.from(c.subarray(best.start, best.start + T)));
  const fadeIn = Math.round((best.start > s0 ? 0.012 : 0.003) * REEL_SR);
  const aligned = F !== undefined && best.hit;
  const fadeOut = Math.round(
    aligned ? Math.min(0.3 * REEL_SR, (T - F) / 2) : Math.min(1.0 * REEL_SR, T * 0.12),
  );
  let peak = 0;
  for (const c of out) {
    for (let i = 0; i < fadeIn && i < T; i++) c[i] = c[i]! * (i / fadeIn);
    for (let i = 0; i < fadeOut; i++) c[T - 1 - i] = c[T - 1 - i]! * (i / fadeOut);
    for (let i = 0; i < T; i++) peak = Math.max(peak, Math.abs(c[i]!));
  }
  const ceiling = 10 ** (-1 / 20);
  if (peak > ceiling) for (const c of out) for (let i = 0; i < T; i++) c[i] = (c[i]! * ceiling) / peak;
  await writeWav16(opts.outPath, out);
  return {
    path: opts.outPath,
    durationMs: targetMs,
    startMs: Math.round((best.start * 1000) / REEL_SR),
    finalHitAligned: aligned,
    looped,
    tempoRatio,
  };
}
