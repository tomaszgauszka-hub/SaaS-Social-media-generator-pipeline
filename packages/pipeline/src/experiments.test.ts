import { describe, expect, it } from "vitest";
import { captionWithOpening, decideExperiment } from "./steps/experiments.ts";

describe("A/B decision rule", () => {
  it("is inconclusive without enough impressions per arm", () => {
    const d = decideExperiment([
      { key: "A", impressions: 120, clicks: 3 },
      { key: "B", impressions: 900, clicks: 20 },
    ]);
    expect(d.winner).toBeNull();
    expect(d.reason).toMatch(/impressions/);
  });

  it("picks the arm with a clearly higher CTR", () => {
    const d = decideExperiment([
      { key: "A", impressions: 1000, clicks: 10 },
      { key: "B", impressions: 1000, clicks: 15 },
    ]);
    expect(d.winner).toBe("B");
    expect(d.liftPct).toBe(50);
    expect(d.arms.find((a) => a.key === "A")?.ctr).toBeCloseTo(0.01);
  });

  it("refuses to call small differences", () => {
    const d = decideExperiment([
      { key: "A", impressions: 2000, clicks: 20 },
      { key: "B", impressions: 2000, clicks: 21 },
    ]);
    expect(d.winner).toBeNull();
    expect(d.liftPct).toBe(5);
  });

  it("handles an arm without clicks", () => {
    expect(
      decideExperiment([
        { key: "A", impressions: 500, clicks: 0 },
        { key: "B", impressions: 500, clicks: 4 },
      ]).winner,
    ).toBe("B");
    expect(
      decideExperiment([
        { key: "A", impressions: 500, clicks: 0 },
        { key: "B", impressions: 500, clicks: 0 },
      ]).winner,
    ).toBeNull();
  });
});

describe("captionWithOpening", () => {
  it("replaces only the opening paragraph and strips highlight markup", () => {
    expect(captionWithOpening("Old hook.\n\nBody one.\n\nLink in bio.", "New *hook*")).toBe(
      "New hook\n\nBody one.\n\nLink in bio.",
    );
  });
});
