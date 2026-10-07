import type { FontSpec, TextSpan } from "./model.ts";

/**
 * TextFitEngine (spec §33) — deterministic, local, no LLM.
 *
 * Given text, a box, a font and size bounds, find the largest size at which the text fits in at most `maxLines`
 * lines. Display text is broken into balanced lines (no lonely last word). When the text cannot fit at the
 * minimum readable size the result is flagged as a copy/localization problem — the engine never shrinks text
 * below the minimum.
 *
 * Measurement comes from a `TextMeasurer` backed by the real font files (see `node.ts`), which match Chromium's
 * layout to <0.01 %, so the renderer receives explicit lines and never wraps on its own.
 */
export interface TextMeasurer {
  /** advance width of `text` in em (font-size independent), letter-spacing excluded */
  advanceEm(text: string, font: FontSpec): number;
  /** characters the font files cannot render */
  missingGlyphs(text: string, font: FontSpec): string[];
}

export interface FitRequest {
  /** may contain `*emphasis*` markup */
  text: string;
  font: FontSpec;
  box: { w: number; h: number };
  maxLines: number;
  minSize: number;
  maxSize: number;
  /** balanced line breaking (display, headline, CTA) */
  balance?: boolean;
  /** BCP 47 locale for case mapping (uppercase fonts) */
  locale?: string;
  /** px search granularity */
  step?: number;
}

export type FitIssueCode = "TEXT_OVERFLOW" | "WORD_TOO_LONG" | "MISSING_GLYPHS" | "EMPTY_TEXT";

export interface FitIssue {
  code: FitIssueCode;
  message: string;
  missing?: string[];
}

export interface FitResult {
  fits: boolean;
  fontSize: number;
  lineHeightPx: number;
  lines: TextSpan[][];
  /** plain text per line (after case transform) */
  lineTexts: string[];
  width: number;
  height: number;
  issues: FitIssue[];
}

interface Run {
  text: string;
  emphasis: boolean;
}

/** A breakable unit: text between spaces, possibly mixing emphasis ("*tones*:" is one word). */
interface Word {
  text: string;
  runs: Run[];
}

/** Standalone separators never start a line — they stay with the word before them. */
const GLUE = /^[·•—–|/+&:;]+$/;

/**
 * `*word*` → emphasis runs. Markers toggle emphasis without splitting words; unbalanced markers are dropped
 * rather than rendered.
 */
export function parseEmphasis(text: string): Word[] {
  const balanced = (text.split("*").length - 1) % 2 === 0;
  const words: Word[] = [];
  let emphasis = false;
  let runs: Run[] = [];
  let buf = "";
  const flushRun = () => {
    if (buf) runs.push({ text: buf, emphasis });
    buf = "";
  };
  const flushWord = () => {
    flushRun();
    if (runs.length) words.push({ text: runs.map((r) => r.text).join(""), runs });
    runs = [];
  };
  for (const ch of text) {
    if (ch === "*") {
      flushRun();
      if (balanced) emphasis = !emphasis;
    } else if (/\s/.test(ch)) flushWord();
    else buf += ch;
  }
  flushWord();
  // glue standalone separators to the previous word (break after "·", never before it)
  const out: Word[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev && GLUE.test(w.text)) {
      prev.runs.push({ text: " ", emphasis: prev.runs[prev.runs.length - 1]!.emphasis }, ...w.runs);
      prev.text += ` ${w.text}`;
    } else out.push({ text: w.text, runs: w.runs.map((r) => ({ ...r })) });
  }
  return out;
}

export function stripEmphasis(text: string): string {
  return parseEmphasis(text)
    .map((w) => w.text)
    .join(" ");
}

function applyTransform(text: string, font: FontSpec, locale?: string): string {
  return font.transform === "uppercase" ? text.toLocaleUpperCase(locale) : text;
}

/** Width in px including CSS letter-spacing (applied after every character, as browsers do). */
export function textWidthPx(m: TextMeasurer, text: string, font: FontSpec, size: number): number {
  const chars = [...text].length;
  return (m.advanceEm(text, font) + font.letterSpacing * chars) * size;
}

function lineOf(words: Word[]): string {
  return words.map((w) => w.text).join(" ");
}

/** Greedy line filling; null when a single word is wider than the box. */
function greedy(m: TextMeasurer, words: Word[], font: FontSpec, size: number, maxW: number): Word[][] | null {
  const lines: Word[][] = [];
  let current: Word[] = [];
  for (const w of words) {
    const candidate = [...current, w];
    if (textWidthPx(m, lineOf(candidate), font, size) <= maxW) {
      current = candidate;
      continue;
    }
    if (current.length === 0) return null;
    lines.push(current);
    current = [w];
    if (textWidthPx(m, w.text, font, size) > maxW) return null;
  }
  if (current.length) lines.push(current);
  return lines;
}

/**
 * Balanced breaking into exactly `k` lines: minimise the widest line, then prefer a last line that is not
 * shorter than ~45 % of the widest (avoids orphans). Small inputs only (display text), solved exhaustively.
 */
