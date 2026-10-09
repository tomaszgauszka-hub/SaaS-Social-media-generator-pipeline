import type { PlanShot, ReelPlan } from "../contracts/plan.ts";
import type { ShotPreset } from "../contracts/ids.ts";
import type { TierProfile } from "../contracts/profiles.ts";

/**
 * Generative video is the LAST resort. For every shot the engine walks the ladder
 *   CanUseExistingAsset? → CanRenderLocally? → CanApproximateLocally? → IsSpecialShotWorthCost? → provider
 * and only the last rung spends money. Every decision (used or not) and its reason goes into the manifest.
 */

/** Shots the local Blender studio renders fully (all 21 presets are procedural). */
const LOCAL_PRESETS = new Set<ShotPreset>([
  "hero_reveal",
  "turntable",
  "slow_turntable",
  "orbit",
  "macro_push",
  "macro_pull",
  "camera_slide",
  "top_down",
  "low_angle",
  "floating_product",
  "light_sweep",
  "silhouette_reveal",
  "feature_highlight",
  "detail_closeup",
  "impact",
  "product_drop",
  "cta_hero",
]);

/** Presets that need a multi-part model; with a single mesh the studio approximates them (nearest feasible move). */
const APPROXIMATED_WITH_ONE_MESH = new Set<ShotPreset>([
  "exploded_view",
  "parts_reveal",
  "assembly",
  "technical_cutaway",
]);

export interface GenerativeVideoDecision {
  shotId: string;
  used: boolean;
  rung: "existing_asset" | "local_render" | "local_approximation" | "generative_video" | "refused";
  reason: string;
  seconds: number;
  estimatedCostUsd: number;
}

export interface GenerativeVideoContext {
  tier: TierProfile;
  /** GENERATIVE_VIDEO_ENABLED */
  enabled: boolean;
  /** REEL_MAX_GENERATIVE_VIDEO_SECONDS */
  envMaxSeconds: number;
  /** the job opted in (ReelJob.allowGenerativeVideo) */
  jobAllows: boolean;
  /** shot ids with a reusable asset (retriever) */
  existingAssets: ReadonlySet<string>;
  /** the product model has more than one mesh (exploded / assembly shots are real, not approximated) */
  multiPartModel: boolean;
  /** remaining API budget for the job (USD) */
  remainingBudgetUsd: number;
  /** price of one second of generated video (USD, from the provider estimate) */
  usdPerSecond: number;
  /** shots the director flagged as impossible locally (surreal transformation, splash …) — empty for product reels */
  specialShots: ReadonlySet<string>;
}

export function decideGenerativeVideo(
  plan: ReelPlan,
  ctx: GenerativeVideoContext,
): GenerativeVideoDecision[] {
  const cap = Math.min(ctx.tier.maxGenerativeVideoSeconds, ctx.envMaxSeconds);
  let usedSeconds = 0;
  let spent = 0;
  return plan.shots.map((shot) => {
    const base = { shotId: shot.id, seconds: 0, estimatedCostUsd: 0, used: false };
    if (ctx.existingAssets.has(shot.id))
      return {
        ...base,
        rung: "existing_asset" as const,
        reason: "a matching asset already exists — reuse it",
      };
    if (!ctx.specialShots.has(shot.id)) {
      if (LOCAL_PRESETS.has(shot.preset))
        return {
          ...base,
          rung: "local_render" as const,
          reason: `${shot.preset} is rendered by the Blender studio`,
        };
      if (APPROXIMATED_WITH_ONE_MESH.has(shot.preset))
        return {
          ...base,
          rung: ctx.multiPartModel ? ("local_render" as const) : ("local_approximation" as const),
          reason: ctx.multiPartModel
            ? `${shot.preset} rendered from the model's parts`
            : `${shot.preset} approximated locally (single-mesh model) — a generated shot could invent product parts`,
        };
    }
    const seconds = Math.min(shot.durationMs / 1000, 2);
    const cost = seconds * ctx.usdPerSecond;
    const why = refusal(ctx, cap, usedSeconds, seconds, spent, cost);
    if (why) return { ...base, rung: "refused" as const, reason: why };
    usedSeconds += seconds;
    spent += cost;
    return {
      shotId: shot.id,
      used: true,
      rung: "generative_video" as const,
      reason: "special shot not achievable locally; within tier, job and budget limits",
      seconds,
      estimatedCostUsd: cost,
    };
  });
}

function refusal(
  ctx: GenerativeVideoContext,
  cap: number,
  usedSeconds: number,
  seconds: number,
  spent: number,
  cost: number,
): string | null {
  if (!ctx.enabled) return "generative video disabled (GENERATIVE_VIDEO_ENABLED=false)";
  if (!ctx.jobAllows) return "job did not opt in (allowGenerativeVideo=false)";
  if (cap <= 0) return `tier ${ctx.tier.tier} allows 0 s of generative video`;
  if (usedSeconds + seconds > cap) return `would exceed ${cap} s of generative video per reel`;
  if (spent + cost > ctx.remainingBudgetUsd) return "would exceed the job's API budget";
  return null;
}

/** Marks the shots that got generative video in the plan (manifest + composer read it). */
export function applyGenerativeVideoDecisions(
  plan: ReelPlan,
  decisions: GenerativeVideoDecision[],
): ReelPlan {
  const byId = new Map(decisions.map((d) => [d.shotId, d]));
  return {
    ...plan,
    shots: plan.shots.map((s): PlanShot => {
      const d = byId.get(s.id);
      if (!d?.used) return s;
      return {
        ...s,
        source: "generative_video",
        generativeVideo: { reason: d.reason, seconds: d.seconds, estimatedCostUsd: d.estimatedCostUsd },
      };
    }),
  };
}
