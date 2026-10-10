import { sha256Hex } from "@cre/shared";
import type { BlenderProfile, ShotPreset, ShotTechnique } from "../contracts/ids.ts";
import {
  STUDIO_JOB_VERSION,
  StudioJob,
  StudioProfileDefaults,
  type StudioShotSpec,
} from "../contracts/media.ts";
import type { PlanShot, ReelPlan } from "../contracts/plan.ts";
import type { ProductSource } from "../contracts/product.ts";
import { cacheKey } from "../util/cache.ts";
import { plateMove, requiredOverscan, windowTravelX } from "./moves.ts";

/*
 * ReelPlan → StudioJob (the JSON Blender receives). Built by code only: ids are copied from the validated plan,
 * numbers are clamped to the contract's bounds, and the product facts the studio needs (model, real height,
 * whether it emits light) come from the ProductSource — never from a model's free text.
 */

/**
 * Render size per technique, as a share of the reel frame (mirrors tools/blender/studio/profiles.json `plateScale`
 * / `scale` — a unit test keeps them in sync). Measured on 4 vCPU, warm_living, 12 spp:
 *   FAST plate  1080·0.75 × 1920·0.75 × overscan 1.18 = 956×1699   ≈ 22–25 s
 *   FAST frame  540×960 (sequence)                                 ≈ 7.5 s
 * FFmpeg up-scales both to 1080×1920 (lanczos); plates keep ≥ 810 px of detail across the composed frame.
 */
export const STUDIO_RENDER_SCALE: Record<BlenderProfile, { plate: number; sequence: number }> = {
  FAST: { plate: 0.75, sequence: StudioProfileDefaults.FAST.scale },
  QUALITY: { plate: 1, sequence: StudioProfileDefaults.QUALITY.scale },
};

/** Pixel size Blender renders for a shot (same rounding as studio_main.plan_shot). */
export function studioRenderSize(
  output: { width: number; height: number },
  profile: BlenderProfile,
  technique: ShotTechnique,
  overscan: number,
): { width: number; height: number } {
  const scale =
    technique === "sequence" ? STUDIO_RENDER_SCALE[profile].sequence : STUDIO_RENDER_SCALE[profile].plate;
  const o = technique === "sequence" ? 1 : overscan;
  const cw = Math.max(16, Math.round(output.width * scale));
  const ch = Math.max(16, Math.round(output.height * scale));
  return { width: Math.round(cw * o), height: Math.round(ch * o) };
}

/**
 * Presets whose real frames move slowly enough to be rendered at half the profile frame rate and motion-
 * interpolated to the reel fps (measured: 7.5 → 15 fps reconstruction of a slow turntable ≥ 25 dB SSIM, no visible
 * artefacts). QUALITY halves every sequence (30 → 15 fps, interpolated to the reel fps like FAST's 15 fps
 * sequences): a frame costs ~20× a FAST one (4× the pixels, 5× the samples — est. ~200 s on 4 vCPU), so a
 * 3 s shot at the full rate alone would be ~5 h of Blender.
 */
const SLOW_SEQUENCES = new Set<ShotPreset>(["slow_turntable", "floating_product"]);

export function sequenceRenderFps(preset: ShotPreset, profile: BlenderProfile): number {
  const fps = StudioProfileDefaults[profile].sequenceFps;
  if (profile === "QUALITY" || SLOW_SEQUENCES.has(preset)) return Math.max(6, Math.round(fps / 2));
  return fps;
}

/** Overscan of a plate / relight: the profile default, more only when the planned move needs it. */
export function plateOverscan(
  shot: Pick<PlanShot, "preset" | "params" | "technique">,
  profile: BlenderProfile,
): number {
  if (shot.technique === "sequence") return 1;
  const need = requiredOverscan(plateMove(shot.preset, shot.params, shot.technique));
  return Math.min(1.6, Math.max(StudioProfileDefaults[profile].overscan, Math.ceil(need * 100) / 100));
}

/** Sideways travel of a plate's move (composed-frame widths): Blender keeps that margin around the product. */
export function plateTravelX(shot: Pick<PlanShot, "preset" | "params" | "technique">): number {
  if (shot.technique === "sequence") return 0;
  return windowTravelX(plateMove(shot.preset, shot.params, shot.technique));
}

/** PlanShot → StudioShotSpec. */
export function studioShotSpec(shot: PlanShot, profile: BlenderProfile): StudioShotSpec {
  return {
    id: shot.id,
    preset: shot.preset,
    technique: shot.technique,
    durationMs: Math.min(10_000, Math.max(300, shot.durationMs)),
    params: shot.params,
    productAnimation: shot.productAnimation,
    lighting: shot.lighting,
    renderFps: sequenceRenderFps(shot.preset, profile),
    overscan: plateOverscan(shot, profile),
    travelX: plateTravelX(shot),
  };
}

/* ---------------------------------------------------------------- product facts ------------------------ */

const LIGHT_CATEGORY =
  /\b(lamp|lamps|lighting|light|lights|lantern|chandelier|sconce|leuchte|lampe|l[aá]mpara|lampada)\b/i;
const LIGHT_FACT = /\b(LED|bulb|bulbs|lumen|lumens|leuchtmittel|bombilla|lampadina|ampoule)\b/i;

