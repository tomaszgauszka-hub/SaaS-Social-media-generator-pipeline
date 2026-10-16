import type { Asset3D } from "../contracts/asset.ts";
import type { EngineCapabilities } from "../contracts/engine.ts";
import {
  blenderEquivalent,
  isUnrealTemplate,
  Recipe3D,
  STRUCTURAL_TEMPLATES,
  unrealEquivalent,
  type Recipe3DInput,
} from "../contracts/recipe.ts";
import { recipeHash, visualKey } from "../cache/keys.ts";
import { localRenderCost, type LocalCostAssumptions } from "../cost/local.ts";
import { estimateRender, type RenderEstimate, type TimingSample } from "./estimate.ts";

/*
 * 3D Render Router: picks the cheapest way to obtain a clip that still serves the beat, in this order
 *   1 existing clip in the library (same recipe → same pixels)
 *   2 re-render of an existing model / scene (no new model is ever built when one exists)
 *   3 local 2D animation through the existing pipeline (no model, low value, or 3D not justified)
 *   4 Blender with an existing model and template
 *   5 Blender with a procedural model (demo products only)
 *   6 Unreal Engine with a reusable scene (cinematic templates only — never for a plain turntable)
 *   7 external AI generation — only when allowed and within budget (BudgetGuard), never chosen silently
 * and explains every decision (reasons + rejected alternatives). It is pure: capabilities, library lookups,
 * telemetry and settings come in as arguments.
 */

export type RouteEngine =
  | "EXISTING_ASSET"
  | "BLENDER"
  | "UNREAL"
  | "PROGRAMMATIC_2D"
  | "EXTERNAL_AI"
  /** a needed engine is offline: the job waits (safe, resumable) */
  | "DEFER"
  /** the request breaks a policy (structure not verified, no licence) — nothing is rendered */
  | "BLOCKED";

export interface RouterSettings {
  /** render station offline → use the 2D pipeline instead of waiting */
  skip3dWhenWorkerOffline: boolean;
  /** clips whose predicted value is below this get the 2D pipeline (0 = always allow 3D) */
  minValueFor3d: number;
  /** reuse a clip rendered by an older engine version of the same visual recipe */
  reuseAcrossEngineVersions: boolean;
  /** upper bound for one render (ms); longer production renders are routed to a preview first */
  maxRenderMs: number;
}

export const DEFAULT_ROUTER_SETTINGS: RouterSettings = {
  skip3dWhenWorkerOffline: false,
  minValueFor3d: 0,
  reuseAcrossEngineVersions: true,
  maxRenderMs: 3 * 3_600_000,
};

export interface LibraryLookup {
  findByRecipeHash(hash: string): Promise<Asset3D | null>;
  findByVisualKey(key: string): Promise<Asset3D | null>;
}

export interface RouteRequest {
  recipe: Recipe3DInput;
  /** the product model (null: no 3D model of this product exists) */
  product: Asset3D | null;
  /** real product photos / videos available to the 2D pipeline */
  productMediaCount?: number;
  /** predicted value of the clip (0–1) from the analytics loop; undefined = unknown */
  valueScore?: number;
  externalAi?: { allowed: boolean; estimateUsd: number; budgetRemainingUsd: number };
}

export interface RouteContext {
  blender: EngineCapabilities;
  unreal: EngineCapabilities;
  /** a render worker is online (heartbeat) — false when the station is switched off */
  workerOnline: boolean;
  library: LibraryLookup;
  history?: readonly TimingSample[];
  settings?: Partial<RouterSettings>;
  cost?: LocalCostAssumptions;
}

export interface RouteDecision {
  engine: RouteEngine;
  /** the recipe that will be rendered (an Unreal template mapped to its Blender equivalent, etc.) */
  recipe: Recipe3D | null;
  reasons: string[];
  rejected: { engine: RouteEngine; why: string }[];
  cacheHit: boolean;
  existingAsset: Asset3D | null;
  visualKey: string | null;
  recipeHash: string | null;
  engineIdentity: string | null;
  estimate: (RenderEstimate & { costUsd: number; device: "CPU" | "GPU" }) | null;
  /** the request asked for a production render that exceeds maxRenderMs: render a preview first */
  previewFirst: boolean;
}

