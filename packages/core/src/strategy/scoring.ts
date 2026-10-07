import { formatUsd, type Micros } from "@cre/shared";

/**
 * ContentOpportunityScore — a transparent heuristic (model "heuristic-v1"), NOT a prediction engine.
 * All values are ESTIMATES and are stored separately from real analytics. They exist to rank ideas and to
 * feed the router's expected-value gate.
 */
export const SCORING_MODEL = "heuristic-v1";

export interface OpportunityInput {
  idea: { angle: string; hookStrength: number; purchaseIntent: number; confidence: number };
  product: {
    priceMicros: Micros | null;
    commissionRate: number | null;
    commissionFixedMicros: Micros | null;
    kind: string;
    economicOutcome: string;
  };
  baseline: {
    /** expected impressions for a new post of this brand (prior or historical median) */
    expectedImpressions: number;
    /** brand CTR (outbound clicks / impressions) — historical or prior */
    ctr: number;
    /** clicks → conversions — historical or prior per outcome type */
    conversionRate: number;
    /** number of published posts behind the baseline */
    sampleSize: number;
  };
  /** multiplier from the learning loop for this angle / hook style (1 = neutral) */
  historicalLift: number | null;
  /** max similarity (0-1) to recent content — high similarity = low novelty */
  similarity: number;
  /** product ↔ brand fit (0-1) */
  relevance: number;
  estimatedCostMicros: Micros;
}

export interface OpportunityScoreResult {
  totalScore: number;
  expectedCtr: number;
  expectedConversionRate: number;
  expectedImpressions: number;
  valuePerConversionMicros: Micros;
  estimatedRevenueMicros: Micros;
  estimatedCostMicros: Micros;
  expectedProfitMicros: Micros;
  novelty: number;
  relevance: number;
  similarity: number;
  commissionScore: number;
  confidence: number;
  factors: Record<string, number | string>;
}

const ANGLE_CTR_FACTOR: Record<string, number> = {
  before_you_buy: 1.25,
  comparison: 1.2,
  deal_alert: 1.3,
  problem_solution: 1.15,
  mistakes_to_avoid: 1.1,
  spec_breakdown: 1.05,
  top_benefits: 1.0,
  how_to_use: 0.9,
  use_case: 0.95,
  myth_busting: 1.0,
};

/** Default priors when a brand has no history yet (deliberately conservative). */
export const PRIORS = {
  expectedImpressions: 800,
  ctr: 0.008,
  conversionRate: {
    AFFILIATE_CLICK: 0.03,
    SALE: 0.02,
    LEAD: 0.08,
    SERVICE_INQUIRY: 0.05,
    EMAIL_SIGNUP: 0.12,
  } as Record<string, number>,
};

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** Value of one conversion: fixed payout (leads) or price × commission (own products: commission = margin). */
export function valuePerConversion(p: OpportunityInput["product"]): Micros {
  if (p.commissionFixedMicros !== null && p.commissionFixedMicros > 0) return p.commissionFixedMicros;
  if (p.priceMicros !== null && p.commissionRate !== null)
    return Math.round(p.priceMicros * p.commissionRate);
  return 0;
}

export function scoreOpportunity(input: OpportunityInput): OpportunityScoreResult {
  const hookFactor = 0.6 + 0.08 * clamp(input.idea.hookStrength, 1, 10); // 0.68 … 1.4
  const intentFactor = 0.5 + 0.1 * clamp(input.idea.purchaseIntent, 1, 10); // 0.6 … 1.5
  const angleFactor = ANGLE_CTR_FACTOR[input.idea.angle] ?? 1;
  const lift = input.historicalLift ?? 1;

  const expectedCtr = input.baseline.ctr * hookFactor * angleFactor * lift;
  const expectedConversionRate = input.baseline.conversionRate * intentFactor;
  const expectedImpressions = Math.round(
    input.baseline.expectedImpressions * (0.75 + 0.05 * clamp(input.idea.hookStrength, 1, 10)),
  );
  const vpc = valuePerConversion(input.product);
  const estimatedRevenueMicros = Math.round(expectedImpressions * expectedCtr * expectedConversionRate * vpc);
  const expectedProfitMicros = estimatedRevenueMicros - input.estimatedCostMicros;

  const novelty = clamp(1 - input.similarity);
  const relevance = clamp(input.relevance);
  const commissionScore = clamp(vpc / 10_000_000); // $10 per conversion = full marks
  const dataConfidence = clamp(0.3 + input.baseline.sampleSize / 30, 0, 1);
  const confidence = clamp(input.idea.confidence * dataConfidence);

  // Profit component: logistic around $0.50 expected profit per post.
  const profitScore = 1 / (1 + Math.exp(-(expectedProfitMicros / 1_000_000 - 0.5) * 2));
  const raw =
    0.35 * profitScore +
    0.2 * (clamp(input.idea.purchaseIntent, 1, 10) / 10) +
    0.15 * (clamp(input.idea.hookStrength, 1, 10) / 10) +
    0.15 * novelty +
    0.1 * relevance +
    0.05 * commissionScore;
  // Penalise near-duplicates hard: repetition burns audience attention.
  const duplicatePenalty = input.similarity >= 0.8 ? 0.5 : 1;
  const totalScore = Math.round(raw * 100 * duplicatePenalty * 10) / 10;

  return {
    totalScore,
    expectedCtr,
    expectedConversionRate,
    expectedImpressions,
    valuePerConversionMicros: vpc,
    estimatedRevenueMicros,
    estimatedCostMicros: input.estimatedCostMicros,
    expectedProfitMicros,
    novelty,
    relevance,
    similarity: input.similarity,
    commissionScore,
    confidence,
    factors: {
      hookFactor,
      intentFactor,
      angleFactor,
      historicalLift: lift,
      profitScore,
      duplicatePenalty,
      baselineCtr: input.baseline.ctr,
      baselineConversionRate: input.baseline.conversionRate,
      baselineImpressions: input.baseline.expectedImpressions,
      baselineSampleSize: input.baseline.sampleSize,
      valuePerConversion: formatUsd(vpc),
      note: "Heuristic estimate — compare with real analytics before trusting.",
    },
  };
}

/** Keyword overlap between product tags/category and the brand niche (0-1). */
export function productRelevance(
  product: { category: string | null; tags: string[]; title: string },
  niche: string,
): number {
  const nicheWords = new Set(
    niche
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
  const productWords = [product.category ?? "", ...product.tags, product.title]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  if (productWords.length === 0 || nicheWords.size === 0) return 0.6;
  const hits = productWords.filter((w) =>
    [...nicheWords].some((n) => n.startsWith(w.slice(0, 5)) || w.startsWith(n.slice(0, 5))),
  ).length;
  return clamp(0.5 + hits / 6);
}
