import { describe, expect, it } from "vitest";
import { estimateTierCost, routeGeneration, type CostModelInput, type RouterInput } from "./router.ts";
import { PRIORS, scoreOpportunity, valuePerConversion, type OpportunityInput } from "../strategy/scoring.ts";

const usd = (n: number) => Math.round(n * 1_000_000);

const costModel: CostModelInput = {
  llmMicros: usd(0.01),
  imageMicros: (c) => (c === "cheap" ? usd(0.009) : c === "standard" ? usd(0.075) : usd(0.12)),
  videoMicros: (c, s) =>
    Math.max(5, s) * (c === "cheap" ? usd(0.05) : c === "standard" ? usd(0.09) : usd(0.28)),
  ttsMicros: usd(0.006),
  bgRemovalMicros: usd(0.002),
  requestedGeneratedImages: 3,
  requestedAiShots: 1,
  useVoiceover: true,
  productImages: 1,
};

function input(overrides: Partial<RouterInput> = {}): RouterInput {
  return {
    format: "SHORT_VIDEO",
    expectedValueMicros: usd(5),
    performance: { level: "UNPROVEN", reasons: [] },
    requestedQuality: "STANDARD",
    brand: { maxTier: "TIER_3", allowAiVideo: true },
    budget: {
      headroomMicros: usd(1),
      contentCapMicros: usd(0.5),
      aiVideoCapMicros: usd(0.3),
      spentOnContentMicros: 0,
    },
    costModel,
    ...overrides,
  };
}

describe("tier cost model", () => {
  it("keeps Tier 0 and Tier 1 under the $0.50 target", () => {
    expect(estimateTierCost("TIER_0", costModel).totalMicros).toBeLessThan(usd(0.05));
    expect(estimateTierCost("TIER_1", costModel).totalMicros).toBeLessThan(usd(0.5));
    expect(estimateTierCost("TIER_0", costModel).aiVideoMicros).toBe(0);
    // shots = min(tier allowance, shots the visual plan asks for)
    expect(estimateTierCost("TIER_3", costModel).aiVideoMicros).toBe(1 * 5 * usd(0.28));
    expect(estimateTierCost("TIER_3", { ...costModel, requestedAiShots: 5 }).aiVideoMicros).toBe(
      3 * 5 * usd(0.28),
    );
  });
});

describe("MediaGenerationRouter", () => {
  it("never spends on unproven ideas: UNPROVEN → TIER_0", () => {
    const d = routeGeneration(input());
    expect(d.tier).toBe("TIER_0");
    expect(d.blocked).toBe(false);
    expect(d.reasons[0]).toMatch(/UNPROVEN → base TIER_0/);
  });

  it("promising products get one cheap AI shot", () => {
    expect(
      routeGeneration(input({ performance: { level: "PROMISING", reasons: ["CTR above median"] } })).tier,
    ).toBe("TIER_1");
  });

  it("downgrades when the plan would exceed the per-content or AI-video caps", () => {
    const d = routeGeneration(
      input({ performance: { level: "PROVEN_WINNER", reasons: [] }, requestedQuality: "PREMIUM" }),
    );
    expect(d.baseTier).toBe("TIER_3");
    expect(d.tier).toBe("TIER_1");
    expect(d.reasons.some((r) => r.includes("AI video") || r.includes("per-content cap"))).toBe(true);
  });

  it("proven winners reach Tier 3 when budget and value allow", () => {
    const d = routeGeneration(
      input({
        performance: { level: "PROVEN_WINNER", reasons: [] },
        expectedValueMicros: usd(50),
        budget: {
          headroomMicros: usd(20),
          contentCapMicros: usd(10),
          aiVideoCapMicros: usd(5),
          spentOnContentMicros: 0,
        },
      }),
    );
    expect(d.tier).toBe("TIER_3");
  });

  it("PREMIUM never lifts an unproven idea above Tier 1", () => {
    const d = routeGeneration(
      input({
        requestedQuality: "PREMIUM",
        expectedValueMicros: usd(100),
        budget: {
          headroomMicros: null,
          contentCapMicros: null,
          aiVideoCapMicros: null,
          spentOnContentMicros: 0,
        },
      }),
    );
    expect(d.tier).toBe("TIER_1");
  });

  it("respects brand ceilings, AI-video permission, DRAFT and non-video formats", () => {
    const high = {
      performance: { level: "HIGH" as const, reasons: [] },
      expectedValueMicros: usd(20),
      budget: {
        headroomMicros: null,
        contentCapMicros: null,
        aiVideoCapMicros: null,
        spentOnContentMicros: 0,
      },
    };
    expect(routeGeneration(input({ ...high, brand: { maxTier: "TIER_1", allowAiVideo: true } })).tier).toBe(
      "TIER_1",
    );
    expect(routeGeneration(input({ ...high, brand: { maxTier: "TIER_3", allowAiVideo: false } })).tier).toBe(
      "TIER_0",
    );
    expect(routeGeneration(input({ ...high, requestedQuality: "DRAFT" })).tier).toBe("TIER_0");
    expect(routeGeneration(input({ ...high, format: "CAROUSEL" })).tier).toBe("TIER_0");
  });

  it("downgrades when cost is not justified by expected value", () => {
    const d = routeGeneration(
      input({
        performance: { level: "HIGH", reasons: [] },
        expectedValueMicros: usd(0.3),
        budget: {
          headroomMicros: null,
          contentCapMicros: null,
          aiVideoCapMicros: null,
          spentOnContentMicros: 0,
        },
      }),
    );
    expect(d.tier).toBe("TIER_0");
    expect(d.reasons.some((r) => r.includes("of expected value"))).toBe(true);
  });

  it("blocks when even Tier 0 does not fit the remaining budget", () => {
    const d = routeGeneration(
      input({
        budget: {
          headroomMicros: usd(0.001),
          contentCapMicros: null,
          aiVideoCapMicros: null,
          spentOnContentMicros: 0,
        },
      }),
    );
    expect(d.blocked).toBe(true);
    expect(d.reasons.at(-1)).toMatch(/BUDGET_BLOCKED/);
  });
});

