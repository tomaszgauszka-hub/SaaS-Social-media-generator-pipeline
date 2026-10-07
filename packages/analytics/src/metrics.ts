import { safeRatio, type Micros } from "@cre/shared";

/**
 * Pure metric math. Analytics snapshots are CUMULATIVE time series (each snapshot = totals so far),
 * so aggregations must use the LATEST snapshot per publication — never the sum of snapshots.
 */
export interface MetricsSnapshotLike {
  publicationId: string;
  capturedAt: Date;
  impressions?: number | null;
  reach?: number | null;
  plays?: number | null;
  views3s?: number | null;
  completionRate?: number | null;
  avgWatchTimeMs?: number | null;
  likes?: number | null;
  comments?: number | null;
  saves?: number | null;
  shares?: number | null;
  profileVisits?: number | null;
  outboundClicks?: number | null;
}

export interface EngagementTotals {
  impressions: number;
  reach: number;
  plays: number;
  views3s: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  profileVisits: number;
  outboundClicks: number;
  /** plays-weighted average completion rate (0-1) */
  completionRate: number | null;
  publications: number;
}

export function latestPerPublication<T extends MetricsSnapshotLike>(snapshots: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const s of snapshots) {
    const current = latest.get(s.publicationId);
    if (!current || s.capturedAt.getTime() > current.capturedAt.getTime()) latest.set(s.publicationId, s);
  }
  return latest;
}

export function sumLatest(snapshots: readonly MetricsSnapshotLike[]): EngagementTotals {
  const latest = [...latestPerPublication(snapshots).values()];
  const n = (v: number | null | undefined) => v ?? 0;
  let weightedCompletion = 0;
  let completionWeight = 0;
  const totals = latest.reduce<EngagementTotals>(
    (acc, s) => {
      if (s.completionRate !== null && s.completionRate !== undefined) {
        const w = Math.max(1, n(s.plays) || n(s.impressions));
        weightedCompletion += s.completionRate * w;
        completionWeight += w;
      }
      return {
        ...acc,
        impressions: acc.impressions + n(s.impressions),
        reach: acc.reach + n(s.reach),
        plays: acc.plays + n(s.plays),
        views3s: acc.views3s + n(s.views3s),
        likes: acc.likes + n(s.likes),
        comments: acc.comments + n(s.comments),
        saves: acc.saves + n(s.saves),
        shares: acc.shares + n(s.shares),
        profileVisits: acc.profileVisits + n(s.profileVisits),
        outboundClicks: acc.outboundClicks + n(s.outboundClicks),
      };
    },
    {
      impressions: 0,
      reach: 0,
      plays: 0,
      views3s: 0,
      likes: 0,
      comments: 0,
      saves: 0,
      shares: 0,
      profileVisits: 0,
      outboundClicks: 0,
      completionRate: null,
      publications: latest.length,
    },
  );
  totals.completionRate = completionWeight > 0 ? weightedCompletion / completionWeight : null;
  return totals;
}

/** click-through rate = clicks / impressions */
export function ctr(clicks: number, impressions: number): number | null {
  return safeRatio(clicks, impressions);
}

export function conversionRate(conversions: number, clicks: number): number | null {
  return safeRatio(conversions, clicks);
}

/** revenue per 1,000 impressions (micro-USD) */
export function rpm(revenueMicros: Micros, impressions: number): Micros | null {
  const r = safeRatio(revenueMicros * 1000, impressions);
  return r === null ? null : Math.round(r);
}

export function revenuePerClick(revenueMicros: Micros, clicks: number): Micros | null {
  const r = safeRatio(revenueMicros, clicks);
  return r === null ? null : Math.round(r);
}

/** return on investment: (revenue − cost) / cost */
export function roi(revenueMicros: Micros, costMicros: Micros): number | null {
  return safeRatio(revenueMicros - costMicros, costMicros);
}

export function revenueToCost(revenueMicros: Micros, costMicros: Micros): number | null {
  return safeRatio(revenueMicros, costMicros);
}

export function costPer(costMicros: Micros, count: number): Micros | null {
  const r = safeRatio(costMicros, count);
  return r === null ? null : Math.round(r);
}

export interface ProfitInput {
  revenueMicros: Micros;
  aiCostMicros: Micros;
  infrastructureCostMicros?: Micros;
  adCostMicros?: Micros;
  otherCostMicros?: Micros;
}

/** PROFIT = revenue − AI cost − infrastructure − ad spend − other */
export function profit(input: ProfitInput): Micros {
  return (
    input.revenueMicros -
    input.aiCostMicros -
    (input.infrastructureCostMicros ?? 0) -
    (input.adCostMicros ?? 0) -
    (input.otherCostMicros ?? 0)
  );
}

export function engagementRate(
  t: Pick<EngagementTotals, "likes" | "comments" | "saves" | "shares" | "impressions">,
): number | null {
  return safeRatio(t.likes + t.comments + t.saves + t.shares, t.impressions);
}

/**
 * Prorate an expense that covers [incurredOn, incurredOn + periodDays) to the overlap with [from, to).
 * e.g. a $30 monthly server bill contributes $1/day to daily profit.
 */
export function prorateExpense(
  expense: { amountMicros: Micros; incurredOn: Date; periodDays: number },
  from: Date,
  to: Date,
): Micros {
  const start = expense.incurredOn.getTime();
  const end = start + Math.max(1, expense.periodDays) * 86_400_000;
  const overlap = Math.max(0, Math.min(end, to.getTime()) - Math.max(start, from.getTime()));
  if (overlap === 0) return 0;
  return Math.round((expense.amountMicros * overlap) / (end - start));
}

export interface KpiInput {
  revenueMicros: Micros;
  aiCostMicros: Micros;
  infrastructureCostMicros: Micros;
  adCostMicros: Micros;
  impressions: number;
  clicks: number;
  conversions: number;
  contentCount: number;
  approvedCount: number;
  publishedCount: number;
}

export interface KpiSummary extends KpiInput {
  profitMicros: Micros;
  roi: number | null;
  revenueToCost: number | null;
  ctr: number | null;
  conversionRate: number | null;
  rpmMicros: Micros | null;
  revenuePerClickMicros: Micros | null;
  costPerContentMicros: Micros | null;
  costPerApprovedMicros: Micros | null;
  costPerPublishedMicros: Micros | null;
  costPerConversionMicros: Micros | null;
}

export function computeKpis(input: KpiInput): KpiSummary {
  const totalCost = input.aiCostMicros + input.infrastructureCostMicros + input.adCostMicros;
  return {
    ...input,
    profitMicros: profit({
      revenueMicros: input.revenueMicros,
      aiCostMicros: input.aiCostMicros,
      infrastructureCostMicros: input.infrastructureCostMicros,
      adCostMicros: input.adCostMicros,
    }),
    roi: roi(input.revenueMicros, totalCost),
    revenueToCost: revenueToCost(input.revenueMicros, input.aiCostMicros),
    ctr: ctr(input.clicks, input.impressions),
    conversionRate: conversionRate(input.conversions, input.clicks),
    rpmMicros: rpm(input.revenueMicros, input.impressions),
    revenuePerClickMicros: revenuePerClick(input.revenueMicros, input.clicks),
    costPerContentMicros: costPer(input.aiCostMicros, input.contentCount),
    costPerApprovedMicros: costPer(input.aiCostMicros, input.approvedCount),
    costPerPublishedMicros: costPer(input.aiCostMicros, input.publishedCount),
    costPerConversionMicros: costPer(totalCost, input.conversions),
  };
}

export function formatPercent(value: number | null, digits = 1): string {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}
