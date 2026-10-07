import { describe, expect, it } from "vitest";
import { BENCHMARK_BRIEFS } from "./benchmark/briefs.ts";
import { CreativeBrief } from "./brief.ts";
import { directCreative, productFirstVisibleMs } from "./director.ts";
import { checkSafeZones } from "./safe-zones.ts";
import { readingTimeMs } from "./subtitles.ts";

const briefs = BENCHMARK_BRIEFS.map((b) => CreativeBrief.parse(b));

describe("CreativeDirector", () => {
  it("is deterministic — same brief, identical storyboard", () => {
    for (const b of briefs) expect(JSON.stringify(directCreative(b))).toBe(JSON.stringify(directCreative(b)));
  });

  it.each(briefs.map((b) => [b.id, b] as const))("%s follows the benchmark rules", (_id, brief) => {
    const { storyboard: sb, localePack } = directCreative(brief);
    const total = sb.beats.reduce((a, b) => a + b.durationMs, 0);
    expect(sb.beats.length).toBeGreaterThanOrEqual(6);
    expect(sb.beats.length).toBeLessThanOrEqual(10);
    expect(total).toBeGreaterThanOrEqual(15_000);
    expect(total).toBeLessThanOrEqual(30_000);
    expect(sb.beats[0]!.purpose).toBe("HOOK");
    expect(sb.beats[0]!.transitionIn.type).toBe("cut");
    expect(sb.beats[sb.beats.length - 1]!.purpose).toBe("CTA");
    expect(productFirstVisibleMs(sb)).not.toBeNull();
    expect(productFirstVisibleMs(sb)!).toBeLessThanOrEqual(1000);
    expect(sb.flags.demoOnly).toBe(true);
    expect(sb.flags.placeholderMedia).toBe(true);
    // every text element stays readable for its reading time
    for (const beat of sb.beats)
      for (const t of beat.text) {
        const visible = beat.durationMs - t.delayMs - t.exitBeforeEndMs;
        expect(readingTimeMs(localePack.strings[t.slot] ?? ""), `${t.slot}`).toBeLessThanOrEqual(visible);
      }
    // every text slot has source copy
    for (const slot of Object.keys(sb.textSlots)) expect(localePack.strings[slot]?.trim(), slot).toBeTruthy();
  });

  it("gives every category its own visual language", () => {
    const kits = briefs.map((b) => directCreative(b).storyboard.style);
    expect(new Set(kits.map((k) => k.kit)).size).toBe(6);
    expect(new Set(kits.map((k) => k.palette.accent)).size).toBe(6);
    expect(new Set(kits.map((k) => k.fonts.DISPLAY.family)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(briefs.map((b) => b.structure)).size).toBe(6);
  });
});

describe("safe zones", () => {
  it("flags text in the TikTok caption area and accepts the content area", () => {
    const v = checkSafeZones(
      [
        { id: "caption", rect: { x: 72, y: 1500, w: 600, h: 80 } },
        { id: "headline", rect: { x: 72, y: 200, w: 800, h: 200 } },
      ],
      ["TIKTOK"],
    );
    expect(v.map((x) => x.element)).toEqual(["caption"]);
  });
  it("flags text under the right-hand action rail", () => {
    const v = checkSafeZones(
      [{ id: "label", rect: { x: 900, y: 900, w: 160, h: 60 } }],
      ["TIKTOK", "INSTAGRAM"],
    );
    expect(v.length).toBeGreaterThan(0);
  });
});
