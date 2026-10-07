import { formatUsd, type Micros } from "@cre/shared";
import { ctr, rpm } from "./metrics.ts";

/**
 * Learning loop (no ML): group published content by creative features, compare each group's performance to
 * the brand baseline, and summarise winners/losers as text that is fed into future generation prompts.
 */
export interface ContentPerformanceRecord {
  projectId: string;
  platform: string;
  hookStyle: string | null;
  angle: string | null;
  ctaType: string | null;
  durationMs: number | null;
  templateKey: string | null;
  tier: string | null;
  productTitle: string | null;
  postedAt: Date | null;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueMicros: Micros;
  costMicros: Micros;
  completionRate: number | null;
}

export type Dimension =
  | "hookStyle"
  | "angle"
  | "ctaType"
  | "duration"
  | "template"
  | "product"
  | "postingTime"
  | "platform"
  | "tier";

export interface PatternStat {
  dimension: Dimension;
  value: string;
  n: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueMicros: Micros;
  ctr: number | null;
  rpmMicros: Micros | null;
  completionRate: number | null;
  /** performance relative to the brand baseline on the primary metric (1.0 = average) */
  lift: number | null;
}

export interface PerformanceProfileSummary {
  sampleSize: number;
  primaryMetric: "rpm" | "ctr";
  baseline: { ctr: number | null; rpmMicros: Micros | null; completionRate: number | null };
  high: PatternStat[];
  low: PatternStat[];
  byDimension: Partial<Record<Dimension, PatternStat[]>>;
}

export function durationBucket(ms: number | null): string | null {
  if (ms === null) return null;
  const s = ms / 1000;
  if (s < 15) return "<15s";
  if (s < 20) return "15-20s";
  if (s < 25) return "20-25s";
  if (s < 30) return "25-30s";
  if (s < 40) return "30-40s";
  return "40s+";
}

export function postingTimeBucket(date: Date | null, timeZone = "UTC"): string | null {
  if (!date) return null;
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date),
  );
  if (hour < 6) return "night (0-6h)";
  if (hour < 11) return "morning (6-11h)";
  if (hour < 15) return "midday (11-15h)";
  if (hour < 19) return "afternoon (15-19h)";
  return "evening (19-24h)";
}

function featureValue(r: ContentPerformanceRecord, d: Dimension, timeZone: string): string | null {
  switch (d) {
    case "hookStyle":
      return r.hookStyle;
    case "angle":
      return r.angle;
    case "ctaType":
      return r.ctaType;
    case "duration":
      return durationBucket(r.durationMs);
    case "template":
      return r.templateKey;
    case "product":
      return r.productTitle;
    case "postingTime":
      return postingTimeBucket(r.postedAt, timeZone);
    case "platform":
      return r.platform;
    case "tier":
      return r.tier;
  }
}

const DIMENSIONS: Dimension[] = [
  "hookStyle",
  "angle",
  "ctaType",
  "duration",
  "template",
  "product",
  "postingTime",
  "platform",
  "tier",
];

