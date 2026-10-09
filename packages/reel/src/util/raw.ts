import { execFile } from "node:child_process";
import { getFfmpegConfig } from "@cre/media";

/**
 * Decode an image / video frame to raw pixels with FFmpeg (no shell): `vf` must end in a pixel format
 * (e.g. "scale=32:32,format=rgb24"). Used for palettes, packshot detection and colour checks.
 */
export function decodeRaw(
  file: string,
  vf: string,
  opts: { seekMs?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Buffer> {
  const args = [
    "-v",
    "error",
    ...(opts.seekMs !== undefined ? ["-ss", (opts.seekMs / 1000).toFixed(3)] : []),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    vf,
    "-f",
    "rawvideo",
    "-",
  ];
  return new Promise((resolve, reject) => {
    execFile(
      getFfmpegConfig().ffmpegPath,
      args,
      {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 30_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout) =>
        err ? reject(new Error(`ffmpeg decode failed: ${err.message}`, { cause: err })) : resolve(stdout),
    );
  });
}
