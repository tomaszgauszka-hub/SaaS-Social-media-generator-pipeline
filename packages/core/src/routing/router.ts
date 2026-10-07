import { TIER_ORDER, TIER_PLANS, tierIndex, type ModelClass, type TierKey, type TierPlan } from "@cre/config";
import type { PerformanceLevel } from "@cre/analytics";
import { formatUsd, type Micros } from "@cre/shared";

/**
 * MediaGenerationRouter — chooses how much money a content item may spend on generated media.
 *
 *   UNPROVEN idea      → Tier 0 (real product imagery + programmatic motion)
 *   PROMISING product  → Tier 1 (+ one cheap 3-5 s AI shot)
 *   HIGH performer     → Tier 2 (better models)
 *   PROVEN WINNER      → Tier 3 (premium, multiple AI shots)
 *
 * …then downgrades while the plan is not justified by expected value or does not fit the budget.
 * Every decision step is recorded in `reasons` and stored on the ContentProject.
 */
export type QualityLevel = "DRAFT" | "STANDARD" | "PREMIUM";

export interface TierCostEstimate {
  totalMicros: Micros;
  aiVideoMicros: Micros;
  breakdown: {
    llmMicros: Micros;
    imageMicros: Micros;
    videoMicros: Micros;
    ttsMicros: Micros;
    bgRemovalMicros: Micros;
  };
}

export interface CostModelInput {
  llmMicros: Micros;
  imageMicros: (modelClass: ModelClass) => Micros;
  videoMicros: (modelClass: ModelClass, seconds: number) => Micros;
  ttsMicros: Micros;
  bgRemovalMicros: Micros;
  /** generated images the visual plan asks for (capped per tier) */
  requestedGeneratedImages: number;
  /** AI video shots the visual plan asks for (capped per tier) */
  requestedAiShots: number;
  useVoiceover: boolean;
  /** number of real product images needing background removal */
  productImages: number;
}

/** Estimated media + LLM cost of producing one content item at a given tier. */
export function estimateTierCost(tier: TierKey, m: CostModelInput): TierCostEstimate {
  const plan = TIER_PLANS[tier];
  const images = Math.min(plan.maxGeneratedImages, m.requestedGeneratedImages);
  const shots = plan.videoClass
    ? Math.min(plan.aiVideoShots, Math.max(m.requestedAiShots, plan.aiVideoShots > 0 ? 1 : 0))
    : 0;
  const imageMicros = images * m.imageMicros(plan.imageClass);
  const videoMicros = plan.videoClass
    ? shots * m.videoMicros(plan.videoClass, plan.aiVideoSecondsPerShot)
    : 0;
  const ttsMicros = m.useVoiceover ? m.ttsMicros : 0;
  const bgRemovalMicros = plan.backgroundRemoval ? m.productImages * m.bgRemovalMicros : 0;
  return {
    totalMicros: m.llmMicros + imageMicros + videoMicros + ttsMicros + bgRemovalMicros,
    aiVideoMicros: videoMicros,
    breakdown: { llmMicros: m.llmMicros, imageMicros, videoMicros, ttsMicros, bgRemovalMicros },
  };
}

export interface RouterInput {
  format: "SHORT_VIDEO" | "STATIC_POST" | "CAROUSEL" | "TEXT_POST";
  expectedValueMicros: Micros;
  performance: { level: PerformanceLevel; reasons: string[] };
  requestedQuality: QualityLevel;
  brand: { maxTier: TierKey; allowAiVideo: boolean };
  budget: {
    /** remaining headroom of the tightest period budget (null = unlimited) */
    headroomMicros: Micros | null;
    contentCapMicros: Micros | null;
    aiVideoCapMicros: Micros | null;
    spentOnContentMicros: Micros;
  };
  costModel: CostModelInput;
  /** generation cost may use at most this share of expected value for tiers above 0 */
  maxCostToValueRatio?: number;
}

export interface RouterDecision {
  tier: TierKey;
  plan: TierPlan;
  estimate: TierCostEstimate;
  baseTier: TierKey;
  reasons: string[];
  /** even Tier 0 does not fit the budget → BUDGET_BLOCKED */
  blocked: boolean;
}