export function buildPerformanceProfile(
  records: readonly ContentPerformanceRecord[],
  opts: { minSample?: number; timeZone?: string; highLift?: number; lowLift?: number } = {},
): PerformanceProfileSummary {
  const minSample = opts.minSample ?? 3;
  const tz = opts.timeZone ?? "UTC";
  const totals = records.reduce(
    (a, r) => ({
      impressions: a.impressions + r.impressions,
      clicks: a.clicks + r.clicks,
      revenue: a.revenue + r.revenueMicros,
      completion: a.completion + (r.completionRate ?? 0),
      completionN: a.completionN + (r.completionRate !== null ? 1 : 0),
    }),
    { impressions: 0, clicks: 0, revenue: 0, completion: 0, completionN: 0 },
  );
  // Revenue is the primary KPI once there is any; until then optimise for clicks (CTR).
  const primaryMetric: "rpm" | "ctr" = totals.revenue > 0 ? "rpm" : "ctr";
  const baseline = {
    ctr: ctr(totals.clicks, totals.impressions),
    rpmMicros: rpm(totals.revenue, totals.impressions),
    completionRate: totals.completionN ? totals.completion / totals.completionN : null,
  };
  const baseValue = primaryMetric === "rpm" ? baseline.rpmMicros : baseline.ctr;

  const byDimension: PerformanceProfileSummary["byDimension"] = {};
  const all: PatternStat[] = [];
  for (const d of DIMENSIONS) {
    const groups = new Map<string, ContentPerformanceRecord[]>();
    for (const r of records) {
      const v = featureValue(r, d, tz);
      if (!v) continue;
      groups.set(v, [...(groups.get(v) ?? []), r]);
    }
    const stats: PatternStat[] = [...groups.entries()].map(([value, rs]) => {
      const impressions = rs.reduce((s, r) => s + r.impressions, 0);
      const clicks = rs.reduce((s, r) => s + r.clicks, 0);
      const revenueMicros = rs.reduce((s, r) => s + r.revenueMicros, 0);
      const completions = rs.filter((r) => r.completionRate !== null);
      const stat: PatternStat = {
        dimension: d,
        value,
        n: rs.length,
        impressions,
        clicks,
        conversions: rs.reduce((s, r) => s + r.conversions, 0),
        revenueMicros,
        ctr: ctr(clicks, impressions),
        rpmMicros: rpm(revenueMicros, impressions),
        completionRate: completions.length
          ? completions.reduce((s, r) => s + (r.completionRate ?? 0), 0) / completions.length
          : null,
        lift: null,
      };
      const value_ = primaryMetric === "rpm" ? stat.rpmMicros : stat.ctr;
      stat.lift = value_ !== null && baseValue !== null && baseValue > 0 ? value_ / baseValue : null;
      return stat;
    });
    stats.sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
    byDimension[d] = stats;
    all.push(...stats);
  }
  const eligible = all.filter((s) => s.n >= minSample && s.lift !== null);
  return {
    sampleSize: records.length,
    primaryMetric,
    baseline,
    high: eligible
      .filter((s) => (s.lift ?? 0) >= (opts.highLift ?? 1.2))
      .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0))
      .slice(0, 8),
    low: eligible
      .filter((s) => (s.lift ?? 2) <= (opts.lowLift ?? 0.8))
      .sort((a, b) => (a.lift ?? 0) - (b.lift ?? 0))
      .slice(0, 6),
    byDimension,
  };
}

const LABELS: Record<Dimension, string> = {
  hookStyle: "hook style",
  angle: "angle",
  ctaType: "CTA",
  duration: "duration",
  template: "template",
  product: "product",
  postingTime: "posting time",
  platform: "platform",
  tier: "production tier",
};

function describe(s: PatternStat, summary: PerformanceProfileSummary): string {
  const metric =
    summary.primaryMetric === "rpm"
      ? `RPM ${s.rpmMicros !== null ? formatUsd(s.rpmMicros) : "—"} vs ${summary.baseline.rpmMicros !== null ? formatUsd(summary.baseline.rpmMicros) : "—"} avg`
      : `CTR ${s.ctr !== null ? (s.ctr * 100).toFixed(2) : "—"}% vs ${summary.baseline.ctr !== null ? (summary.baseline.ctr * 100).toFixed(2) : "—"}% avg`;
  return `- ${LABELS[s.dimension]} "${s.value}": ${metric} (n=${s.n})`;
}

/** Compact text injected into ideation/script prompts. */
export function profileToPromptText(summary: PerformanceProfileSummary): string {
  if (summary.sampleSize === 0) return "";
  const lines = [
    `Based on ${summary.sampleSize} published posts (primary metric: ${summary.primaryMetric.toUpperCase()}):`,
  ];
  if (summary.high.length) lines.push("HIGH PERFORMING:", ...summary.high.map((s) => describe(s, summary)));
  if (summary.low.length) lines.push("LOW PERFORMING:", ...summary.low.map((s) => describe(s, summary)));
  if (!summary.high.length && !summary.low.length)
    lines.push("No statistically meaningful patterns yet — keep testing different hooks and angles.");
  else lines.push("Prefer high-performing patterns; avoid low-performing ones unless deliberately testing.");
  return lines.join("\n");
}
