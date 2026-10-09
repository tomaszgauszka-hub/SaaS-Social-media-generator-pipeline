import fsp from "node:fs/promises";
import path from "node:path";
import { FatalError } from "@cre/shared";

/*
 * Byte-level helpers for the Google client: MIME types of local files, inline-size limits, WAV wrapping of raw
 * PCM, image dimensions from headers, protobuf Duration strings. Pure and synchronous where possible.
 */

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

export function mimeTypeOf(file: string): string {
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mime) throw new FatalError(`unsupported file type for Google inline data: ${path.basename(file)}`);
  return mime;
}

export function extensionForMime(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  // first extension listed for the type (".jpg" before ".jpeg")
  return Object.entries(MIME_BY_EXT).find(([, m]) => m === base)?.[0] ?? ".bin";
}

/** Tracks the inline bytes of one request against the API's request-size limit. */
export class InlineBudget {
  private used = 0;
  constructor(readonly maxBytes: number) {}

  add(bytes: number, what: string): void {
    this.used += bytes;
    if (this.used > this.maxBytes) {
      throw new FatalError(
        `${what}: inline data ${(this.used / 1e6).toFixed(1)} MB exceeds the ${(this.maxBytes / 1e6).toFixed(0)} MB request limit — use smaller files`,
      );
    }
  }
}

/** Read a local file for inlining (size-checked before reading). */
export async function readInline(
  file: string,
  budget: InlineBudget,
  mimeType?: string,
): Promise<{ data: Buffer; mimeType: string }> {
  const mime = mimeType ?? mimeTypeOf(file);
  const stat = await fsp.stat(file).catch((err: unknown) => {
    throw new FatalError(`cannot read ${path.basename(file)}: ${(err as Error).message}`);
  });
  if (!stat.isFile()) throw new FatalError(`not a file: ${path.basename(file)}`);
  budget.add(stat.size, path.basename(file));
  return { data: await fsp.readFile(file), mimeType: mime };
}

/* ---------------------------------------------------------------- WAV ----------------------------- */

export function isRiffWave(buf: Buffer): boolean {
  return (
    buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE"
  );
}

/** Wrap raw little-endian PCM in a canonical 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = (channels * bitsPerSample) / 8;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** byte offset of the PCM samples (after the `data` chunk header) */
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
}

/** Parse the fmt / data chunks of a RIFF WAVE file (tolerates extra chunks such as LIST). */
export function parseWav(buf: Buffer): WavInfo | undefined {
  if (!isRiffWave(buf)) return undefined;
  let off = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    if (id === "fmt " && off + 24 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === "data" && fmt) {
      // streamed WAVs may carry 0 / 0xFFFFFFFF as the data size
      if (size === 0 || size === 0xffffffff || off + 8 + size > buf.length) size = buf.length - off - 8;
      const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return {
        ...fmt,
        dataOffset: off + 8,
        dataBytes: size,
        durationMs: bytesPerSec ? Math.round((size / bytesPerSec) * 1000) : 0,
      };
    }
    off += 8 + size + (size % 2);
  }
  return undefined;
}

/**
 * Gemini TTS returns WAV (RIFF) from unary 3.8 models and raw 16-bit PCM ("audio/L16;codec=pcm;rate=24000")
 * from older / streaming models. Always hand back a WAV.
 */
export function toWav(data: Buffer, mimeType: string): { wav: Buffer; sampleRate: number } {
  if (isRiffWave(data)) return { wav: data, sampleRate: parseWav(data)?.sampleRate ?? 24_000 };
  const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24_000);
  const channels = Number(/channels=(\d+)/i.exec(mimeType)?.[1] ?? 1);
  return { wav: pcmToWav(data, rate, channels), sampleRate: rate };
}

/** The PCM samples of a WAV plus its format (undefined when `buf` is not a RIFF WAVE). */
export function wavPcm(buf: Buffer): { info: WavInfo; pcm: Buffer } | undefined {
  const info = parseWav(buf);
  return info ? { info, pcm: buf.subarray(info.dataOffset, info.dataOffset + info.dataBytes) } : undefined;
}

/* ---------------------------------------------------------------- images -------------------------- */

/** Width/height from a PNG, JPEG or WebP header (undefined for other formats). */
export function imageDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1] ?? 0;
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
    return undefined;
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8 ")
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return undefined;
}

/* ---------------------------------------------------------------- durations ----------------------- */

/** protobuf Duration ("1.240s"), a number of seconds, or { seconds, nanos } → milliseconds. */
export function durationToMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 1000);
  if (typeof value === "string") {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*s?\s*$/.exec(value);
    return m ? Math.round(Number(m[1]) * 1000) : undefined;
  }
  if (value && typeof value === "object") {
    const v = value as { seconds?: unknown; nanos?: unknown };
    const s = Number(v.seconds ?? 0);
    const n = Number(v.nanos ?? 0);
    if (Number.isFinite(s) && Number.isFinite(n)) return Math.round(s * 1000 + n / 1e6);
  }
  return undefined;
}
