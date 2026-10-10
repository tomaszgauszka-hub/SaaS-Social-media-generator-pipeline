import fs from "node:fs";
import path from "node:path";
import { resolveFromRoot } from "@cre/config";
import { sha256Hex } from "@cre/shared";
import type { StudioJob, StudioShotSpec } from "../contracts/media.ts";
import { cacheKey } from "../util/cache.ts";

/*
 * Per-shot render cache. A shot is re-rendered only when something that changes its pixels changes: the model
 * bytes, the studio code (hash of the Python package), the renderer (bpy / Blender version and build), the
 * profile, the set, the camera, the render size, the seed or the shot's own spec. Fields that cannot change the
 * pixels are normalised away so locale / A/B variants and QA retries that only re-time a plate reuse it (a plate's
 * duration lives in the FFmpeg move, not in Blender).
 */

export const STUDIO_SHOT_NAMESPACE = "studio-shot";
export const STUDIO_SHOT_CACHE_VERSION = "studio-shot/2";

/** Directory of the Blender studio package (tools/blender/studio). */
export function studioToolsDir(): string {
  return resolveFromRoot("tools/blender/studio");
}

const codeVersions = new Map<string, string>();

/** Hash of the studio's Python modules + render profiles (tests excluded) — part of every render cache key. */
export function studioCodeVersion(dir = studioToolsDir()): string {
  let v = codeVersions.get(dir);
  if (!v) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => (f.endsWith(".py") && !f.startsWith("test_")) || f === "profiles.json")
      .sort();
    if (!files.includes("run.py")) throw new Error(`no Blender studio at ${dir}`);
    const h = files.map((f) => `${f}:${sha256Hex(fs.readFileSync(path.join(dir, f)))}`).join("\n");
    v = sha256Hex(h).slice(0, 16);
    codeVersions.set(dir, v);
  }
  return v;
}

/** Overrides for tests / previews (samples, render scale) — they change pixels, so they are part of the key. */
export interface StudioOverrides {
  samples?: number;
  /** multiplies the profile's render scale (0.05–1) */
  scale?: number;
}

/** What determines a shot's rendered pixels (normalised spec — no id, no fields the technique ignores). */
export function shotRenderInputs(shot: StudioShotSpec, job: StudioJob): Record<string, unknown> {
  const sequence = shot.technique === "sequence";
  return {
    model: { sha: job.product.modelSha, format: job.product.format },
    product: {
      realHeightM: job.product.realHeightM ?? null,
      emitsLight: job.product.emitsLight,
      emissiveHints: job.product.emitsLight
        ? [...job.product.emissiveHints].map((h) => h.toLowerCase()).sort()
        : [],
    },
    environment: job.environment,
    profile: job.profile,
    output: { width: job.output.width, height: job.output.height },
    camera: {
      lensMm: job.camera.lensMm,
      dof: job.camera.dof.enabled ? job.camera.dof.fStop : false,
      motionBlur: sequence && job.camera.motionBlur,
    },
    seed: job.seed,
    shot: {
      preset: shot.preset,
      technique: shot.technique,
      params: shot.params,
      productAnimation: shot.productAnimation,
      lighting: shot.lighting,
      ...(sequence
        ? { durationMs: shot.durationMs, renderFps: shot.renderFps }
        : { overscan: shot.overscan, travelX: shot.travelX ?? 0 }),
    },
  };
}

export function studioCacheKey(
  shot: StudioShotSpec,
  job: StudioJob,
  /** renderer: studioRendererVersion() of the Blender that renders (or rendered) the shot */
  opts: { codeVersion?: string; renderer: string; overrides?: StudioOverrides },
): string {
  return cacheKey(STUDIO_SHOT_NAMESPACE, STUDIO_SHOT_CACHE_VERSION, {
    code: opts.codeVersion ?? studioCodeVersion(),
    renderer: opts.renderer,
    ...shotRenderInputs(shot, job),
    overrides: opts.overrides ?? {},
  });
}
