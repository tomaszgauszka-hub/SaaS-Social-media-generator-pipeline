import { describe, expect, it } from "vitest";
import { TIER_PROFILES } from "../contracts/profiles.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import { decideGenerativeVideo, type GenerativeVideoContext } from "./generative-video.ts";

const shot = (id: string, preset: string, durationMs = 2000) =>
  ({ id, preset, durationMs }) as ReelPlan["shots"][number];
const plan = (shots: ReelPlan["shots"]) => ({ shots }) as ReelPlan;

const ctx = (over: Partial<GenerativeVideoContext> = {}): GenerativeVideoContext => ({
  tier: TIER_PROFILES.PREMIUM,
  enabled: true,
  envMaxSeconds: 2,
  jobAllows: true,
  existingAssets: new Set(),
  multiPartModel: false,
  remainingBudgetUsd: 5,
  usdPerSecond: 0.15,
  specialShots: new Set(),
  ...over,
});

describe("generative video decision engine", () => {
  it("never spends on shots the studio can render, and prefers existing assets", () => {
    const d = decideGenerativeVideo(
      plan([shot("sh01", "hero_reveal"), shot("sh02", "orbit")]),
      ctx({ existingAssets: new Set(["sh02"]) }),
    );
    expect(d.map((x) => x.rung)).toEqual(["local_render", "existing_asset"]);
    expect(d.every((x) => !x.used)).toBe(true);
  });

  it("approximates multi-part shots locally for single-mesh products instead of inventing parts", () => {
    const [d] = decideGenerativeVideo(plan([shot("sh01", "exploded_view")]), ctx());
    expect(d?.rung).toBe("local_approximation");
  });

  it("uses generative video only for special shots, within tier seconds, job opt-in and budget", () => {
    const special = new Set(["sh01", "sh02"]);
    const d = decideGenerativeVideo(
      plan([shot("sh01", "impact", 1500), shot("sh02", "impact", 1500)]),
      ctx({ specialShots: special }),
    );
    expect(d[0]).toMatchObject({ used: true, rung: "generative_video", seconds: 1.5 });
    expect(d[1]).toMatchObject({ used: false, rung: "refused" }); // 3 s > 2 s cap
    expect(
      decideGenerativeVideo(plan([shot("sh01", "impact")]), ctx({ specialShots: special, enabled: false }))[0]
        ?.used,
    ).toBe(false);
    expect(
      decideGenerativeVideo(
        plan([shot("sh01", "impact")]),
        ctx({ specialShots: special, jobAllows: false }),
      )[0]?.used,
    ).toBe(false);
    expect(
      decideGenerativeVideo(
        plan([shot("sh01", "impact")]),
        ctx({ specialShots: special, tier: TIER_PROFILES.STANDARD }),
      )[0]?.used,
    ).toBe(false);
    expect(
      decideGenerativeVideo(
        plan([shot("sh01", "impact")]),
        ctx({ specialShots: special, remainingBudgetUsd: 0.01 }),
      )[0]?.used,
    ).toBe(false);
  });
});
