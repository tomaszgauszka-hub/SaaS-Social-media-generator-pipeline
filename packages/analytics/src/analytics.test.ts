import { describe, expect, it } from "vitest";
import { performanceLevel } from "./evidence.ts";
import {
  computeKpis,
  ctr,
  latestPerPublication,
  profit,
  prorateExpense,
  roi,
  rpm,
  sumLatest,
} from "./metrics.ts";
import {
  buildPerformanceProfile,
  durationBucket,
  profileToPromptText,
  type ContentPerformanceRecord,
} from "./profile.ts";

const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h));

describe("snapshot aggregation", () => {
  const snaps = [
    {
      publicationId: "a",
      capturedAt: t(1),
      impressions: 100,
      outboundClicks: 1,
      plays: 90,
      completionRate: 0.5,
    },
    {
      publicationId: "a",
      capturedAt: t(6),
      impressions: 1000,
      outboundClicks: 12,
      plays: 900,
      completionRate: 0.4,
    },
    {
      publicationId: "b",
      capturedAt: t(2),
      impressions: 500,
      outboundClicks: 5,
      plays: 100,
      completionRate: 0.2,
    },
  ];

  it("uses the latest cumulative snapshot per publication (never sums snapshots)", () => {
    expect(latestPerPublication(snaps).get("a")!.impressions).toBe(1000);
    const totals = sumLatest(snaps);
    expect(totals.impressions).toBe(1500);
    expect(totals.outboundClicks).toBe(17);
    expect(totals.publications).toBe(2);
    // plays-weighted completion: (0.4*900 + 0.2*100) / 1000
    expect(totals.completionRate).toBeCloseTo(0.38);
  });
});

describe("KPIs", () => {
  it("computes CTR, RPM, ROI and profit", () => {
    expect(ctr(15, 1000)).toBeCloseTo(0.015);
    expect(ctr(1, 0)).toBeNull();
    expect(rpm(2_000_000, 4000)).toBe(500_000); // $2 / 4k impressions = $0.50 RPM
    expect(roi(3_000_000, 1_000_000)).toBe(2);
    expect(
      profit({
        revenueMicros: 10_000_000,
        aiCostMicros: 1_000_000,
        infrastructureCostMicros: 2_000_000,
        adCostMicros: 500_000,
      }),
    ).toBe(6_500_000);
  });

  it("computes per-unit costs and handles zero denominators", () => {
    const k = computeKpis({
      revenueMicros: 5_000_000,
      aiCostMicros: 2_000_000,
      infrastructureCostMicros: 1_000_000,
      adCostMicros: 0,
      impressions: 10_000,
      clicks: 200,
      conversions: 4,
      contentCount: 10,
      approvedCount: 8,
      publishedCount: 0,
    });
    expect(k.profitMicros).toBe(2_000_000);
    expect(k.costPerContentMicros).toBe(200_000);
    expect(k.costPerApprovedMicros).toBe(250_000);
    expect(k.costPerPublishedMicros).toBeNull();
    expect(k.costPerConversionMicros).toBe(750_000);
    expect(k.conversionRate).toBeCloseTo(0.02);
    expect(k.revenueToCost).toBe(2.5);
  });

  it("prorates period expenses to date ranges", () => {
    const monthly = {
      amountMicros: 30_000_000,
      incurredOn: new Date("2026-10-01T00:00:00Z"),
      periodDays: 30,
    };
    expect(prorateExpense(monthly, new Date("2026-10-07T00:00:00Z"), new Date("2026-10-08T00:00:00Z"))).toBe(
      1_000_000,
    );
    expect(prorateExpense(monthly, new Date("2026-11-05T00:00:00Z"), new Date("2026-11-06T00:00:00Z"))).toBe(
      0,
    );
  });
});

describe("performance evidence", () => {
  const base = {
    sampleSize: 3,
    impressions: 5000,
    clicks: 50,
    conversions: 0,
    revenueMicros: 0,
    costMicros: 300_000,
    brandMedianCtr: 0.01,
  };

  it("classifies unproven, promising, high and proven winners", () => {
    expect(performanceLevel({ ...base, sampleSize: 0, impressions: 0, clicks: 0 }).level).toBe("UNPROVEN");
    expect(performanceLevel({ ...base, clicks: 30 }).level).toBe("UNPROVEN"); // 0.6% < median 1%
    expect(performanceLevel({ ...base, impressions: 1000, clicks: 11 }).level).toBe("PROMISING");
    expect(performanceLevel({ ...base, clicks: 70 }).level).toBe("HIGH");
    expect(performanceLevel({ ...base, clicks: 90, conversions: 4, revenueMicros: 2_000_000 }).level).toBe(
      "PROVEN_WINNER",
    );
  });
});

describe("performance profile (learning loop)", () => {
  const rec = (o: Partial<ContentPerformanceRecord>): ContentPerformanceRecord => ({
    projectId: Math.random().toString(36),
    platform: "TIKTOK",
    hookStyle: "question",
    angle: "comparison",
    ctaType: "link_in_bio",
    durationMs: 22_000,
    templateKey: "vertical-bold",
    tier: "TIER_0",
    productTitle: "Drill",
    postedAt: t(12),
    impressions: 1000,
    clicks: 10,
    conversions: 0,
    revenueMicros: 0,
    costMicros: 50_000,
    completionRate: 0.3,
    ...o,
  });

  it("surfaces winning and losing patterns and renders prompt text", () => {
    const records = [
      ...Array.from({ length: 4 }, () => rec({ hookStyle: "problem_solution", clicks: 30 })),
      ...Array.from({ length: 4 }, () => rec({ hookStyle: "question", clicks: 8 })),
      ...Array.from({ length: 3 }, () => rec({ hookStyle: "pov", clicks: 4, durationMs: 41_000 })),
    ];
    const summary = buildPerformanceProfile(records, { minSample: 3 });
    expect(summary.primaryMetric).toBe("ctr");
    expect(summary.high.some((s) => s.dimension === "hookStyle" && s.value === "problem_solution")).toBe(
      true,
    );
    expect(summary.low.some((s) => s.dimension === "hookStyle" && s.value === "pov")).toBe(true);
    const text = profileToPromptText(summary);
    expect(text).toContain("HIGH PERFORMING");
    expect(text).toContain('hook style "problem_solution"');
    expect(text).toContain("LOW PERFORMING");
  });

  it("switches to revenue (RPM) as the primary metric once there is revenue", () => {
    const summary = buildPerformanceProfile([rec({ revenueMicros: 1_000_000 }), rec({})], { minSample: 1 });
    expect(summary.primaryMetric).toBe("rpm");
  });

  it("buckets durations", () => {
    expect(durationBucket(22_000)).toBe("20-25s");
    expect(durationBucket(45_000)).toBe("40s+");
  });
});
