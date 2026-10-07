import { formatUsd, type Micros } from "@cre/shared";
import { ctr as ctrOf } from "./metrics.ts";

/**
 * Performance evidence for the cost-aware router: how proven is this product / idea?
 * UNPROVEN → Tier 0, PROMISING → Tier 1, HIGH → Tier 2, PROVEN_WINNER → Tier 3 (premium spend).
 */
export type PerformanceLevel = "UNPROVEN" | "PROMISING" | "HIGH" | "PROVEN_WINNER";

export interface EvidenceInput {
  /** number of published items for this product/idea */
  sampleSize: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueMicros: Micros;
  costMicros: Micros;
  /** brand median CTR across published content (null when unknown) */
  brandMedianCtr: number | null;
}

export interface EvidenceThresholds {
  minImpressions: number;
  highMinImpressions: number;
  winnerMinConversions: number;
}

export const DEFAULT_EVIDENCE_THRESHOLDS: EvidenceThresholds = {
  minImpressions: 500,
  highMinImpressions: 2_000,
  winnerMinConversions: 3,
};

export function performanceLevel(
  e: EvidenceInput,
  t: EvidenceThresholds = DEFAULT_EVIDENCE_THRESHOLDS,
): { level: PerformanceLevel; reasons: string[] } {
  const reasons: string[] = [];
  const ctr = ctrOf(e.clicks, e.impressions);
  const median = e.brandMedianCtr;
  if (e.sampleSize === 0 || e.impressions < t.minImpressions || ctr === null) {
    reasons.push(`not enough data (${e.sampleSize} posts, ${e.impressions} impressions)`);
    return { level: "UNPROVEN", reasons };
  }
  const ctrText = `CTR ${(ctr * 100).toFixed(2)}%`;
  const medianText = median !== null ? ` vs brand median ${(median * 100).toFixed(2)}%` : "";
  const profitable = e.revenueMicros > e.costMicros * 2;
  if (
    e.conversions >= t.winnerMinConversions &&
    profitable &&
    (median === null || ctr >= median * 1.5) &&
    e.sampleSize >= 2
  ) {
    reasons.push(
      `${e.conversions} conversions, revenue ${formatUsd(e.revenueMicros)} > 2× cost ${formatUsd(e.costMicros)}, ${ctrText}${medianText}`,
    );
    return { level: "PROVEN_WINNER", reasons };
  }
  if ((median === null || ctr >= median * 1.3) && e.impressions >= t.highMinImpressions) {
    reasons.push(`${ctrText}${medianText} on ${e.impressions} impressions`);
    return { level: "HIGH", reasons };
  }
  if (e.conversions >= 1 && e.revenueMicros > e.costMicros) {
    reasons.push(`converting (${e.conversions}) and profitable`);
    return { level: "HIGH", reasons };
  }
  if (median === null || ctr >= median) {
    reasons.push(`${ctrText}${medianText}`);
    return { level: "PROMISING", reasons };
  }
  reasons.push(`underperforming: ${ctrText}${medianText}`);
  return { level: "UNPROVEN", reasons };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
