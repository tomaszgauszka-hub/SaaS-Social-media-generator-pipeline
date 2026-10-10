import { FileFontMeasurer } from "@cre/creative/node";
import { describe, expect, it } from "vitest";
import type { ShotClip } from "../contracts/media.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import { PLATFORM_PROFILES } from "../contracts/profiles.ts";
import { loadBrandProfile } from "./profiles.ts";
import { bandsFor, buildTextElements } from "./layout.ts";

const brand = loadBrandProfile("assets/brands/homely-finds/brand.json");
const measurer = new FileFontMeasurer({
  "Inter|800": brand.fonts.display.file,
  "Inter|600": brand.fonts.body.file,
});

function plan(slots: Record<string, string>): ReelPlan {
  return {
    durationMs: 12_000,
    shots: [
      { id: "sh01", startMs: 0, durationMs: 2500 },
      { id: "sh02", startMs: 2500, durationMs: 3500, overlaySlot: "overlay.sh02" },
      { id: "sh03", startMs: 6000, durationMs: 3500, overlaySlot: "overlay.sh03" },
      { id: "sh04", startMs: 9500, durationMs: 2500 },
    ],
    cta: { slot: "cta", buttonSlot: "button", startMs: 9500, endMs: 12_000, style: "button" },
    branding: { disclosureSlot: "disclosure" },
    copy: {
      locale: "pl-PL",
      market: "PL",
      slots: Object.fromEntries(
        Object.entries(slots).map(([k, text]) => [k, { kind: "overlay", text, factIds: [] }]),
      ),
    },
  } as unknown as ReelPlan;
}

describe("text layout", () => {
  it("fits Polish copy inside the platform safe area and keeps the button under the CTA", () => {
    const { elements, issues } = buildTextElements({
      plan: plan({
        hook: "Jedno włączenie i salon robi się ciepły",
        "overlay.sh02": "Mosiężny trzon, orzechowa podstawa",
        "overlay.sh03": "Żarówka LED w zestawie",
        cta: "Sprawdź lampę",
        button: "Link w bio",
        disclosure: "Reklama · link afiliacyjny",
      }),
      brand,
      platform: PLATFORM_PROFILES.tiktok,
      measurer,
    });
    expect(issues).toEqual([]);
    expect(elements.map((e) => e.id)).toEqual([
      "hook",
      "overlay.sh02",
      "overlay.sh03",
      "cta",
      "button",
      "disclosure",
    ]);
    const bands = bandsFor(PLATFORM_PROFILES.tiktok);
    for (const e of elements) {
      expect(e.box.x).toBeGreaterThanOrEqual(40);
      expect(e.box.x + e.box.w).toBeLessThanOrEqual(1080 - 40);
      expect(e.box.y).toBeGreaterThanOrEqual(150);
      expect(e.box.y + e.box.h).toBeLessThanOrEqual(1560);
      expect(e.endMs).toBeGreaterThan(e.startMs);
    }
    const cta = elements.find((e) => e.id === "cta")!;
    const button = elements.find((e) => e.id === "button")!;
    expect(button.box.y).toBeGreaterThan(cta.box.y + cta.box.h);
    expect(elements.find((e) => e.id === "disclosure")!.box.y).toBe(bands.disclosureY);
  });

  it("reports copy that cannot fit instead of shrinking it below the readable minimum", () => {
    const long = "Bardzo długi tekst ".repeat(12);
    const { issues } = buildTextElements({
      plan: plan({ hook: long }),
      brand,
      platform: PLATFORM_PROFILES.tiktok,
      measurer,
    });
    expect(issues.map((i) => i.slot)).toContain("hook");
  });

  it("sets band text smaller when that keeps its panel off the product's top", () => {
    const p = plan({ hook: "Poczekaj, aż się zaświeci", cta: "Link w bio", button: "Sprawdź cenę" });
    Object.assign(p, { resolution: { width: 1080, height: 1920 } });
    for (const s of p.shots) Object.assign(s, { preset: "hero_reveal", params: { focus: "whole" } });
    const clips = (top: number): ShotClip[] =>
      p.shots.map((s) => ({
        shotId: s.id,
        path: "",
        durationMs: s.durationMs,
        width: 1080,
        height: 1920,
        fps: 30,
        productTrack: [{ tMs: 0, rect: { x: 128, y: top, w: 824, h: 1160 } }],
        cacheHit: false,
        renderMs: 0,
        encodeMs: 0,
      }));
    const platform = PLATFORM_PROFILES.tiktok;
    const hookOf = (c?: ShotClip[]) =>
      buildTextElements({ plan: p, brand, platform, measurer, ...(c ? { clips: c } : {}) }).elements.find(
        (e) => e.id === "hook",
      )!;
    const preferred = hookOf();
    expect(preferred).toMatchObject({ fontSizePx: 88, text: "Poczekaj, aż\nsię zaświeci" });
    // product top at 364 (the e2e lamp's shade): one line at 71 px ends 12 px above it
    const clear = hookOf(clips(364));
    expect(clear.text).toBe("Poczekaj, aż się zaświeci");
    expect(clear.fontSizePx).toBeGreaterThanOrEqual(54);
    expect(clear.box.y + clear.box.h + 22).toBeLessThanOrEqual(364 - 12);
    // a product far below the band changes nothing; one too high to clear keeps the preferred size (QA reports it)
    expect(hookOf(clips(700))).toEqual(preferred);
    expect(hookOf(clips(300))).toEqual(preferred);
  });
});