/** Does the product emit light (lamps, LED products)? Same signals as the deterministic product analyzer. */
export function inferEmitsLight(
  product: Pick<ProductSource, "category" | "categoryPath" | "facts">,
): boolean {
  if (LIGHT_CATEGORY.test(`${product.category} ${product.categoryPath ?? ""}`)) return true;
  return product.facts.some(
    (f) => (f.kind === "power" || f.kind === "feature" || f.kind === "included") && LIGHT_FACT.test(f.text),
  );
}

/**
 * Material / object name fragments that glow when the product's light is on. Generic light-part words only
 * ("lamp" would match a whole-product object and make the base glow; Python ignores a hint matching every mesh).
 */
export const DEFAULT_EMISSIVE_HINTS = [
  "shade",
  "bulb",
  "diffuser",
  "lampshade",
  "led",
  "emissive",
  "glow",
] as const;

const LENGTH_UNIT_M: Record<string, number> = {
  m: 1,
  meters: 1,
  metres: 1,
  cm: 0.01,
  centimeters: 0.01,
  centimetres: 0.01,
  mm: 0.001,
  millimeters: 0.001,
  millimetres: 0.001,
  in: 0.0254,
  inch: 0.0254,
  inches: 0.0254,
};

/** Real height (m) of the product: the model's source extent, else a height fact — never guessed. */
export function productRealHeightM(product: Pick<ProductSource, "model3d" | "facts">): number | undefined {
  const plausible = (h: number | undefined) => (h !== undefined && h >= 0.005 && h <= 5 ? h : undefined);
  const fromModel = plausible(product.model3d?.extentM?.z);
  if (fromModel) return Math.round(fromModel * 1e5) / 1e5;
  for (const f of product.facts) {
    if (f.kind !== "dimension" || !/^dim\.height/.test(f.id) || f.value === undefined || !f.unit) continue;
    const m = LENGTH_UNIT_M[f.unit.toLowerCase()];
    const h = m ? plausible(f.value * m) : undefined;
    if (h) return Math.round(h * 1e5) / 1e5;
  }
  return undefined;
}

/**
 * Render seed from the product model only: every locale / A/B variant of a product renders identical pixels for
 * identical shots, so their render cache entries are shared.
 */
export function studioSeed(modelSha: string): number {
  return Number.parseInt(sha256Hex(`studio-seed:${modelSha}`).slice(0, 8), 16) & 0x7fffffff;
}

/* ---------------------------------------------------------------- job ---------------------------------- */

export interface BuildStudioJobOptions {
  /** plan shots to render (default: every `source: "blender"` shot); they must share one environment */
  shots?: readonly PlanShot[];
  /** sha256 of the model file when the ProductSource has none */
  modelSha?: string;
  /** from ProductProfile.traits.emitsLight (default: inferred from the ProductSource) */
  emitsLight?: boolean;
  emissiveHints?: readonly string[];
  realHeightM?: number;
}

/** Blender shots of a plan grouped by environment (one studio job = one set), plan order kept. */
export function blenderShotGroups(plan: Pick<ReelPlan, "shots">): PlanShot[][] {
  const groups = new Map<string, PlanShot[]>();
  for (const s of plan.shots) {
    if (s.source !== "blender") continue;
    const g = groups.get(s.environment) ?? [];
    g.push(s);
    groups.set(s.environment, g);
  }
  return [...groups.values()];
}

export function buildStudioJob(
  plan: ReelPlan,
  product: ProductSource,
  profile: BlenderProfile,
  outDir: string,
  opts: BuildStudioJobOptions = {},
): StudioJob {
  const model = product.model3d;
  if (!model) throw new Error(`product ${product.id} has no 3D model — the studio cannot render it`);
  const modelSha = opts.modelSha ?? model.sha256 ?? plan.product.model3dSha;
  if (!modelSha) throw new Error(`product ${product.id}: model sha256 unknown (pass opts.modelSha)`);
  const shots = opts.shots ?? plan.shots.filter((s) => s.source === "blender");
  if (!shots.length) throw new Error(`plan ${plan.metadata.planId} has no Blender shots`);
  const environment = shots[0]!.environment;
  const mixed = shots.find((s) => s.environment !== environment);
  if (mixed)
    throw new Error(
      `studio job mixes environments (${environment}, ${mixed.environment}) — use blenderShotGroups`,
    );
  const realHeightM = opts.realHeightM ?? productRealHeightM(product);
  const content = {
    product: {
      modelPath: model.path,
      modelSha,
      format: model.format,
      ...(realHeightM ? { realHeightM } : {}),
      emitsLight: opts.emitsLight ?? inferEmitsLight(product),
      emissiveHints: [...(opts.emissiveHints ?? DEFAULT_EMISSIVE_HINTS)].slice(0, 12),
    },
    environment,
    profile,
    camera: plan.camera,
    shots: shots.map((s) => studioShotSpec(s, profile)),
    seed: studioSeed(modelSha),
  };
  return StudioJob.parse({
    version: STUDIO_JOB_VERSION,
    jobKey: cacheKey("studio-job", STUDIO_JOB_VERSION, { ...content, output: plan.resolution }),
    ...content,
    output: { dir: outDir, width: plan.resolution.width, height: plan.resolution.height },
  });
}