export function engineIdentity(c: EngineCapabilities, device: "CPU" | "GPU"): string {
  return `${c.engine}|${c.version ?? "unknown"}|${device}`;
}

const none = (
  engine: RouteEngine,
  reasons: string[],
  rejected: RouteDecision["rejected"] = [],
  recipe: Recipe3D | null = null,
): RouteDecision => ({
  engine,
  recipe,
  reasons,
  rejected,
  cacheHit: false,
  existingAsset: null,
  visualKey: null,
  recipeHash: null,
  engineIdentity: null,
  estimate: null,
  previewFirst: false,
});

export async function routeRender(req: RouteRequest, ctx: RouteContext): Promise<RouteDecision> {
  const settings = { ...DEFAULT_ROUTER_SETTINGS, ...ctx.settings };
  const asked = Recipe3D.parse(req.recipe);
  const rejected: RouteDecision["rejected"] = [];
  const reasons: string[] = [];

  if (asked.engine === "2D_ONLY") return none("PROGRAMMATIC_2D", ["mode 2D_ONLY"], [], asked);

  const product = req.product;
  if (!product) {
    return none(
      "PROGRAMMATIC_2D",
      [
        "no 3D model of this product in the library — the 2D pipeline animates the real product media" +
          (req.productMediaCount ? ` (${req.productMediaCount} files)` : ""),
      ],
      [{ engine: "BLENDER", why: "no product model (a new model is never invented for a real product)" }],
      asked,
    );
  }
  if (STRUCTURAL_TEMPLATES.includes(asked.template) && !product.structureVerified)
    return none(
      "BLOCKED",
      [
        `${asked.template} shows the product's construction: ${product.assetId} has no verified part structure ` +
          `(${product.fidelity}) — use PRODUCT_HERO, TURNTABLE_360 or MACRO_DETAIL instead`,
      ],
      [],
      asked,
    );
  if (asked.focus && product.parts.length && !product.parts.some((p) => p.name === asked.focus))
    return none("BLOCKED", [`focus part "${asked.focus}" is not a part of ${product.assetId}`], [], asked);

  // which engine would render it, and as which recipe
  const wantsUnreal =
    asked.engine === "UNREAL" || (asked.engine !== "BLENDER" && isUnrealTemplate(asked.template));
  let engine: "BLENDER" | "UNREAL" = "BLENDER";
  let recipe = asked;
  if (wantsUnreal) {
    if (ctx.unreal.available && (ctx.unreal.gpu.available || asked.engine === "UNREAL")) {
      engine = "UNREAL";
      recipe = unrealEquivalent(asked);
      reasons.push(
        isUnrealTemplate(asked.template)
          ? `${asked.template} is a cinematic Unreal scene and Unreal is available`
          : `mode UNREAL: ${asked.template} rendered as ${recipe.template}`,
      );
    } else if (asked.engine === "UNREAL") {
      if (!settings.skip3dWhenWorkerOffline || ctx.workerOnline)
        return none(
          "DEFER",
          [`mode UNREAL but Unreal Engine is unavailable: ${ctx.unreal.reason ?? "no GPU"} — the job waits`],
          [],
          asked,
        );
      return none("PROGRAMMATIC_2D", ["Unreal unavailable and skip-3D-when-offline is on"], [], asked);
    } else {
      recipe = blenderEquivalent(asked);
      rejected.push({
        engine: "UNREAL",
        why: ctx.unreal.available ? "no GPU for Lumen / MRQ" : (ctx.unreal.reason ?? "not installed"),
      });
      reasons.push(
        `Unreal not usable: ${asked.template} rendered as the Blender ${recipe.template} equivalent`,
      );
    }
  } else if (isUnrealTemplate(asked.template)) {
    recipe = blenderEquivalent(asked);
  } else if (asked.engine !== "BLENDER") {
    rejected.push({
      engine: "UNREAL",
      why: `${asked.template} does not need a cinematic engine — Blender is faster`,
    });
  }

  const caps = engine === "UNREAL" ? ctx.unreal : ctx.blender;
  const device: "CPU" | "GPU" = caps.gpu.available ? "GPU" : "CPU";
  const vkey = visualKey(recipe, product);
  const ident = engineIdentity(caps, device);
  const rhash = recipeHash(vkey, ident);

  // 1: the library already has these pixels
  const exact = await ctx.library.findByRecipeHash(rhash);
  const compatible =
    exact ?? (settings.reuseAcrossEngineVersions ? await ctx.library.findByVisualKey(vkey) : null);
  const reusable = compatible && compatible.approval.status !== "REJECTED" ? compatible : null;
  if (reusable) {
    return {
      engine: "EXISTING_ASSET",
      recipe,
      reasons: [
        exact
          ? `library hit: ${reusable.assetId} has exactly this recipe (${rhash.slice(0, 12)})`
          : `library hit: ${reusable.assetId} has the same visual recipe from ${reusable.engineVersion ?? "another engine version"}`,
      ],
      rejected,
      cacheHit: true,
      existingAsset: reusable,
      visualKey: vkey,
      recipeHash: rhash,
      engineIdentity: ident,
      estimate: null,
      previewFirst: false,
    };
  }
  if (compatible && !reusable)
    rejected.push({ engine: "EXISTING_ASSET", why: `${compatible.assetId} was rejected by the owner` });
  if (asked.engine === "EXISTING_ASSET")
    return none(
      "PROGRAMMATIC_2D",
      ["mode EXISTING_ASSET and no clip with this recipe exists"],
      rejected,
      recipe,
    );

  // 3: is 3D justified at all?
  const value = req.valueScore;
  if (asked.engine === "AUTO" && value !== undefined && value < settings.minValueFor3d)
    return none(
      "PROGRAMMATIC_2D",
      [`predicted value ${value.toFixed(2)} < ${settings.minValueFor3d} — 3D not justified for this beat`],
      [...rejected, { engine, why: "low predicted value" }],
      recipe,
    );

  if (!caps.available) {
    const why = `${caps.engine} unavailable: ${caps.reason ?? "unknown"}`;
    if (settings.skip3dWhenWorkerOffline)
      return none(
        "PROGRAMMATIC_2D",
        [why, "skip-3D-when-offline is on"],
        [...rejected, { engine, why }],
        recipe,
      );
    return none("DEFER", [why, "the job waits for the render station"], rejected, recipe);
  }
  if (!ctx.workerOnline) {
    if (settings.skip3dWhenWorkerOffline)
      return none(
        "PROGRAMMATIC_2D",
        ["render worker offline", "skip-3D-when-offline is on"],
        rejected,
        recipe,
      );
    return none(
      "DEFER",
      ["render worker offline — the job stays queued and resumes when it is back"],
      rejected,
      recipe,
    );
  }

  const est = estimateRender(recipe, engine === "UNREAL" ? "unreal" : "blender", device, ctx.history ?? []);
  const cost = localRenderCost(est.totalMs, device, ctx.cost);
  const previewFirst = recipe.quality === "production" && est.totalMs > settings.maxRenderMs;
  reasons.push(
    product.generator
      ? `procedural ${product.generator.name} model (demo) rendered locally`
      : `existing ${product.fidelity.toLowerCase()} model ${product.assetId} v${product.version} re-rendered (no new model)`,
    `estimate ${Math.round(est.totalMs / 1000)} s on ${caps.engine} ${device} (${est.source}), ≈ $${cost.usd.toFixed(4)} local cost`,
  );
  if (previewFirst) reasons.push(`production estimate exceeds ${settings.maxRenderMs} ms: preview first`);
  if (req.externalAi?.allowed)
    rejected.push({
      engine: "EXTERNAL_AI",
      why: "a local render serves this beat — external generation not needed",
    });
  return {
    engine,
    recipe,
    reasons,
    rejected,
    cacheHit: false,
    existingAsset: null,
    visualKey: vkey,
    recipeHash: rhash,
    engineIdentity: ident,
    estimate: { ...est, costUsd: cost.usd, device },
    previewFirst,
  };
}
