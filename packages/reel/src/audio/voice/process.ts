import { decodeAudio, REEL_SR, writeWav16 } from "../pcm.ts";
import { fadeEdges, limit } from "../synth.ts";
import { detectSpeech, type SpeechRegion } from "./align.ts";

/**
 * Post-processing of TTS clips so they sit in a mix and line up on the timeline:
 *   resample to 48 kHz (SoX) → [local voices: rumble high-pass, less 280 Hz mud, +3 dB presence at 3.6 kHz,
 *   gentle 2.8:1 compression, light de-essing] → optional tempo → trim to the speech (40 ms before the first
 *   syllable, 120 ms after the last) → speech level to −19 dBFS RMS, peaks ≤ −1.5 dBFS → 16-bit mono WAV.
 * Every filter string is a constant of this module.
 */

export const VOICE_CHAIN_VERSION = "voice-chain/1";
export const SPEECH_RMS_DB = -19;
const RESAMPLE = "aresample=48000:resampler=soxr";
export const VOICE_FILTERS: readonly string[] = [
  "highpass=f=85:poles=2",
  "equalizer=f=280:t=q:w=1.1:g=-2.5",
  "equalizer=f=3600:t=q:w=0.9:g=3",
  "acompressor=threshold=-21dB:ratio=2.8:attack=6:release=90:makeup=1.5",
  "deesser=i=0.3",
];

/** RMS of the samples inside speech regions */
export function speechRms(
  samples: Float32Array,
  regions: readonly SpeechRegion[],
  sampleRate = REEL_SR,
): number {
  let acc = 0;
  let n = 0;
  for (const r of regions) {
    const a = Math.max(0, Math.round((r.startMs * sampleRate) / 1000));
    const b = Math.min(samples.length, Math.round((r.endMs * sampleRate) / 1000));
    for (let i = a; i < b; i++) acc += samples[i]! * samples[i]!;
    n += Math.max(0, b - a);
  }
  return n ? Math.sqrt(acc / n) : 0;
}

/** set speech to SPEECH_RMS_DB (gain ≤ +15 dB) and keep peaks ≤ −1.5 dBFS — in place */
export function levelSpeech(samples: Float32Array, regions: readonly SpeechRegion[]): void {
  const rms = speechRms(samples, regions);
  if (rms < 1e-6) return;
  const g = Math.min(10 ** (15 / 20), 10 ** (SPEECH_RMS_DB / 20) / rms);
  for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * g;
  const ceiling = 10 ** (-1.5 / 20);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  if (peak > ceiling) limit({ l: samples, r: new Float32Array(samples.length) }, ceiling * 0.98, 3, 60);
}

export interface ProcessedVoice {
  durationMs: number;
  /** ms cut from the start (provider word timings shift by this) */
  trimmedLeadMs: number;
}

export async function processVoice(
  input: string,
  output: string,
  opts: { voiceChain?: boolean; tempo?: number; trim?: boolean; signal?: AbortSignal } = {},
): Promise<ProcessedVoice> {
  const [decoded] = await decodeAudio(input, {
    sampleRate: REEL_SR,
    channels: 1,
    filters: opts.voiceChain === false ? [RESAMPLE] : [RESAMPLE, ...VOICE_FILTERS],
    ...(opts.tempo !== undefined ? { tempo: opts.tempo } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  let samples = decoded!;
  let regions = detectSpeech(samples, REEL_SR);
  let lead = 0;
  if (opts.trim !== false && regions.length) {
    const a = Math.max(0, Math.round(((regions[0]!.startMs - 40) * REEL_SR) / 1000));
    const b = Math.min(
      samples.length,
      Math.round(((regions[regions.length - 1]!.endMs + 120) * REEL_SR) / 1000),
    );
    samples = samples.slice(a, b);
    lead = (a * 1000) / REEL_SR;
    regions = regions.map((r) => ({ startMs: r.startMs - lead, endMs: r.endMs - lead }));
  }
  if (!samples.length) throw new Error("voice clip is empty");
  levelSpeech(samples, regions);
  fadeEdges(samples, 0.004 * REEL_SR, 0.004 * REEL_SR);
  await writeWav16(output, [samples]);
  return { durationMs: Math.round((samples.length * 1000) / REEL_SR), trimmedLeadMs: Math.round(lead) };
}
