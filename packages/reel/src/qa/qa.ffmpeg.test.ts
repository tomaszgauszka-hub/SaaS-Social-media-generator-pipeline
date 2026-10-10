import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFromRoot } from "@cre/config";
import { runFfmpeg } from "@cre/media";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeLocalized, composeMaster } from "../composer/compose.ts";
import type { ShotClip, TextElement } from "../contracts/media.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import { BrandProfile, PLATFORM_PROFILES } from "../contracts/profiles.ts";
import { BudgetGate, CostTracker } from "../cost/tracker.ts";
import { testPlan } from "../testing/fixtures.ts";
import { planRetry } from "./retry.ts";
import { runReelQa } from "./run.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const FONT = resolveFromRoot("assets/fonts/inter/Inter-ExtraBold.otf");
const platform = PLATFORM_PROFILES.tiktok;

/** 8 s variant of the fixture (TikTok needs ≥ 7 s) */
function plan8(): ReelPlan {
  const p = testPlan();
  const [a, b, c] = p.shots as [
    ReelPlan["shots"][number],
    ReelPlan["shots"][number],
    ReelPlan["shots"][number],
  ];
  Object.assign(a, { startMs: 0, durationMs: 2500 });
  Object.assign(b, { startMs: 2500, durationMs: 3000 });
  Object.assign(c, { startMs: 5500, durationMs: 2500 });
  return {
    ...p,
    durationMs: 8000,
    cta: { ...p.cta, startMs: 5800, endMs: 8000 },
    branding: { ...p.branding, logo: { ...p.branding.logo, endMs: 8000 } },
    voiceover: { ...p.voiceover, enabled: false },
  };
}

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
    display: { family: "Inter", file: FONT },
    body: { family: "Inter", file: FONT },
    captions: { family: "Inter", file: FONT },
  },
  voicePersona: { id: "p", description: "d" },
  captionStyle: {},
  musicStyle: { genres: ["deep_house"], moods: ["warm"] },
  visualStyle: {},
  targetMarkets: [{ market: "PL", locale: "pl-PL" }],
  disclosure: { "pl-PL": "Reklama · link afiliacyjny" },
});

const panel = { color: "#1C1714", opacity: 0.62, radius: 26, padding: 22 };
const texts: TextElement[] = [
  {
    id: "cta",
    kind: "cta",
    text: "Link w bio",
    startMs: 5800,
    endMs: 8000,
    box: { x: 330, y: 246, w: 420, h: 90 },
    align: "center",
    fontSizePx: 72,
    font: { family: "Inter", file: FONT },
    color: "#FFFFFF",
    panel,
  },
  {
    id: "disclosure",
    kind: "disclosure",
    text: "Reklama · link afiliacyjny",
    startMs: 0,
    endMs: 8000,
    box: { x: 48, y: 1486, w: 360, h: 34 },
    align: "left",
    fontSizePx: 28,
    font: { family: "Inter", file: FONT },
    color: "#FFFFFF",
    panel: { ...panel, color: "#000000", opacity: 0.45 },
  },
];

describe.skipIf(!hasFfmpeg)("runReelQa on real files", () => {
  let dir: string;
  const clips: ShotClip[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-qa-"));
    for (const s of plan8().shots) {
      const p = path.join(dir, `${s.id}.mp4`);
      await runFfmpeg([
        "-f",
        "lavfi",
        "-i",
        `testsrc2=s=540x960:r=30:d=${s.durationMs / 1000}`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        p,
      ]);
      clips.push({
        shotId: s.id,
        path: p,
        durationMs: s.durationMs,
        width: 540,
        height: 960,
        fps: 30,
        productTrack: [{ tMs: 0, rect: { x: 0.2, y: 0.25, w: 0.6, h: 0.5 } }],
        cacheHit: false,
        renderMs: 0,
        encodeMs: 0,
      });
    }
  }, 60_000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("passes a conforming reel and fails a broken one with the right fix codes", async () => {
    const plan = plan8();
    const music = path.join(dir, "music.wav");
    await runFfmpeg(["-f", "lavfi", "-i", "sine=f=180:r=48000:d=8", music]);
    const master = await composeMaster({ plan, clips, outPath: path.join(dir, "master.mp4"), workDir: dir });
    const good = await composeLocalized({
      plan,
      masterPath: master.path,
      music: {
        path: music,
        durationMs: 8000,
        bpm: 110,
        provider: "t",
        model: "t",
        license: "t",
        cached: false,
      },
      sfx: [],
      texts,
      platform,
      outPath: path.join(dir, "good.mp4"),
      posterPath: path.join(dir, "good.jpg"),
      workDir: dir,
    });
    const tracker = new CostTracker();
    const ctx = { workDir: dir, cacheDir: dir, scope: "pl-PL", tracker };
    const budget = new BudgetGate(0, tracker);
    const ok = await runReelQa({
      videoPath: good.path,
      plan,
      platform,
      clips,
      texts,
      brand,
      logoExpected: false,
      budget,
      ctx,
    });
    const failed = ok.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failed).toEqual([]);
    expect(ok.passed).toBe(true);
    expect(ok.frames).toHaveLength(5);
    // per platform: another platform's pass of the same variant + locale must not overwrite these frames
    expect(path.dirname(ok.frames[0]!.path)).toBe(
      path.join(dir, `qa-${plan.metadata.variantKey}-pl-PL-tiktok`),
    );
    expect(ok.visualQa?.provider).toBe("deterministic");

    // broken: wrong size, black second, silent audio, too short
    const broken = path.join(dir, "broken.mp4");
    await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=720x1280:r=30:d=6",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo:d=6",
      "-vf",
      "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,1,2.2)'",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      broken,
    ]);
    const bad = await runReelQa({
      videoPath: broken,
      plan,
      platform,
      clips,
      texts: texts.slice(0, 1),
      brand,
      logoExpected: false,
      budget,
      ctx,
    });
    const codes = bad.issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "resolution",
        "duration",
        "loudness",
        "black_frames",
        "disclosure_missing",
        "platform_duration",
      ]),
    );
    expect(bad.passed).toBe(false);
    expect(bad.rerenderRequired).toBe(true);
    expect(planRetry(bad, plan).fixes).toContain("renormalize");
  }, 180_000);
});
