import { describe, expect, it } from "vitest";
import { BENCH_BEAUTY, BENCH_TOOLS } from "../benchmark/briefs.ts";
import { prepareCreative } from "../node.ts";
import { creativeQa } from "./creative.ts";
import { visualCoverage } from "./coverage.ts";

describe("meaningful visual coverage", () => {
  it("counts image-led beats and keeps text-only time low for the benchmark reels", () => {
    for (const brief of [BENCH_TOOLS, BENCH_BEAUTY]) {
      const p = prepareCreative(brief);
      const c = visualCoverage(p.storyboard, p.plan);
      expect(c.meaningfulVisualCoverage, brief.id).toBeGreaterThanOrEqual(0.8);
      expect(c.textOnlyDurationRatio, brief.id).toBeLessThanOrEqual(0.15);
    }
  });

  it("classifies a reel of text cards as text-only and fails the creative gate", () => {
    const p = prepareCreative(BENCH_TOOLS);
    // strip every image: what is left is a slideshow of text on the kit background
    const plan = {
      ...p.plan,
      beats: p.plan.beats.map((b) => ({
        ...b,
        media: [],
        overlays: b.overlays.filter((o) => o.kind === "panel" || o.kind === "badge"),
      })),
    };
    const c = visualCoverage(p.storyboard, plan);
    expect(c.meaningfulVisualCoverage).toBe(0);
    expect(c.textOnlyDurationRatio).toBe(1);
    const qa = creativeQa({ storyboard: p.storyboard, plan, resolveIssues: p.issues });
    expect(qa.hardFails.some((f) => f.startsWith("Text-only frames"))).toBe(true);
    expect(qa.metrics.textOnlyDurationRatio).toBe(1);
  });

  it("tells the beauty story with niche shots — no list or feature slide", () => {
    const p = prepareCreative(BENCH_BEAUTY);
    const types = p.plan.beats.map((b) => b.type);
    expect(types).not.toContain("SPEC_CALLOUT");
    expect(types).not.toContain("SOCIAL_PROOF");
    expect(
      p.plan.beats.flatMap((b) => b.overlays).some((o) => o.kind === "spec_list" || o.kind === "checklist"),
    ).toBe(false);
    // benefits are a montage: consecutive full-bleed shots with different images, one chip each
    const montage = p.plan.beats.filter((b) => b.note.startsWith("Benefit montage"));
    expect(montage).toHaveLength(3);
    expect(new Set(montage.map((b) => b.media[0]!.assetId)).size).toBe(3);
    for (const b of montage) expect(b.overlays.filter((o) => o.kind === "icon_chip")).toHaveLength(1);
    // every beat has imagery behind it
    expect(new Set(p.plan.beats.map((b) => b.media[0]?.assetId)).size).toBeGreaterThanOrEqual(6);
  });
});
