import { describe, expect, it } from "vitest";
import { idempotencyKey, seededRandom, stableStringify } from "./hash.ts";
import { maxSimilarity, normalizeText, textSimilarity } from "./similarity.ts";
import { extractJson } from "./json.ts";
import { classifyError, BudgetBlockedError, ProviderError, FatalError, TimeoutError } from "./errors.ts";

describe("similarity", () => {
  it("normalizes punctuation, case and emoji", () => {
    expect(normalizeText("Stop Wasting Money!!! 🔥")).toBe("stop wasting money");
  });

  it("detects near-duplicate hooks", () => {
    const a = "Stop wasting money on cheap drill bits";
    const b = "Stop wasting money on cheap drill bits!";
    const c = "Three skincare mistakes that age your skin";
    expect(textSimilarity(a, b)).toBeGreaterThan(0.9);
    expect(textSimilarity(a, c)).toBeLessThan(0.2);
    expect(maxSimilarity(a, [c, b]).index).toBe(1);
  });
});

describe("hashing", () => {
  it("stable stringify ignores key order and undefined", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
  });

  it("idempotency keys are deterministic", () => {
    const k1 = idempotencyKey("asset", { project: "p1", scene: 2, rev: 1 });
    const k2 = idempotencyKey("asset", { rev: 1, scene: 2, project: "p1" });
    const k3 = idempotencyKey("asset", { project: "p1", scene: 2, rev: 2 });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1.startsWith("asset:")).toBe(true);
  });

  it("seeded random is deterministic", () => {
    const r1 = seededRandom("abc");
    const r2 = seededRandom("abc");
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});

describe("extractJson", () => {
  it("parses fenced and prefixed JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":[1,2]} hope that helps')).toEqual({ a: [1, 2] });
  });
  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("classifyError", () => {
  it("classifies errors for the job runner", () => {
    expect(classifyError(new BudgetBlockedError([]))).toBe("budget_blocked");
    expect(classifyError(new ProviderError("x", "rate limited", { status: 429 }))).toBe("retryable");
    expect(classifyError(new ProviderError("x", "bad request", { status: 400 }))).toBe("fatal");
    expect(classifyError(new ProviderError("x", "server", { status: 503 }))).toBe("retryable");
    expect(classifyError(new FatalError("nope"))).toBe("fatal");
    expect(classifyError(new TimeoutError("slow"))).toBe("retryable");
  });
});
