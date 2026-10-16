import type { Recipe3D } from "../contracts/recipe.ts";

/*
 * Render time estimates for routing and budgeting. Defaults are measured, not invented: Blender CPU was timed on
 * the 4-core cloud host (Cycles, OIDN denoise, adaptive sampling — 270 × 480 px, 24 samples ≈ 3.9 s / frame →
 * ≈ 1 290 ms per megapixel·sample). GPU and Unreal defaults are planning assumptions until a station reports real
 * telemetry; recorded telemetry (median of the last renders of the same engine / device / quality) replaces them.
 */

export const QUALITY_PROFILES = {
  preview: { scale: 0.5, samples: 24 },
  production: { scale: 1, samples: 96 },
} as const;

export interface TimingSample {
  engine: "blender" | "unreal";
  device: "CPU" | "GPU";
  quality: "preview" | "production";
  /** Blender: ms per megapixel·sample · Unreal: ms per frame */
  unitMs: number;
}

export const DEFAULT_UNIT_MS: Record<string, number> = {
  "blender:CPU": 1290,
  // assumption (no GPU on the measuring host): a mid-range RTX card renders Cycles ~12× faster than 4 CPU cores
  "blender:GPU": 110,
  // assumptions per frame for Movie Render Queue on a GPU (Lumen, 8 spatial samples preview / 32 production)
  "unreal:GPU:preview": 700,
  "unreal:GPU:production": 2600,
  "unreal:CPU:preview": 60_000,
  "unreal:CPU:production": 240_000,
};

export const STARTUP_MS = { blender: 12_000, unreal: 120_000 } as const;

export interface RenderEstimate {
  frames: number;
  width: number;
  height: number;
  msPerFrame: number;
  totalMs: number;
  source: "telemetry" | "default";
  peakRamMb: number;
}

export function frameCount(durationSec: number, fps: number): number {
  return Math.max(2, Math.ceil(durationSec * fps - 1e-9));
}

export function renderSize(recipe: Pick<Recipe3D, "resolution" | "quality">): [number, number] {
  const s = QUALITY_PROFILES[recipe.quality].scale;
  const [w, h] = recipe.resolution;
  return [Math.max(128, Math.round((w * s) / 2) * 2), Math.max(128, Math.round((h * s) / 2) * 2)];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

export function estimateRender(
  recipe: Recipe3D,
  engine: "blender" | "unreal",
  device: "CPU" | "GPU",
  history: readonly TimingSample[] = [],
): RenderEstimate {
  const frames = frameCount(recipe.durationSec, recipe.fps);
  const [w, h] = renderSize(recipe);
  const samples = QUALITY_PROFILES[recipe.quality].samples;
  const relevant = history.filter(
    (s) =>
      s.engine === engine && s.device === device && (engine === "blender" || s.quality === recipe.quality),
  );
  const fromHistory = relevant.length >= 2 ? median(relevant.slice(-20).map((s) => s.unitMs)) : NaN;
  const key = engine === "blender" ? `blender:${device}` : `unreal:${device}:${recipe.quality}`;
  const unit = Number.isFinite(fromHistory) ? fromHistory : (DEFAULT_UNIT_MS[key] ?? 2000);
  const msPerFrame = engine === "blender" ? (unit * w * h * samples) / 1e6 : unit;
  const extras = recipe.outputs.includes("control_views") && engine === "blender" ? 6 * 0.147 * 12 * unit : 0;
  const totalMs = Math.round(STARTUP_MS[engine] + frames * msPerFrame + extras);
  const peakRamMb = engine === "blender" ? 900 + (w * h * 4 * 6) / 1e6 : 9000;
  return {
    frames,
    width: w,
    height: h,
    msPerFrame: Math.round(msPerFrame),
    totalMs,
    source: Number.isFinite(fromHistory) ? "telemetry" : "default",
    peakRamMb: Math.round(peakRamMb),
  };
}
