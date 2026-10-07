import { describe, expect, it } from "vitest";
import {
  applyHighlight,
  applyHighlightLines,
  assColor,
  assInlineColor,
  assTime,
  buildAssDocument,
  estimateWordTimings,
  fitText,
  groupSubtitleWords,
  measureText,
  roundedRectPath,
  sanitizeAssText,
  subtitleEvents,
  textOverlayBounds,
  wrapText,
} from "./ass.ts";

describe("ASS primitives", () => {
  it("converts colours to BGR with alpha", () => {
    expect(assColor("#F2A900")).toBe("&H0000A9F2");
    expect(assColor("#FFFFFF", 0)).toBe("&HFFFFFFFF");
    expect(assInlineColor("#E8547A")).toBe("&H7A54E8&");
  });

  it("formats timestamps as H:MM:SS.cc", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(61_234)).toBe("0:01:01.23");
    expect(assTime(3_725_999)).toBe("1:02:06.00");
  });

  it("sanitises override blocks, backslashes and emoji", () => {
    expect(sanitizeAssText("Hi {\\b1}there\\N 🔥")).toBe("Hi (/b1)there/N");
  });

  it("highlights *words* and restores colour", () => {
    const out = applyHighlight("Stop *buying* cheap", "#FF0000", "#FFFFFF");
    expect(out).toBe("Stop {\\c&H0000FF&}buying{\\c&HFFFFFF&} cheap");
  });

  it("highlights can also switch outline colour", () => {
    const out = applyHighlight("*Price*", "#111111", "#FFFFFF", { accent: "#FFFFFF", base: "#000000" });
    expect(out).toContain("\\3c&HFFFFFF&");
    expect(out).toContain("\\3c&H000000&");
  });
});

describe("text measurement and fitting", () => {
  it("wraps by width", () => {
    const lines = wrapText("Stop stripping screws with a cheap drill today", 500, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureText(l, 60)).toBeLessThanOrEqual(500);
  });

  it("shrinks text until it fits the line budget", () => {
    const fit = fitText("This is a very long headline that will not fit on two lines at the default size", {
      maxWidth: 800,
      maxLines: 3,
      fontSize: 100,
      minFontSize: 40,
    });
    expect(fit.lines.length).toBeLessThanOrEqual(3);
    expect(fit.fontSize).toBeLessThan(100);
    expect(fit.overflow).toBe(false);
  });

  it("reports overflow when even the minimum size does not fit", () => {
    const fit = fitText("word ".repeat(80), { maxWidth: 300, maxLines: 2, fontSize: 60, minFontSize: 50 });
    expect(fit.overflow).toBe(true);
  });

  it("computes bounding boxes for alignment modes", () => {
    const base = { text: "HELLO", fontSize: 50, x: 500, y: 400, bold: true, uppercase: false, outline: 0 };
    const c = textOverlayBounds({ ...base, align: "center" });
    const l = textOverlayBounds({ ...base, align: "left" });
    expect(Math.round((c.x0 + c.x1) / 2)).toBe(500);
    expect(l.x0).toBe(500);
    expect(c.y1 - c.y0).toBeCloseTo(60);
  });
});

describe("subtitles", () => {
  const words = estimateWordTimings("This drill has two speeds. Link in bio for today's price.", 4000);

  it("estimates monotonic word timings within the duration", () => {
    expect(words).toHaveLength(11);
    for (let i = 1; i < words.length; i++)
      expect(words[i]!.startMs).toBeGreaterThanOrEqual(words[i - 1]!.endMs);
    expect(words.at(-1)!.endMs).toBeLessThanOrEqual(4000);
  });

  it("groups words and breaks at sentence ends", () => {
    const groups = groupSubtitleWords(words, 3, 20);
    for (const g of groups) expect(g.length).toBeLessThanOrEqual(3);
    // "speeds." ends a sentence → the next group starts with "Link"
    const starts = groups.map((g) => g[0]!.text);
    expect(starts).toContain("Link");
  });

  it("emits one event per active word with a highlight", () => {
    const events = subtitleEvents(
      {
        enabled: true,
        style: "word_pop",
        words,
        y: 1400,
        fontSize: 64,
        color: "#FFFFFF",
        highlightColor: "#F2A900",
        outlineColor: "#000000",
        maxWordsPerGroup: 3,
        maxCharsPerGroup: 22,
      },
      500,
    );
    expect(events).toHaveLength(words.length);
    for (const e of events) {
      expect(e.endMs).toBeGreaterThan(e.startMs);
      expect(e.text).toContain("\\c&H00A9F2&");
    }
  });
});

describe("document", () => {
  it("builds a valid ASS document sorted by time", () => {
    const doc = buildAssDocument({
      width: 1080,
      height: 1920,
      styles: [{ name: "Heading", font: "Inter", size: 64, bold: true }],
      events: [
        { layer: 1, startMs: 2000, endMs: 3000, style: "Heading", text: "B" },
        { layer: 1, startMs: 0, endMs: 1000, style: "Heading", text: "A" },
        { layer: 1, startMs: 5000, endMs: 5000, style: "Heading", text: "empty" },
      ],
    });
    expect(doc).toContain("PlayResX: 1080");
    const dialogues = doc.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain(",A");
  });

  it("draws rounded rectangles with bezier corners", () => {
    const path = roundedRectPath(400, 120, 60);
    expect(path.startsWith("m 60 0")).toBe(true);
    expect(path.match(/ b /g)).toHaveLength(4);
  });
});

describe("applyHighlightLines", () => {
  it("keeps a highlight that wraps onto the next line and never renders asterisks", () => {
    const out = applyHighlightLines(["MEET THE *20V", "CORDLESS DRILL*"], "#FF0000", "#FFFFFF");
    expect(out).not.toContain("*");
    expect(out).toBe("MEET THE {\\c&H0000FF&}20V\\NCORDLESS DRILL{\\c&HFFFFFF&}");
  });

  it("drops unbalanced markup", () => {
    expect(applyHighlightLines(["5 * 3 is", "fifteen"], "#FF0000", "#FFFFFF")).toBe("5  3 is\\Nfifteen");
  });
});