describe("opportunity scoring", () => {
  const base: OpportunityInput = {
    idea: { angle: "before_you_buy", hookStrength: 8, purchaseIntent: 8, confidence: 0.7 },
    product: {
      priceMicros: usd(89),
      commissionRate: 0.04,
      commissionFixedMicros: null,
      kind: "PRODUCT",
      economicOutcome: "AFFILIATE_CLICK",
    },
    baseline: {
      expectedImpressions: PRIORS.expectedImpressions,
      ctr: PRIORS.ctr,
      conversionRate: 0.03,
      sampleSize: 0,
    },
    historicalLift: null,
    similarity: 0.1,
    relevance: 0.9,
    estimatedCostMicros: usd(0.03),
  };

  it("values conversions from commission or fixed payouts", () => {
    expect(valuePerConversion(base.product)).toBe(usd(3.56));
    expect(valuePerConversion({ ...base.product, commissionFixedMicros: usd(25) })).toBe(usd(25));
    expect(valuePerConversion({ ...base.product, priceMicros: null })).toBe(0);
  });

  it("produces bounded, explainable scores", () => {
    const s = scoreOpportunity(base);
    expect(s.totalScore).toBeGreaterThan(0);
    expect(s.totalScore).toBeLessThanOrEqual(100);
    expect(s.expectedProfitMicros).toBe(s.estimatedRevenueMicros - usd(0.03));
    expect(s.factors.note).toMatch(/estimate/i);
  });

  it("ranks high-intent, novel, lucrative ideas above weak duplicates", () => {
    const strong = scoreOpportunity(base);
    const weak = scoreOpportunity({
      ...base,
      idea: { angle: "how_to_use", hookStrength: 3, purchaseIntent: 2, confidence: 0.4 },
      similarity: 0.9,
    });
    expect(strong.totalScore).toBeGreaterThan(weak.totalScore * 2);
    const leads = scoreOpportunity({ ...base, product: { ...base.product, commissionFixedMicros: usd(25) } });
    expect(leads.estimatedRevenueMicros).toBeGreaterThan(strong.estimatedRevenueMicros);
  });

  it("confidence grows with data", () => {
    const fresh = scoreOpportunity(base);
    const seasoned = scoreOpportunity({ ...base, baseline: { ...base.baseline, sampleSize: 30 } });
    expect(seasoned.confidence).toBeGreaterThan(fresh.confidence);
  });
});
