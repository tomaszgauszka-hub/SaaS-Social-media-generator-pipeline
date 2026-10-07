import { describe, expect, it } from "vitest";
import type { FontSpec } from "./model.ts";
import { fitText, parseEmphasis, stripEmphasis, type TextMeasurer } from "./text-fit.ts";

/** monospace stand-in: every character is 0.5 em wide */
const mono: TextMeasurer = {
  advanceEm: (text) => [...text].length * 0.5,
  missingGlyphs: (text) => [...text].filter((c) => c === "☃"),
};
const font: FontSpec = {
  family: "Mono",
  weight: 700,
  style: "normal",
  letterSpacing: 0,
  transform: "none",
  lineHeight: 1.1,
};

describe("parseEmphasis", () => {
  it("keeps punctuation that follows emphasis attached to the word", () => {
    const words = parseEmphasis("*3 light tones*: warm, neutral");
    expect(words.map((w) => w.text)).toEqual(["3", "light", "tones:", "warm,", "neutral"]);
    expect(words[2]!.runs).toEqual([
      { text: "tones", emphasis: true },
      { text: ":", emphasis: false },
    ]);
  });
  it("never starts a line with a separator", () => {
    expect(parseEmphasis("Crevice nozzle · clear bin").map((w) => w.text)).toEqual([
      "Crevice",
      "nozzle ·",
      "clear",
      "bin",
    ]);
    expect(parseEmphasis("Plug in once — everything").map((w) => w.text)).toContain("once —");
  });
  it("drops unbalanced markers instead of rendering them", () => {
    expect(stripEmphasis("*bad marker")).toBe("bad marker");
  });
});

describe("fitText", () => {
  it("uses the largest size that fits", () => {
    const r = fitText(mono, {
      text: "Short",
      font,
      box: { w: 1000, h: 300 },
      maxLines: 2,
      minSize: 40,
      maxSize: 120,
    });
    expect(r.fits).toBe(true);
    expect(r.fontSize).toBe(120);
    expect(r.lines).toHaveLength(1);
  });
  it("shrinks towards the minimum but never below it, and flags overflow", () => {
    const text = "A sentence that is far too long for a tiny box at any readable size";
    const r = fitText(mono, { text, font, box: { w: 300, h: 100 }, maxLines: 2, minSize: 40, maxSize: 100 });
    expect(r.fits).toBe(false);
    expect(r.fontSize).toBe(40);
    expect(r.issues.map((i) => i.code)).toContain("TEXT_OVERFLOW");
  });
  it("reports a word wider than the box", () => {
    const r = fitText(mono, {
      text: "Supercalifragilistic",
      font,
      box: { w: 200, h: 400 },
      maxLines: 3,
      minSize: 40,
      maxSize: 60,
    });
    expect(r.issues.map((i) => i.code)).toContain("WORD_TOO_LONG");
  });
  it("balances display lines instead of leaving an orphan", () => {
    const r = fitText(mono, {
      text: "one two three four five six seven",
      font,
      box: { w: 560, h: 400 },
      maxLines: 3,
      minSize: 60,
      maxSize: 60,
      balance: true,
    });
    const widths = r.lineTexts.map((l) => l.length);
    expect(Math.min(...widths) / Math.max(...widths)).toBeGreaterThan(0.45);
  });
  it("applies the uppercase transform before measuring", () => {
    const r = fitText(mono, {
      text: "drill",
      font: { ...font, transform: "uppercase" },
      box: { w: 1000, h: 200 },
      maxLines: 1,
      minSize: 40,
      maxSize: 60,
    });
    expect(r.lineTexts[0]).toBe("DRILL");
  });
  it("flags glyphs the font cannot render", () => {
    const r = fitText(mono, {
      text: "snow ☃",
      font,
      box: { w: 1000, h: 200 },
      maxLines: 1,
      minSize: 40,
      maxSize: 60,
    });
    expect(r.issues.map((i) => i.code)).toContain("MISSING_GLYPHS");
  });
});
