import { describe, expect, it } from "vitest";
import { BENCH_BEAUTY, BENCH_TOOLS } from "../benchmark/briefs.ts";
import { prepareCreative } from "../node.ts";
import { complianceQa, factualQa, localizationQa } from "./checks.ts";
import { creativeQa } from "./creative.ts";
import { evaluateGates } from "./gates.ts";
import type { TechnicalQaReport } from "./types.ts";

const tools = prepareCreative(BENCH_TOOLS);

const techPass: TechnicalQaReport = {
  version: 1,
  status: "PASS",
  checks: [],
  analysisMs: 0,
  metrics: {
    durationMs: tools.plan.durationMs,
    expectedDurationMs: tools.plan.durationMs,
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: "h264",
    pixFmt: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    sizeBytes: 1,
    bitRate: 1,
    integratedLufs: -14,
    truePeakDb: -2,
    loudnessRange: 4,
    blackSegments: [],
    blankSamples: 0,
    frozenSegments: [],
    staticSegments: [],
    silenceSegments: [],
    decodeErrors: 0,
    sceneCuts: 8,
    avgMotion: 3,
    beats: tools.plan.beats.map((b, i) => ({
      beatId: b.id,
      motion: 2,
      hash: (i * 0x1111111111111111).toString(16).padStart(16, "0").slice(-16),
      meanLuma: 80,
    })),
  },
};

describe("measured render plans", () => {
  it.each([BENCH_TOOLS, BENCH_BEAUTY])(
    "$id fits every text at readable sizes with no safe-zone issues",
    (brief) => {
      const p = prepareCreative(brief);
      expect(p.issues.filter((i) => i.severity === "blocker" || i.severity === "major")).toEqual([]);
      expect(p.plan.fonts.some((f) => f.family === "Inter" && f.weight === 700)).toBe(true);
      expect(p.plan.global.demoLabel).toMatch(/DEMO/);
    },
  );
});

describe("creative QA", () => {
  it("scores a complete benchmark reel above the creative gate", () => {
    const r = creativeQa({
      storyboard: tools.storyboard,
      plan: tools.plan,
      resolveIssues: tools.issues,
      technical: techPass,
    });
    expect(r.hardFails).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.factors.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "hook",
        "productVisibility",
        "sceneVariety",
        "pacing",
        "textDensity",
        "typography",
        "legibility",
        "cta",
        "repetition",
        "polish",
      ]),
    );
  });
  it("hard-fails a reel whose product never appears", () => {
    const sb = {
      ...tools.storyboard,
      media: tools.storyboard.media.map((m) => ({ ...m, role: "scene" as const, showsProduct: false })),
    };
    const r = creativeQa({
      storyboard: sb,
      plan: { ...tools.plan, media: Object.fromEntries(sb.media.map((m) => [m.id, m])) },
      resolveIssues: [],
    });
    expect(r.hardFails).toContain("Product is never shown");
    expect(r.score).toBeLessThanOrEqual(59);
  });
  it("hard-fails text that does not fit (too much copy)", () => {
    const long = {
      ...tools.localePack,
      strings: {
        ...tools.localePack.strings,
        "s01.hook":
          "This hook has far too many words to ever fit into the display box at any readable size whatsoever, honestly",
      },
    };
    const p = prepareCreative(BENCH_TOOLS, { localePack: long });
    const r = creativeQa({ storyboard: p.storyboard, plan: p.plan, resolveIssues: p.issues });
    expect(r.hardFails.some((f) => f.includes("do not fit"))).toBe(true);
  });
  it("penalises visually repeated beats", () => {
    const same: TechnicalQaReport = {
      ...techPass,
      metrics: {
        ...techPass.metrics,
        beats: techPass.metrics.beats.map((b) => ({ ...b, hash: "ffff0000ffff0000" })),
      },
    };
    const r = creativeQa({
      storyboard: tools.storyboard,
      plan: tools.plan,
      resolveIssues: tools.issues,
      technical: same,
    });
    expect(r.factors.find((f) => f.id === "repetition")!.score).toBe(0);
  });
});

describe("factual, compliance and localization QA", () => {
  it("accepts numbers from the brief and rejects invented ones", () => {
    expect(factualQa({ brief: tools.brief, pack: tools.localePack, plan: tools.plan }).score).toBe(100);
    const pack = {
      ...tools.localePack,
      strings: { ...tools.localePack.strings, "s01.hook": "Drives 500 screws on one charge" },
    };
    const r = factualQa({ brief: tools.brief, pack, plan: tools.plan });
    expect(r.status).toBe("FAIL");
    expect(r.checks[0]!.value).toBe("500");
  });
  it("flags fake testimonials and medical claims", () => {
    const pack = {
      ...tools.localePack,
      strings: {
        ...tools.localePack.strings,
        "s01.hook": "I tested it for a month",
        "s02.name": "Anti-aging glow",
      },
    };
    const r = complianceQa({ storyboard: tools.storyboard, plan: tools.plan, pack, affiliate: true });
    expect(r.status).toBe("FAIL");
    expect(r.checks.filter((c) => c.status === "fail").map((c) => c.id)).toEqual(
      expect.arrayContaining(["reviews", "medical"]),
    );
  });
  it("requires a visible disclosure for affiliate content", () => {
    const plan = { ...tools.plan, global: { ...tools.plan.global, disclosure: undefined } };
    expect(
      complianceQa({
        storyboard: tools.storyboard,
        plan,
        pack: tools.localePack,
        affiliate: true,
      }).checks.find((c) => c.id === "disclosure")!.status,
    ).toBe("fail");
  });
  it("detects a missing translation", () => {
    const pack = { ...tools.localePack, strings: { ...tools.localePack.strings, "s02.name": "" } };
    expect(localizationQa({ storyboard: tools.storyboard, pack, resolveIssues: [] }).status).toBe("FAIL");
  });
});

describe("quality gates", () => {
  const creative = creativeQa({
    storyboard: tools.storyboard,
    plan: tools.plan,
    resolveIssues: tools.issues,
    technical: techPass,
  });
  const factual = factualQa({ brief: tools.brief, pack: tools.localePack, plan: tools.plan });
  const compliance = complianceQa({
    storyboard: tools.storyboard,
    plan: tools.plan,
    pack: tools.localePack,
    affiliate: true,
  });
  const localization = localizationQa({
    storyboard: tools.storyboard,
    pack: tools.localePack,
    resolveIssues: tools.issues,
  });
  it("never marks demo media production ready, even when every gate passes", () => {
    const v = evaluateGates({
      technical: techPass,
      creative,
      factual,
      compliance,
      localization,
      flags: { placeholderMedia: true, demoOnly: true },
    });
    expect(v.allGatesPass).toBe(true);
    expect(v.productionReady).toBe(false);
    expect(v.label).toBe("NOT_PRODUCTION_READY");
  });
  it("is production ready only with real media and every gate passing", () => {
    const ok = evaluateGates({
      technical: techPass,
      creative,
      factual,
      compliance,
      localization,
      flags: { placeholderMedia: false, demoOnly: false },
    });
    expect(ok.label).toBe("PRODUCTION_READY");
    const strict = evaluateGates({
      technical: techPass,
      creative,
      factual,
      compliance,
      localization,
      flags: { placeholderMedia: false, demoOnly: false },
      thresholds: { creativeMin: 101 },
    });
    expect(strict.label).toBe("NEEDS_WORK");
  });
});
