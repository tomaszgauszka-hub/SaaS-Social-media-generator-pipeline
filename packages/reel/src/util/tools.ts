import fs from "node:fs";
import { getEnv, resolveFromRoot, type Env } from "@cre/config";

/** Local tool locations and directories, resolved from configuration (never from model output). */
export interface ReelTools {
  blenderPython: string | null;
  blenderBin: string | null;
  blenderThreads: number;
  blenderMaxConcurrent: number;
  piperBin: string | null;
  piperVoicesDir: string | null;
  ffmpeg: string;
  ffprobe: string;
  cacheDir: string;
  outputDir: string;
  workDir: string;
}

export function resolveReelTools(env: Env = getEnv()): ReelTools {
  const existing = (p: string | undefined) => {
    if (!p) return null;
    const abs = resolveFromRoot(p);
    return fs.existsSync(abs) ? abs : null;
  };
  return {
    blenderPython: existing(env.BLENDER_PYTHON),
    blenderBin: existing(env.BLENDER_BIN),
    blenderThreads: env.BLENDER_THREADS,
    blenderMaxConcurrent: env.BLENDER_MAX_CONCURRENT,
    piperBin: existing(env.PIPER_BIN),
    piperVoicesDir: existing(env.PIPER_VOICES_DIR),
    ffmpeg: env.FFMPEG_PATH,
    ffprobe: env.FFPROBE_PATH,
    cacheDir: resolveFromRoot(env.REEL_CACHE_DIR),
    outputDir: resolveFromRoot(env.REEL_OUTPUT_DIR),
    workDir: resolveFromRoot(env.WORK_DIR),
  };
}