const LEVEL_TO_TIER: Record<PerformanceLevel, TierKey> = {
  UNPROVEN: "TIER_0",
  PROMISING: "TIER_1",
  HIGH: "TIER_2",
  PROVEN_WINNER: "TIER_3",
};

const min = (a: TierKey, b: TierKey): TierKey => (tierIndex(a) <= tierIndex(b) ? a : b);

export function routeGeneration(input: RouterInput): RouterDecision {
  const reasons: string[] = [];
  const ratio = input.maxCostToValueRatio ?? 0.35;
  const baseTier = LEVEL_TO_TIER[input.performance.level];
  reasons.push(
    `Evidence ${input.performance.level} → base ${baseTier}${input.performance.reasons.length ? ` (${input.performance.reasons.join("; ")})` : ""}`,
  );

  let tier = baseTier;
  switch (input.requestedQuality) {
    case "DRAFT":
      if (tierIndex(tier) > 0) reasons.push("Requested quality DRAFT → capped at TIER_0");
      tier = "TIER_0";
      break;
    case "STANDARD":
      // Evidence decides; the value and budget gates below still apply.
      break;
    case "PREMIUM": {
      // Premium may lift by one level, but never into Tier 3 without proven analytics.
      const ceiling: TierKey = input.performance.level === "PROVEN_WINNER" ? "TIER_3" : "TIER_2";
      const lifted = TIER_ORDER[Math.min(tierIndex(tier) + 1, tierIndex(ceiling))]!;
      if (lifted !== tier) reasons.push(`Requested quality PREMIUM → lifted to ${lifted}`);
      tier = lifted;
      break;
    }
  }

  if (tierIndex(tier) > tierIndex(input.brand.maxTier)) {
    reasons.push(`Brand tier ceiling ${input.brand.maxTier}`);
    tier = min(tier, input.brand.maxTier);
  }
  if (!input.brand.allowAiVideo && tierIndex(tier) > 0) {
    reasons.push("Brand does not allow AI video → TIER_0");
    tier = "TIER_0";
  }
  if (input.format !== "SHORT_VIDEO" && tierIndex(tier) > 0) {
    reasons.push(`${input.format} has no video → TIER_0`);
    tier = "TIER_0";
  }

  let estimate = estimateTierCost(tier, input.costModel);
  // Economic gate: do not spend premium money the idea is not expected to earn back.
  while (tierIndex(tier) > 0 && estimate.totalMicros > input.expectedValueMicros * ratio) {
    const lower = TIER_ORDER[tierIndex(tier) - 1]!;
    reasons.push(
      `${tier} cost ${formatUsd(estimate.totalMicros)} > ${Math.round(ratio * 100)}% of expected value ${formatUsd(input.expectedValueMicros)} → ${lower}`,
    );
    tier = lower;
    estimate = estimateTierCost(tier, input.costModel);
  }

  const fits = (e: TierCostEstimate) => {
    const b = input.budget;
    if (b.headroomMicros !== null && e.totalMicros > b.headroomMicros)
      return `exceeds remaining budget ${formatUsd(b.headroomMicros)}`;
    if (b.contentCapMicros !== null && b.spentOnContentMicros + e.totalMicros > b.contentCapMicros)
      return `exceeds per-content cap ${formatUsd(b.contentCapMicros)}`;
    if (b.aiVideoCapMicros !== null && e.aiVideoMicros > b.aiVideoCapMicros)
      return `AI video ${formatUsd(e.aiVideoMicros)} exceeds cap ${formatUsd(b.aiVideoCapMicros)}`;
    return null;
  };
  let problem = fits(estimate);
  while (problem && tierIndex(tier) > 0) {
    const lower = TIER_ORDER[tierIndex(tier) - 1]!;
    reasons.push(`${tier} ${problem} → ${lower}`);
    tier = lower;
    estimate = estimateTierCost(tier, input.costModel);
    problem = fits(estimate);
  }
  const blocked = problem !== null;
  if (blocked) reasons.push(`TIER_0 ${problem} → BUDGET_BLOCKED`);
  else
    reasons.push(
      `Chosen ${tier}: estimated ${formatUsd(estimate.totalMicros)} (AI video ${formatUsd(estimate.aiVideoMicros)})`,
    );

  return { tier, plan: TIER_PLANS[tier], estimate, baseTier, reasons, blocked };
}
