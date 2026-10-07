import { describe, expect, it } from "vitest";
import {
  EMPTY_LIMITS,
  evaluateBudget,
  evaluateRegenerationLimit,
  type BudgetCheckInput,
} from "./budget-evaluate.ts";

const usd = (n: number) => Math.round(n * 1_000_000);

function input(overrides: Partial<BudgetCheckInput> = {}): BudgetCheckInput {
  return {
    requestMicros: usd(0.1),
    isAiVideo: false,
    isMock: false,
    brandLimits: {
      ...EMPTY_LIMITS,
      dailyMicros: usd(1),
      weeklyMicros: usd(5),
      monthlyMicros: usd(15),
      contentCapMicros: usd(0.5),
      aiVideoCapMicros: usd(0.3),
      maxRegenerations: 3,
    },
    workspaceLimits: { ...EMPTY_LIMITS, dailyMicros: usd(3), monthlyMicros: usd(40) },
    hardDailyMicros: usd(5),
    spend: {
      brand: { day: 0, week: 0, month: 0 },
      workspace: { day: 0, week: 0, month: 0 },
      systemRealDay: 0,
      content: { total: 0, aiVideo: 0 },
    },
    ...overrides,
  };
}

describe("evaluateBudget", () => {
  it("allows operations within every limit and reports headroom", () => {
    const d = evaluateBudget(input());
    expect(d.allowed).toBe(true);
    // tightest applicable limit: the $0.50 per-content cap (AI-video cap only applies to video operations)
    expect(d.headroomMicros).toBe(usd(0.5));
  });

  it("blocks when the brand daily budget would be exceeded", () => {
    const d = evaluateBudget(
      input({ spend: { ...input().spend, brand: { day: usd(0.95), week: usd(1), month: usd(1) } } }),
    );
    expect(d.allowed).toBe(false);
    expect(d.reasons.map((r) => `${r.scope}:${r.limit}`)).toEqual(["brand:daily"]);
    expect(d.reasons[0]!.message).toMatch(/Brand daily budget/);
  });

  it("blocks on the per-content cap (≤ $0.50 per video)", () => {
    const d = evaluateBudget(
      input({
        requestMicros: usd(0.25),
        spend: { ...input().spend, content: { total: usd(0.3), aiVideo: 0 } },
      }),
    );
    expect(d.reasons.map((r) => r.limit)).toEqual(["content_cap"]);
  });

  it("applies the AI-video cap only to AI video operations", () => {
    const spend = { ...input().spend, content: { total: usd(0.1), aiVideo: usd(0.25) } };
    expect(
      evaluateBudget(input({ requestMicros: usd(0.1), isAiVideo: true, spend })).reasons.map((r) => r.limit),
    ).toEqual(["ai_video_cap"]);
    expect(evaluateBudget(input({ requestMicros: usd(0.1), isAiVideo: false, spend })).allowed).toBe(true);
  });

  it("enforces global workspace budgets", () => {
    const d = evaluateBudget(
      input({ spend: { ...input().spend, workspace: { day: usd(2.95), week: 0, month: usd(3) } } }),
    );
    expect(d.reasons.map((r) => `${r.scope}:${r.limit}`)).toEqual(["workspace:daily"]);
  });

  it("applies the system hard cap to real money only", () => {
    const spend = { ...input().spend, systemRealDay: usd(4.95) };
    expect(evaluateBudget(input({ spend })).reasons.map((r) => r.limit)).toEqual(["hard_daily"]);
    expect(evaluateBudget(input({ spend, isMock: true })).allowed).toBe(true);
  });

  it("always allows free operations even when budgets are exhausted", () => {
    const spend = { ...input().spend, brand: { day: usd(5), week: usd(5), month: usd(5) } };
    expect(evaluateBudget(input({ requestMicros: 0, spend })).allowed).toBe(true);
  });

  it("returns several reasons at once", () => {
    const d = evaluateBudget(
      input({
        requestMicros: usd(2),
        spend: { ...input().spend },
      }),
    );
    // brand daily ($1) and content cap ($0.50) are exceeded; workspace daily ($3) and hard cap ($5) are not
    expect(d.reasons.map((r) => `${r.scope}:${r.limit}`).sort()).toEqual([
      "brand:daily",
      "content:content_cap",
    ]);
  });

  it("treats null limits as unlimited", () => {
    const d = evaluateBudget(
      input({ brandLimits: null, workspaceLimits: null, hardDailyMicros: null, requestMicros: usd(100) }),
    );
    expect(d.allowed).toBe(true);
    expect(d.headroomMicros).toBeNull();
  });

  it("limits regenerations", () => {
    expect(evaluateRegenerationLimit({ ...EMPTY_LIMITS, maxRegenerations: 3 }, 2)).toBeNull();
    expect(evaluateRegenerationLimit({ ...EMPTY_LIMITS, maxRegenerations: 3 }, 3)?.limit).toBe(
      "regenerations",
    );
    expect(evaluateRegenerationLimit(null, 99)).toBeNull();
  });
});
