import { describe, expect, it } from "vitest";
import { PLATFORM_PROFILES } from "../contracts/profiles.ts";
import { loadBrandProfile } from "../factory/profiles.ts";
import { testPlan } from "../testing/fixtures.ts";
import { buildCaptionTrack, captionWord } from "./captions.ts";
import { estimateWords } from "./voice/align.ts";

describe("captionWord", () => {
  it.each([
    ["podstawa,", "pl", "podstawa"],
    ["tkaniny.", "pl", "tkaniny"],
    ["ponuro?", "pl", "ponuro?"],
    ["Licht –", "de", "Licht"],
    ["(neu)", "de", "neu"],
    // suspended compounds keep their hyphen
    ["Lese-", "de", "Lese-"],
    ["Holz-", "de", "Holz-"],
    ["2-", "de", "2-"],
    // ordinal dots stay where the language writes them
    ["3.", "de", "3."],
    ["3.", "pl", "3."],
    ["3.", "en", "3"],
    // closing quotes go with the opening ones
    ["„Smart“", "de", "Smart"],
    ["„Licht”", "pl", "Licht"],
    ['"smart"', "en", "smart"],
    ["leuchtet.“", "de", "leuchtet"],
    ["„Smart?“", "de", "Smart?"],
  ])("%s (%s) → %s", (text, lang, shown) => {
    expect(captionWord(text, lang)).toBe(shown);
  });
});

describe("caption phrases", () => {
  const brand = loadBrandProfile("assets/brands/homely-finds/brand.json");
  const phrases = (text: string, locale = "de-DE") => {
    const plan = testPlan({
      copy: {
        locale,
        market: "DE",
        slots: {},
        transcreation: { provider: "master", model: "-", sourceLocale: locale, isMaster: true },
      },
    });
    const track = buildCaptionTrack({
      voice: { words: estimateWords(text, 4000, locale, 0) },
      plan,
      platform: PLATFORM_PROFILES.tiktok,
      brand,
    });
    return track.phrases.map((p) => p.words.map((w) => w.text).join(" "));
  };

  it("ends a phrase after a German closing quote, not after an ordinal dot", () => {
    expect(phrases("Die 3. Generation „leuchtet.“ Jetzt kaufen")).toEqual([
      "Die 3. Generation leuchtet",
      "Jetzt kaufen",
    ]);
  });
});
