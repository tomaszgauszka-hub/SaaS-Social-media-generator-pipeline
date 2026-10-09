import { describe, expect, it } from "vitest";
import type { QaReport } from "../contracts/manifest.ts";
import type { ShotClip, TextElement } from "../contracts/media.ts";
import { BrandProfile, PLATFORM_PROFILES } from "../contracts/profiles.ts";
import { testPlan } from "../testing/fixtures.ts";
import {
  brandingRules,
  captionRules,
  contrastRatio,
  ctaRules,
  productRules,
  scoreReport,
  technicalRules,
  textRules,
  toPx,
  type TechMeasure,
} from "./checks.ts";
import { planRetry } from "./retry.ts";
import { productRectAt } from "./run.ts";
import { cropFor, judgeFrame, parseSignalstats } from "./visual.ts";

const tiktok = PLATFORM_PROFILES.tiktok;
const plan = testPlan({ durationMs: 5000 });

const goodTech: TechMeasure = {
  durationMs: 5000,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: "h264",
  pixFmt: "yuv420p",
  audioCodec: "aac",
  audioSampleRate: 48000,
  audioChannels: 2,
  frameCount: 150,
  decodeErrors: 0,
  sizeBytes: 3_000_000,
  loudness: { I: -14.2, TP: -2.1, LRA: 4 },
  black: [],
  freezes: [],
};

const brand = BrandProfile.parse({
  brandId: "b",
  brandName: "Homely Finds",
  colors: {
    primary: "#2B2420",
    secondary: "#F4EBDD",
    accent: "#E8A33D",
    text: "#FFFFFF",
    background: "#1C1714",
  },
  fonts: {
    display: { family: "Inter", file: "x.otf" },
    body: { family: "Inter", file: "x.otf" },
    captions: { family: "Inter", file: "x.otf" },
  },
  voicePersona: { id: "p", description: "d" },
  captionStyle: {},
  musicStyle: { genres: ["deep_house"], moods: ["warm"] },
  visualStyle: {},
  targetMarkets: [{ market: "PL", locale: "pl-PL" }],
  disclosure: { "pl-PL": "Reklama · link afiliacyjny" },
});

const text = (over: Partial<TextElement>): TextElement => ({
  id: "cta",
  kind: "cta",
  text: "Link w bio",
  startMs: 3500,
  endMs: 5000,
  box: { x: 330, y: 246, w: 420, h: 90 },
  align: "center",
  fontSizePx: 72,
  font: { family: "Inter", file: "x.otf" },
  color: "#FFFFFF",
  panel: { color: "#1C1714", opacity: 0.62, radius: 26, padding: 22 },
  ...over,
});

const ids = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe("technical rules", () => {
  it("passes a conforming file (the 5 s fixture is only below TikTok's 7 s minimum)", () => {
    expect(ids(technicalRules(goodTech, plan, tiktok))).toEqual(["platform_duration"]);
  });

  it("flags geometry, frames, loudness and black with fix codes", () => {
    const r = technicalRules(
      {
        ...goodTech,
        width: 720,
        frameCount: 140,
        loudness: { I: -20, TP: -0.5, LRA: 4 },
        black: [{ startMs: 1000, endMs: 1600 }],
        audioChannels: 0,
        audioSampleRate: 0,
      },
      plan,
      tiktok,
    );
    expect(ids(r)).toEqual(
      expect.arrayContaining([
        "resolution",
        "missing_frames",
        "loudness",
        "true_peak",
        "black_frames",
        "audio_missing",
      ]),
    );
    expect(r.issues.find((i) => i.code === "loudness")?.fix).toBe("renormalize");
  });

  it("ignores black inside a planned fade-through-black", () => {
    const p = testPlan();
    p.shots[1]!.transitionIn = { type: "fadeblack", ms: 400 };
    const r = technicalRules({ ...goodTech, black: [{ startMs: 1500, endMs: 1800 }] }, p, tiktok);
    expect(ids(r)).not.toContain("black_frames");
  });
});

