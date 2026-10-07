import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { FatalError, RetryableError } from "@cre/shared";

/**
 * Thin, well-behaved FFmpeg/FFprobe process wrapper:
 *  - never uses a shell (arguments are passed verbatim → no injection)
 *  - honours AbortSignal (kills the process)
 *  - keeps only the tail of stderr for error messages
 */
export interface FfmpegConfig {
  ffmpegPath: string;
  ffprobePath: string;
  /** Directory with font files for libass (optional; fontconfig is used otherwise). */
  fontsDir?: string;
}

let config: FfmpegConfig = {
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
  fontsDir: process.env.MEDIA_FONTS_DIR ?? detectFontsDir(),
};

function detectFontsDir(): string | undefined {
  for (const dir of ["/usr/share/fonts/opentype/inter", "/usr/share/fonts/truetype/inter"]) {
    if (fs.existsSync(/*turbopackIgnore: true*/ dir)) return dir;
  }
  return undefined;
}

export function configureFfmpeg(partial: Partial<FfmpegConfig>): void {
  config = { ...config, ...partial };
}

export function getFfmpegConfig(): FfmpegConfig {
  return config;
}

export class FfmpegError extends FatalError {
  readonly stderrTail: string;
  readonly exitCode: number | null;

  constructor(message: string, stderrTail: string, exitCode: number | null) {
    super(`${message}${stderrTail ? `\n${stderrTail}` : ""}`, { code: "FFMPEG_ERROR" });
    this.stderrTail = stderrTail;
    this.exitCode = exitCode;
  }
}

const STDERR_LIMIT = 64 * 1024;

export interface RunOptions {
  signal?: AbortSignal;
  cwd?: string;
  /** ffmpeg -loglevel; "error" by default, "info" when parsing filter output (blackdetect …) */
  logLevel?: "quiet" | "error" | "warning" | "info";
}

function run(bin: string, args: string[], opts: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > STDERR_LIMIT * 2) stderr = stderr.slice(-STDERR_LIMIT);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.name === "AbortError") reject(new RetryableError(`${bin} aborted`, { cause: err }));
      else if (err.code === "ENOENT")
        reject(new FatalError(`${bin} not found — install FFmpeg`, { cause: err }));
      else reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-12).join("\n");
        reject(new FfmpegError(`${bin} exited with code ${code}`, tail, code));
      }
    });
  });
}

export async function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<{ stderr: string }> {
  const { stderr } = await run(
    config.ffmpegPath,
    ["-hide_banner", "-nostdin", "-y", "-loglevel", opts.logLevel ?? "error", ...args],
    opts,
  );
  return { stderr };
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; size?: string; format_name?: string; bit_rate?: string };
}

export interface MediaInfo {
  durationMs: number;
  sizeBytes: number;
  formatName?: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  pixFmt?: string;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  bitRate?: number;
}

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return undefined;
  return Math.round((num / den) * 1000) / 1000;
}

export async function probeMedia(path: string, opts: RunOptions = {}): Promise<MediaInfo> {
  const { stdout } = await run(
    config.ffprobePath,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    opts,
  );
  const data = JSON.parse(stdout) as FfprobeOutput;
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const durationSec = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const info: MediaInfo = {
    durationMs: Math.round((Number.isFinite(durationSec) ? durationSec : 0) * 1000),
    sizeBytes: Number(data.format?.size ?? fs.statSync(path).size),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
  if (data.format?.format_name) info.formatName = data.format.format_name;
  if (data.format?.bit_rate) info.bitRate = Number(data.format.bit_rate);
  if (video) {
    if (video.width) info.width = video.width;
    if (video.height) info.height = video.height;
    const fps = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate);
    if (fps) info.fps = fps;
    if (video.codec_name) info.videoCodec = video.codec_name;
    if (video.pix_fmt) info.pixFmt = video.pix_fmt;
  }
  if (audio) {
    if (audio.codec_name) info.audioCodec = audio.codec_name;
    if (audio.sample_rate) info.audioSampleRate = Number(audio.sample_rate);
    if (audio.channels) info.audioChannels = audio.channels;
  }
  return info;
}

export interface FfmpegCapabilities {
  ok: boolean;
  version?: string;
  missingFilters: string[];
  fontsDir?: string;
}

const REQUIRED_FILTERS = [
  "zoompan",
  "xfade",
  "ass",
  "overlay",
  "gradients",
  "sidechaincompress",
  "amix",
  "loudnorm",
  "blackdetect",
  "drawtext",
];

let capabilitiesCache: FfmpegCapabilities | undefined;

export async function checkFfmpeg(): Promise<FfmpegCapabilities> {
  if (capabilitiesCache) return capabilitiesCache;
  try {
    const { stdout: versionOut } = await run(config.ffmpegPath, ["-hide_banner", "-version"], {});
    const { stdout: filtersOut } = await run(config.ffmpegPath, ["-hide_banner", "-filters"], {});
    const available = new Set(
      filtersOut
        .split("\n")
        .map((l) => l.trim().split(/\s+/)[1])
        .filter((x): x is string => Boolean(x)),
    );
    const missingFilters = REQUIRED_FILTERS.filter((f) => !available.has(f));
    capabilitiesCache = {
      ok: missingFilters.length === 0,
      version: versionOut.split("\n")[0]?.trim(),
      missingFilters,
      ...(config.fontsDir ? { fontsDir: config.fontsDir } : {}),
    };
  } catch {
    capabilitiesCache = { ok: false, missingFilters: REQUIRED_FILTERS };
  }
  return capabilitiesCache;
}

/** Quote a value for use inside an FFmpeg filtergraph option (single-quote escaping). */
export function filterQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** ffmpeg colour from #RRGGBB (+ optional alpha 0..1). */
export function ffColor(hex: string, alpha?: number): string {
  const clean = hex.replace(/^#/, "");
  return `0x${clean}${alpha !== undefined ? `@${alpha.toFixed(3)}` : ""}`;
}

const fontCache = new Map<string, string | null>();

/**
 * Resolve a fontconfig pattern (e.g. "Inter:style=Bold") to a font file path for drawtext.
 * Using `fontfile=` avoids FFmpeg's double escaping of fontconfig patterns. Returns null when unavailable.
 */
export function resolveFontFile(pattern: string): string | null {
  if (fontCache.has(pattern)) return fontCache.get(pattern) ?? null;
  let file: string | null;
  try {
    const out = execFileSync("fc-match", ["-f", "%{file}", pattern], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    file = out && fs.existsSync(out) ? out : null;
  } catch {
    file = null;
  }
  fontCache.set(pattern, file);
  return file;
}

/** drawtext font option: `fontfile='…'` when resolvable, otherwise empty (FFmpeg default font). */
export function drawtextFont(pattern: string): string {
  const file = resolveFontFile(pattern);
  return file ? `fontfile=${filterQuote(file)}:` : "";
}
