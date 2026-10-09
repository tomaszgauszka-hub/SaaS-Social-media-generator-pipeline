import { biquad } from "./synth.ts";

/**
 * Small, deterministic signal measurements used by the audio pipeline itself (alignment, music fitting) and by
 * its tests / QA: windowed RMS, onset strength, octave-band profile, peak. Everything works on mono Float32 at
 * 48 kHz unless a sample rate is passed.
 */

export function toDb(x: number): number {
  return 20 * Math.log10(Math.max(1e-9, x));
}

/** RMS of x[from, to) */
export function rmsOf(x: Float32Array, from = 0, to = x.length): number {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(x.length, Math.floor(to));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (b - a));
}

/** RMS per window (`win` samples, `hop` samples apart) */
export function windowRms(x: Float32Array, win: number, hop = win): Float32Array {
  const frames = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) out[f] = rmsOf(x, f * hop, f * hop + win);
  return out;
}

export function peakAbs(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}

/** average of channels */
export function mixdown(channels: readonly Float32Array[]): Float32Array {
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i]! += ch[i]! / channels.length;
  return out;
}

/**
 * Onset strength per hop: positive change of log energy between consecutive hops (optionally of a low-passed
 * copy, e.g. 150 Hz for kick drums). Peaks mark note / hit onsets.
 */
export function onsetStrength(x: Float32Array, hop: number, lowpassHz?: number): Float32Array {
  const src = lowpassHz
    ? biquad(biquad(Float32Array.from(x), "lowpass", lowpassHz), "lowpass", lowpassHz)
    : x;
  const e = windowRms(src, hop, hop);
  const out = new Float32Array(e.length);
  for (let i = 1; i < e.length; i++) out[i] = Math.max(0, toDb(e[i]!) - toDb(e[i - 1]!));
  return out;
}

/** octave-ish band centres used for spectral profiles */
export const PROFILE_BANDS = [60, 150, 400, 1000, 2500, 6000, 12000] as const;

/** share of energy per band (sums to 1) — a cheap spectral fingerprint without an FFT */
export function bandProfile(x: Float32Array, bands: readonly number[] = PROFILE_BANDS): number[] {
  const e = bands.map((fc) => {
    const y = biquad(Float32Array.from(x), "bandpass", fc, 1.2);
    let s = 0;
    for (let i = 0; i < y.length; i++) s += y[i]! * y[i]!;
    return s;
  });
  const total = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((v) => v / total);
}

/** spectral centroid estimate from the band profile (Hz) */
export function profileCentroid(
  profile: readonly number[],
  bands: readonly number[] = PROFILE_BANDS,
): number {
  return profile.reduce((s, p, i) => s + p * bands[i]!, 0);
}

/** Pearson correlation */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
