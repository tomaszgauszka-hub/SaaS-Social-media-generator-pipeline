import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { getFfmpegConfig } from "@cre/media";

/**
 * PCM in / out for the audio pipeline. Decoding goes through FFmpeg (any container / codec → raw float32 on
 * stdout, no shell, no temp file); encoding writes 16-bit PCM WAV directly. All audio the pipeline produces is
 * 48 kHz (the reel's rate).
 */

export const REEL_SR = 48_000;

/** decoded audio: one Float32Array per channel */
export type Channels = Float32Array[];

/**
 * Decode any audio file FFmpeg can read to float32 PCM at `sampleRate` with `channels` channels
 * (FFmpeg resamples / up- or down-mixes). `tempo` time-stretches without changing pitch (atempo, 0.5–2).
 * `filters` are FFmpeg audio filters built by CODE from constants and numbers (never from model / user text).
 */
export function decodeAudio(
  file: string,
  opts: {
    sampleRate?: number;
    channels?: 1 | 2;
    tempo?: number;
    filters?: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<Channels> {
  const ch = opts.channels ?? 1;
  const tempo = opts.tempo ?? 1;
  if (!(tempo >= 0.5 && tempo <= 2))
    return Promise.reject(new Error(`decodeAudio: tempo ${tempo} out of range`));
  const chain = [
    ...(opts.filters ?? []),
    ...(Math.abs(tempo - 1) > 1e-6 ? [`atempo=${tempo.toFixed(6)}`] : []),
  ];
  const args = [
    "-v",
    "error",
    "-nostdin",
    "-i",
    file,
    "-vn",
    ...(chain.length ? ["-af", chain.join(",")] : []),
    "-ac",
    String(ch),
    "-ar",
    String(opts.sampleRate ?? REEL_SR),
    "-f",
    "f32le",
    "-",
  ];
  return new Promise((resolve, reject) => {
    execFile(
      getFfmpegConfig().ffmpegPath,
      args,
      {
        encoding: "buffer",
        maxBuffer: 512 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 120_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `cannot decode ${path.basename(file)}: ${stderr.toString().slice(-400) || err.message}`,
            ),
          );
          return;
        }
        resolve(deinterleave(stdout, ch));
      },
    );
  });
}

/** little-endian float32 interleaved bytes → channels */
export function deinterleave(buf: Buffer, channels: number): Channels {
  const frames = Math.floor(buf.length / (4 * channels));
  // copy into an aligned buffer (the platform is little-endian, like f32le)
  const all = new Float32Array(frames * channels);
  Buffer.from(all.buffer).set(buf.subarray(0, frames * channels * 4));
  if (channels === 1) return [all];
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c]![i] = all[i * channels + c]!;
  return out;
}

/** 16-bit PCM WAV (1 or 2 channels), samples clamped to ±1 */
export function encodeWav16(channels: Channels, sampleRate = REEL_SR): Buffer {
  const ch = channels.length;
  if (ch < 1 || ch > 2) throw new Error(`encodeWav16: ${ch} channels`);
  const n = channels[0]!.length;
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!));
      data.writeInt16LE(Math.round(v * 32767), (i * ch + c) * 2);
    }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(ch, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * ch * 2, 28);
  header.writeUInt16LE(ch * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export async function writeWav16(file: string, channels: Channels, sampleRate = REEL_SR): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, encodeWav16(channels, sampleRate));
}

/** samples for a duration at the reel rate (ms are integers → exact) */
export const msToSamples = (ms: number, sampleRate = REEL_SR) => Math.round((ms * sampleRate) / 1000);
export const samplesToMs = (n: number, sampleRate = REEL_SR) => (n * 1000) / sampleRate;