describe("product visibility", () => {
  const clip = (shotId: string, rect: { x: number; y: number; w: number; h: number }): ShotClip => ({
    shotId,
    path: "",
    durationMs: 1500,
    width: 1080,
    height: 1920,
    fps: 30,
    productTrack: [{ tMs: 0, rect }],
    cacheHit: false,
    renderMs: 0,
    encodeMs: 0,
  });

  it("accepts a well-framed product, reports cut and small products with reframe fixes", () => {
    const r = productRules(plan, [
      clip("sh01", { x: 240, y: 500, w: 600, h: 1100 }),
      clip("sh02", { x: 700, y: 500, w: 600, h: 1100 }),
      clip("sh03", { x: 480, y: 900, w: 120, h: 200 }),
    ]);
    expect(r.issues.map((i) => i.fix)).toEqual(["reframe:sh02:-fill", "reframe:sh03:+fill"]);
  });

  it("allows macro close-ups to exceed the frame", () => {
    const p = testPlan();
    p.shots[0]!.preset = "macro_push";
    const r = productRules(p, [clip("sh01", { x: -200, y: -100, w: 1500, h: 2200 })]);
    expect(r.issues).toEqual([]);
  });

  it("reads normalised or pixel rects and finds the box at a reel time", () => {
    expect(toPx({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1080, 1920)).toEqual({
      x: 270,
      y: 960,
      w: 540,
      h: 480,
    });
    const clips = [clip("sh02", { x: 0.2, y: 0.2, w: 0.6, h: 0.6 })];
    expect(productRectAt(plan, clips, 2000)).toEqual({ x: 216, y: 384, w: 648, h: 1152 });
    expect(productRectAt(plan, clips, 100)).toBeNull();
  });
});

describe("text, captions, CTA, branding", () => {
  it("contrast follows WCAG", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21);
    expect(contrastRatio("#2B2420", "#E8A33D")).toBeGreaterThan(4.5);
  });

  it("flags text in the platform UI and captions over the bottom bar", () => {
    const t = textRules([text({ box: { x: 330, y: 60, w: 420, h: 90 } })], tiktok);
    expect(ids(t)).toContain("text_unsafe");
    const c = captionRules(
      {
        style: "word_highlight",
        phrases: [],
        font: { family: "Inter", file: "x" },
        fontSizePx: 64,
        color: "#FFFFFF",
        highlightColor: "#E8A33D",
        outlineColor: "#000",
        box: { x: 72, y: 1500, w: 936, h: 200 },
        uppercase: false,
      },
      tiktok,
    );
    expect(c.issues[0]).toMatchObject({ code: "captions_unsafe", fix: "reposition_captions" });
  });

  it("asks for a longer CTA with the missing time in the fix code", () => {
    const p = testPlan();
    p.cta.startMs = 4000;
    const r = ctaRules(p, [text({})], tiktok);
    expect(r.issues[0]).toMatchObject({ code: "cta_short", fix: "extend_cta:800" });
  });

  it("requires the affiliate disclosure for the whole reel", () => {
    const missing = brandingRules(plan, brand, [text({})], false);
    expect(missing.issues.find((i) => i.code === "disclosure_missing")?.severity).toBe("blocker");
    const ok = brandingRules(
      plan,
      brand,
      [text({}), text({ id: "disclosure", kind: "disclosure", text: "Reklama", startMs: 0, endMs: 5000 })],
      true,
    );
    expect(ids(ok)).toEqual([]);
  });
});

describe("score + retry", () => {
  it("scores by severity, blends visual QA, fails on blockers", () => {
    expect(scoreReport([], undefined)).toEqual({ score: 100, passed: true, rerenderRequired: false });
    const s = scoreReport(
      [{ code: "product_cut", severity: "major", message: "", fix: "reframe:sh02:-fill" }],
      { score: 60, rerenderRequired: false },
    );
    expect(s).toEqual({ score: 81, passed: true, rerenderRequired: true });
    expect(
      scoreReport([{ code: "disclosure_missing", severity: "blocker", message: "" }], undefined).passed,
    ).toBe(false);
  });

  const report = (fixes: string[]): QaReport => ({
    score: 50,
    passed: false,
    rerenderRequired: true,
    checks: [],
    issues: fixes.map((fix) => ({ code: "x", severity: "major", message: "", fix })),
    frames: [],
    retries: [],
  });

  it("patches framing, captions, CTA timing and loudness deterministically", () => {
    const p = testPlan();
    p.cta.startMs = 4000;
    const { fixes, patched } = planRetry(
      report(["reframe:sh02:-fill", "reposition_captions", "extend_cta:800", "renormalize", "unknown"]),
      p,
    );
    expect(fixes).toEqual(["extend_cta:800", "reframe:sh02:-fill", "renormalize", "reposition_captions"]);
    expect(patched.shots[1]!.params.fill).toBeCloseTo(0.62 * 0.85);
    expect(patched.captions.offsetYPx).toBe(-120);
    expect(patched.render_profile.audio.truePeakDb).toBe(-2.5);
    // CTA shot sh03 starts 800 ms earlier, sh02 is 800 ms shorter, total unchanged
    expect(patched.shots.map((s) => [s.startMs, s.durationMs])).toEqual([
      [0, 1500],
      [1500, 1200],
      [2700, 2300],
    ]);
    expect(patched.cta.startMs).toBe(3200);
    expect(p.shots[1]!.durationMs).toBe(2000); // input untouched
  });

  it("does not shorten a shot below 900 ms and returns the same plan when nothing applies", () => {
    const p = testPlan();
    const r = planRetry(report(["extend_cta:1500"]), p);
    expect(r.fixes).toEqual([]);
    expect(r.patched).toBe(p);
  });
});

describe("deterministic visual QA", () => {
  it("parses signalstats and judges exposure / product region", () => {
    const s = parseSignalstats(
      "lavfi.signalstats.YAVG=120.5\nlavfi.signalstats.YLOW=30\nlavfi.signalstats.YHIGH=210",
    );
    expect(s).toEqual({ yavg: 120.5, ylow: 30, yhigh: 210 });
    expect(judgeFrame(0, s, { ...s, edges: 3 }).issues).toEqual([]);
    expect(judgeFrame(0, { yavg: 14, ylow: 10, yhigh: 20 }).issues.map((i) => i.code)).toEqual([
      "frame_crushed",
      "frame_flat",
    ]);
    expect(judgeFrame(0, s, { yavg: 200, ylow: 199, yhigh: 203, edges: 0 }).issues[0]!.code).toBe(
      "product_blank",
    );
    expect(cropFor({ x: -10, y: 1800, w: 600, h: 400 }, 1080, 1920)).toBe("crop=600:120:0:1800");
  });
});