function balanced(
  m: TextMeasurer,
  words: Word[],
  font: FontSpec,
  size: number,
  maxW: number,
  k: number,
): Word[][] | null {
  const n = words.length;
  if (k <= 1 || n <= 1) return null;
  if (n > 16) return null;
  let best: { lines: Word[][]; score: number } | null = null;
  const widthCache = new Map<string, number>();
  const width = (a: number, b: number) => {
    const key = `${a}:${b}`;
    let w = widthCache.get(key);
    if (w === undefined) {
      w = textWidthPx(m, lineOf(words.slice(a, b)), font, size);
      widthCache.set(key, w);
    }
    return w;
  };
  const search = (start: number, linesLeft: number, acc: [number, number][]) => {
    if (linesLeft === 1) {
      const seg: [number, number] = [start, n];
      if (width(start, n) > maxW) return;
      const segs = [...acc, seg];
      const widths = segs.map(([a, b]) => width(a, b));
      const widest = Math.max(...widths);
      const last = widths[widths.length - 1]!;
      const orphan = last < widest * 0.45 ? widest * 0.35 : 0;
      const raggedness = widths.reduce((s, w) => s + (widest - w) ** 2, 0) / (widest * widest);
      const score = widest + orphan + raggedness * 40;
      if (!best || score < best.score) best = { lines: segs.map(([a, b]) => words.slice(a, b)), score };
      return;
    }
    for (let end = start + 1; end <= n - (linesLeft - 1); end++) {
      if (width(start, end) > maxW) break;
      search(end, linesLeft - 1, [...acc, [start, end]]);
    }
  };
  search(0, k, []);
  return (best as { lines: Word[][]; score: number } | null)?.lines ?? null;
}

function toSpans(line: Word[]): TextSpan[] {
  const spans: TextSpan[] = [];
  const push = (text: string, emphasis: boolean) => {
    const last = spans[spans.length - 1];
    if (last && last.emphasis === emphasis) last.text += text;
    else spans.push({ text, emphasis });
  };
  line.forEach((w, i) => {
    w.runs.forEach((r, j) => {
      // the space before a word takes the emphasis of the word's first run only if the previous span had it
      if (i > 0 && j === 0) push(" ", spans[spans.length - 1]?.emphasis === true && r.emphasis);
      push(r.text, r.emphasis);
    });
  });
  return spans;
}

export function fitText(m: TextMeasurer, req: FitRequest): FitResult {
  const step = req.step ?? 2;
  const words = parseEmphasis(req.text).map((w) => ({
    text: applyTransform(w.text, req.font, req.locale),
    runs: w.runs.map((r) => ({ ...r, text: applyTransform(r.text, req.font, req.locale) })),
  }));
  const issues: FitIssue[] = [];
  const empty = (size: number): FitResult => ({
    fits: false,
    fontSize: size,
    lineHeightPx: size * req.font.lineHeight,
    lines: [],
    lineTexts: [],
    width: 0,
    height: 0,
    issues,
  });
  if (words.length === 0) {
    issues.push({ code: "EMPTY_TEXT", message: "Text slot is empty" });
    return empty(req.minSize);
  }
  const plain = lineOf(words);
  const missing = m.missingGlyphs(plain, req.font);
  if (missing.length)
    issues.push({
      code: "MISSING_GLYPHS",
      message: `${req.font.family} cannot render: ${missing.join(" ")}`,
      missing,
    });

  const build = (lines: Word[][], size: number, fits: boolean): FitResult => {
    const lineTexts = lines.map(lineOf);
    const widths = lineTexts.map((t) => textWidthPx(m, t, req.font, size));
    const lineHeightPx = size * req.font.lineHeight;
    return {
      fits,
      fontSize: size,
      lineHeightPx,
      lines: lines.map(toSpans),
      lineTexts,
      width: Math.max(0, ...widths),
      height: lines.length * lineHeightPx,
      issues,
    };
  };

  for (let size = Math.floor(req.maxSize); size >= req.minSize; size -= step) {
    const lineHeight = size * req.font.lineHeight;
    const maxLinesByHeight = Math.max(1, Math.floor((req.box.h + 0.5) / lineHeight));
    const allowed = Math.min(req.maxLines, maxLinesByHeight);
    const g = greedy(m, words, req.font, size, req.box.w);
    if (!g || g.length > allowed) continue;
    if (req.balance && g.length >= 2) {
      const b = balanced(m, words, req.font, size, req.box.w, g.length);
      if (b) return build(b, size, true);
    }
    return build(g, size, true);
  }

  // does not fit at the minimum readable size: report, never shrink further
  const g = greedy(m, words, req.font, req.minSize, req.box.w);
  if (!g) {
    const longest = words.reduce((a, w) =>
      textWidthPx(m, w.text, req.font, req.minSize) > textWidthPx(m, a.text, req.font, req.minSize) ? w : a,
    );
    issues.push({
      code: "WORD_TOO_LONG",
      message: `"${longest.text}" is wider than the text box even at ${req.minSize}px`,
    });
    return build([words], req.minSize, false);
  }
  issues.push({
    code: "TEXT_OVERFLOW",
    message: `Needs ${g.length} lines at the minimum readable size ${req.minSize}px (max ${req.maxLines}) — shorten the copy`,
  });
  return build(g, req.minSize, false);
}

/** Rough capacity of a box for localization limits (chars/words) when no measurer is at hand. */
export function estimateCapacity(
  font: FontSpec,
  box: { w: number; h: number },
  maxLines: number,
  minSize: number,
): { maxChars: number; maxWords: number } {
  const condensed = /condensed/i.test(font.family);
  const avgEm = (condensed ? 0.42 : 0.53) + font.letterSpacing + (font.transform === "uppercase" ? 0.06 : 0);
  const perLine = Math.max(1, Math.floor(box.w / (avgEm * minSize)));
  const lines = Math.min(maxLines, Math.max(1, Math.floor(box.h / (minSize * font.lineHeight))));
  const maxChars = perLine * lines;
  return { maxChars, maxWords: Math.max(1, Math.floor(maxChars / 5.2)) };
}
