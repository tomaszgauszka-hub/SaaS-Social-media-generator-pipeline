import { describe, expect, it } from "vitest";
import { echoes, unitEconomics, withoutTextEcho } from "./factory.ts";

const plan = (spoken: string, shown: string) => ({
  copy: {
    locale: "pl-PL",
    market: "PL",
    slots: {
      hook: { kind: "hook" as const, text: shown, factIds: [] },
      "voice.1.hook": { kind: "voice" as const, text: spoken, factIds: [] },
    },
    transcreation: { provider: "t", model: "t", sourceLocale: "pl-PL", isMaster: true },
  },
});
const phrases = [
  { startMs: 250, endMs: 1400 },
  { startMs: 2400, endMs: 3800 },
];
const texts = [{ kind: "hook", startMs: 150, endMs: 2170 }];

describe("caption echo", () => {
  it("drops captions that repeat the on-screen hook, keeps the rest", () => {
    expect(
      withoutTextEcho(phrases, texts, plan("Poczekaj, aż się zaświeci.", "Poczekaj, aż się zaświeci")),
    ).toEqual([phrases[1]]);
    expect(withoutTextEcho(phrases, texts, plan("Inna linia.", "Poczekaj, aż się zaświeci"))).toEqual(
      phrases,
    );
  });

  it("recognises the spoken CTA of every language as an echo of the CTA panel", () => {
    expect(echoes("Link znajdziesz w bio.", "Link w bio")).toBe(true);
    expect(echoes("Find the link in the bio.", "Link in bio")).toBe(true);
    expect(echoes("Den Link findest du in der Bio.", "Link in der Bio")).toBe(true);
    expect(echoes("Tienes el enlace en la bio.", "Enlace en la bio")).toBe(true);
    // a longer line that merely mentions the link is not an echo
    expect(echoes("Orzechowa podstawa i mosiężny trzon, a link znajdziesz w bio.", "Link w bio")).toBe(false);
  });

  it("drops only the CTA voice segment's phrases under the CTA panel", () => {
    const p = {
      copy: {
        ...plan("x", "y").copy,
        slots: {
          cta: { kind: "cta" as const, text: "Link w bio", factIds: [] },
          "voice.3.desire": {
            kind: "voice" as const,
            text: "Wieczór w zupełnie innym świetle.",
            factIds: [],
          },
          "voice.4.cta": { kind: "voice" as const, text: "Link znajdziesz w bio.", factIds: [] },
        },
      },
    };
    const ph = [
      { startMs: 9_200, endMs: 9_900 }, // end of the desire line, already under the CTA panel
      { startMs: 10_200, endMs: 11_800 }, // the spoken CTA
    ];
    const segments = [
      { slot: "voice.3.desire", startMs: 7_600, endMs: 9_950 },
      { slot: "voice.4.cta", startMs: 10_150, endMs: 11_850 },
    ];
    expect(withoutTextEcho(ph, [{ kind: "cta", startMs: 9_100, endMs: 12_000 }], p, segments)).toEqual([
      ph[0],
    ]);
  });
});

describe("unit economics", () => {
  it("adds host time to API spend, divides by reels and computes break-even sales", () => {
    const e = unitEconomics({
      apiUsd: 0.02,
      wallMs: 3_600_000,
      usdPerHour: 0.15,
      reels: 10,
      commission: { commissionUsd: 2 },
    });
    expect(e).toMatchObject({ computeUsd: 0.15, totalUsd: 0.17, perReelUsd: 0.017, breakEvenSales: 1 });
    expect(
      unitEconomics({ apiUsd: 0, wallMs: 0, usdPerHour: 0.15, reels: 1, commission: {} }).breakEvenSales,
    ).toBeUndefined();
  });
});
