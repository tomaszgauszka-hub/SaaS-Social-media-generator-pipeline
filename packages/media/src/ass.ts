import type { ShapeOverlay, SubtitleWord, Subtitles, TextOverlay, VideoProject } from "./schema.ts";

/**
 * Kinetic typography via libass (ASS subtitles burned in by FFmpeg's `ass` filter).
 * One subtitle file carries every on-screen text, shape (CTA buttons, badges) and caption, which keeps the
 * filtergraph small and lets libass do high-quality text rendering, outlines and animation.
 */

/* ------------------------------------------------------------------------------------------------
 * Primitives
 * ---------------------------------------------------------------------------------------------- */

/** #RRGGBB → &HAABBGGRR (ASS colour, alpha 00 = opaque). */
export function assColor(hex: string, opacity = 1): string {
  const clean = hex.replace(/^#/, "");
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${assAlphaHex(opacity)}${b}${g}${r}`.toUpperCase();
}

/** Inline colour override value: &HBBGGRR& */
export function assInlineColor(hex: string): string {
  const clean = hex.replace(/^#/, "");
  return `&H${clean.slice(4, 6)}${clean.slice(2, 4)}${clean.slice(0, 2)}&`.toUpperCase();
}

function assAlphaHex(opacity: number): string {
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255);
  return a.toString(16).padStart(2, "0").toUpperCase();
}

/** Inline alpha override value: &HAA& */
export function assInlineAlpha(opacity: number): string {
  return `&H${assAlphaHex(opacity)}&`;
}

/** milliseconds → H:MM:SS.cc */
export function assTime(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10));
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

export function stripEmoji(text: string): string {
  return text
    .replace(EMOJI, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Make arbitrary (possibly LLM-generated) text safe for ASS: no override blocks, no backslash commands,
 * no control characters, no colour emoji (libass renders them as tofu).
 */
export function sanitizeAssText(text: string): string {
  return (
    stripEmoji(text)
      .replace(/[{]/g, "(")
      .replace(/[}]/g, ")")
      .replace(/\\/g, "/")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
      .trim()
  );
}

/* ------------------------------------------------------------------------------------------------
 * Text measurement (approximate Inter metrics, in em). Used for wrapping, auto-fit and safe-zone QA.
 * Errs on the wide side so real text never exceeds the computed box.
 * ---------------------------------------------------------------------------------------------- */

const NARROW = new Set([..."iljI.,:;'!|`"]);
const SEMI_NARROW = new Set([..."ftr()[]-/ "]);
const WIDE = new Set([..."mwMW@%&"]);

function charWidthEm(ch: string): number {
  if (ch === " ") return 0.27;
  if (NARROW.has(ch)) return 0.3;
  if (SEMI_NARROW.has(ch)) return 0.4;
  if (WIDE.has(ch)) return 0.9;
  if (/[0-9]/.test(ch)) return 0.63;
  if (/[A-Z]/.test(ch)) return 0.7;
  if (/[a-z]/.test(ch)) return 0.57;
  return 0.62; // accented letters, symbols, other scripts
}

export function measureText(text: string, fontSize: number, bold = true): number {
  let em = 0;
  for (const ch of text.replace(/\*/g, "")) em += charWidthEm(ch);
  return em * fontSize * (bold ? 1.05 : 1);
}

export const LINE_HEIGHT = 1.2;

/** Greedy word wrap. Words longer than the line are kept whole (they will be reported as overflow). */
export function wrapText(text: string, maxWidth: number, fontSize: number, bold = true): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && measureText(candidate, fontSize, bold) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export interface FitResult {
  fontSize: number;
  lines: string[];
  width: number;
  height: number;
  overflow: boolean;
}

/** Shrink the font until the text fits `maxLines` lines of `maxWidth`. */
export function fitText(
  text: string,
  opts: { maxWidth: number; maxLines: number; fontSize: number; minFontSize: number; bold?: boolean },
): FitResult {
  const bold = opts.bold ?? true;
  let size = opts.fontSize;
  for (;;) {
    const lines = wrapText(text, opts.maxWidth, size, bold);
    const width = Math.max(0, ...lines.map((l) => measureText(l, size, bold)));
    const fits = lines.length <= opts.maxLines && width <= opts.maxWidth;
    if (fits || size <= opts.minFontSize) {
      return {
        fontSize: size,
        lines,
        width,
        height: lines.length * size * LINE_HEIGHT,
        overflow: !fits,
      };
    }
    size = Math.max(opts.minFontSize, size - Math.max(2, Math.round(size * 0.06)));
  }
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Bounding box of a positioned text overlay (pre-wrapped text, one line per \n). */
export function textOverlayBounds(
  t: Pick<TextOverlay, "text" | "fontSize" | "x" | "y" | "align" | "bold" | "uppercase" | "outline">,
): Box {
  const raw = t.uppercase ? t.text.toUpperCase() : t.text;
  const lines = raw.split("\n");
  const width = Math.max(0, ...lines.map((l) => measureText(l, t.fontSize, t.bold))) + t.outline * 2;
  const height = lines.length * t.fontSize * LINE_HEIGHT + t.outline * 2;
  const x0 = t.align === "center" ? t.x - width / 2 : t.align === "left" ? t.x : t.x - width;
  return { x0, y0: t.y - height / 2, x1: x0 + width, y1: t.y + height / 2 };
}

/* ------------------------------------------------------------------------------------------------
 * Markup & animation
 * ---------------------------------------------------------------------------------------------- */

/** `*word*` → accent colour (and optionally accent outline). Returns ASS text (already sanitised). */
export function applyHighlight(
  text: string,
  accentHex: string,
  baseHex: string,
  outline?: { accent: string; base: string },
): string {
  const accent = assInlineColor(accentHex);
  const base = assInlineColor(baseHex);
  const on = outline ? `\\3c${assInlineColor(outline.accent)}` : "";
  const off = outline ? `\\3c${assInlineColor(outline.base)}` : "";
  return sanitizeAssText(text).replace(/\*([^*]+)\*/g, `{\\c${accent}${on}}$1{\\c${base}${off}}`);
}

export function animationTags(
  animation: TextOverlay["animation"] | ShapeOverlay["animation"],
  pos: { x: number; y: number },
  durationMs: number,
): string {
  const fadeOut = Math.min(200, Math.floor(durationMs / 4));
  switch (animation) {
    case "none":
      return `\\pos(${r(pos.x)},${r(pos.y)})`;
    case "fade":
      return `\\pos(${r(pos.x)},${r(pos.y)})\\fad(${Math.min(250, Math.floor(durationMs / 3))},${fadeOut})`;
    case "pop":
      return (
        `\\pos(${r(pos.x)},${r(pos.y)})\\fad(80,${fadeOut})` +
        `\\fscx62\\fscy62\\t(0,170,\\fscx108\\fscy108)\\t(170,280,\\fscx100\\fscy100)`
      );
    case "slide_up":
      return `\\move(${r(pos.x)},${r(pos.y + 70)},${r(pos.x)},${r(pos.y)},0,320)\\fad(120,${fadeOut})`;
    case "words":
      return `\\pos(${r(pos.x)},${r(pos.y)})\\fad(0,${fadeOut})`;
  }
}

function r(n: number): number {
  return Math.round(n);
}

/** Per-word staggered reveal: each word fades in 110 ms after the previous one. */
function wordsReveal(assText: string, staggerMs = 110): string {
  let i = 0;
  return assText.replace(/(\{[^}]*\})|([^\s{}]+)/g, (match, tag: string | undefined) => {
    if (tag) return match;
    const t0 = i++ * staggerMs;
    return `{\\alpha&HFF&\\t(${t0},${t0 + 140},\\alpha&H00&)}${match}`;
  });
}

/* ------------------------------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------------------------------- */

/** Rounded rectangle as ASS vector drawing, origin top-left. */
export function roundedRectPath(width: number, height: number, radius: number): string {
  const w = r(width);
  const h = r(height);
  const rad = r(Math.min(radius, width / 2, height / 2));
  const k = r(rad * 0.4477); // control point offset (circle approximation)
  return [
    `m ${rad} 0`,
    `l ${w - rad} 0`,
    `b ${w - k} 0 ${w} ${k} ${w} ${rad}`,
    `l ${w} ${h - rad}`,
    `b ${w} ${h - k} ${w - k} ${h} ${w - rad} ${h}`,
    `l ${rad} ${h}`,
    `b ${k} ${h} 0 ${h - k} 0 ${h - rad}`,
    `l 0 ${rad}`,
    `b 0 ${k} ${k} 0 ${rad} 0`,
  ].join(" ");
}

/* ------------------------------------------------------------------------------------------------
 * Document
 * ---------------------------------------------------------------------------------------------- */

export interface AssStyle {
  name: string;
  font: string;
  size: number;
  bold: boolean;
}

export interface AssEvent {
  layer: number;
  startMs: number;
  endMs: number;
  style: string;
  text: string;
}

export function buildAssDocument(opts: {
  width: number;
  height: number;
  styles: AssStyle[];
  events: AssEvent[];
}): string {
  const header = [
    "[Script Info]",
    "; generated by @cre/media",
    "ScriptType: v4.00+",
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...opts.styles.map(
      (s) =>
        `Style: ${s.name},${s.font},${s.size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,${s.bold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    ),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = [...opts.events]
    .filter((e) => e.endMs > e.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.layer - b.layer)
    .map(
      (e) => `Dialogue: ${e.layer},${assTime(e.startMs)},${assTime(e.endMs)},${e.style},,0,0,0,,${e.text}`,
    );
  return [...header, ...events, ""].join("\n");
}

function alignmentTag(align: TextOverlay["align"]): string {
  return align === "left" ? "\\an4" : align === "right" ? "\\an6" : "\\an5";
}

export function textOverlayEvent(t: TextOverlay): AssEvent {
  const duration = t.endMs - t.startMs;
  const raw = t.uppercase ? t.text.toUpperCase() : t.text;
  const outline = t.accentOutlineColor ? { accent: t.accentOutlineColor, base: t.outlineColor } : undefined;
  let body = raw
    .split("\n")
    .map((line) => applyHighlight(line, t.accentColor, t.color, outline))
    .join("\\N");
  if (t.animation === "words") body = wordsReveal(body);
  const tags = [
    "\\q2",
    alignmentTag(t.align),
    animationTags(t.animation, { x: t.x, y: t.y }, duration),
    `\\fs${r(t.fontSize)}`,
    `\\b${t.bold ? 1 : 0}`,
    `\\c${assInlineColor(t.color)}`,
    `\\3c${assInlineColor(t.outlineColor)}`,
    `\\bord${t.outline}`,
    `\\shad${t.shadow}`,
    `\\4c${assInlineColor("#000000")}\\4a&H80&`,
  ].join("");
  return {
    layer: t.layer,
    startMs: t.startMs,
    endMs: t.endMs,
    style: t.bold ? "Heading" : "Body",
    text: `{${tags}}${body}`,
  };
}

export function shapeEvent(s: ShapeOverlay): AssEvent {
  const duration = s.endMs - s.startMs;
  const anim = s.animation === "none" ? "none" : s.animation === "pop" ? "pop" : "fade";
  const tags = [
    "\\an5",
    animationTags(anim, { x: s.x, y: s.y }, duration),
    "\\bord0\\shad0",
    `\\c${assInlineColor(s.color)}`,
    `\\1a${assInlineAlpha(s.opacity)}`,
    "\\p1",
  ].join("");
  return {
    layer: s.layer,
    startMs: s.startMs,
    endMs: s.endMs,
    style: "Body",
    text: `{${tags}}${roundedRectPath(s.width, s.height, s.radius)}{\\p0}`,
  };
}

/** Group words into short caption chunks (break on count, length, pauses and sentence ends). */
export function groupSubtitleWords(
  words: SubtitleWord[],
  maxWords: number,
  maxChars: number,
): SubtitleWord[][] {
  const groups: SubtitleWord[][] = [];
  let current: SubtitleWord[] = [];
  let chars = 0;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const pause = prev ? w.startMs - prev.endMs : 0;
    const sentenceEnd = prev ? /[.!?…]$/.test(prev.text) : false;
    if (
      current.length > 0 &&
      (current.length >= maxWords || chars + w.text.length + 1 > maxChars || pause > 350 || sentenceEnd)
    ) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(w);
    chars += w.text.length + 1;
  });
  if (current.length) groups.push(current);
  return groups;
}

/** Word-pop captions: the active word is highlighted and slightly enlarged. */
export function subtitleEvents(sub: Subtitles, centerX: number): AssEvent[] {
  if (!sub.enabled || sub.words.length === 0) return [];
  const events: AssEvent[] = [];
  const groups = groupSubtitleWords(sub.words, sub.maxWordsPerGroup, sub.maxCharsPerGroup);
  const base = assInlineColor(sub.color);
  const hi = assInlineColor(sub.highlightColor);
  const common = `\\q2\\an5\\pos(${r(centerX)},${r(sub.y)})\\fs${r(sub.fontSize)}\\b1\\c${base}\\3c${assInlineColor(sub.outlineColor)}\\bord${Math.max(3, r(sub.fontSize * 0.09))}\\shad0`;
  for (const group of groups) {
    const groupStart = group[0]!.startMs;
    const groupEnd = group[group.length - 1]!.endMs;
    if (sub.style === "line") {
      const text = group.map((w) => sanitizeAssText(w.text.toUpperCase())).join(" ");
      events.push({
        layer: 5,
        startMs: groupStart,
        endMs: groupEnd,
        style: "Heading",
        text: `{${common}}${text}`,
      });
      continue;
    }
    group.forEach((word, i) => {
      const start = i === 0 ? groupStart : word.startMs;
      const end = i === group.length - 1 ? groupEnd : group[i + 1]!.startMs;
      const text = group
        .map((w, j) => {
          const clean = sanitizeAssText(w.text.toUpperCase());
          return j === i ? `{\\c${hi}\\fscx110\\fscy110}${clean}{\\c${base}\\fscx100\\fscy100}` : clean;
        })
        .join(" ");
      events.push({
        layer: 5,
        startMs: start,
        endMs: Math.max(start + 40, end),
        style: "Heading",
        text: `{${common}}${text}`,
      });
    });
  }
  return events;
}

/** Complete ASS document for a VideoProject (texts + shapes + subtitles). */
export function buildProjectAss(project: VideoProject): string {
  const { width, height } = project.format;
  const centerX = project.safeArea.left + (width - project.safeArea.left - project.safeArea.right) / 2;
  const events: AssEvent[] = [
    ...project.shapes.map(shapeEvent),
    ...project.texts.map(textOverlayEvent),
    ...(project.subtitles ? subtitleEvents(project.subtitles, centerX) : []),
  ];
  return buildAssDocument({
    width,
    height,
    styles: [
      { name: "Heading", font: project.brand.headingFont, size: 64, bold: true },
      { name: "Body", font: project.brand.bodyFont, size: 48, bold: false },
    ],
    events,
  });
}

/**
 * Estimate word timings when the TTS provider does not return them: distribute the speech duration
 * proportionally to word length, with small pauses after punctuation.
 */
export function estimateWordTimings(text: string, durationMs: number, offsetMs = 0): SubtitleWord[] {
  const words = sanitizeAssText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationMs <= 0) return [];
  const weights = words.map(
    (w) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, "").length) + (/[.,!?;:]$/.test(w) ? 3 : 0),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = offsetMs;
  return words.map((text, i) => {
    const share = (weights[i]! / total) * durationMs;
    const word = { text, startMs: Math.round(cursor), endMs: Math.round(cursor + share * 0.92) };
    cursor += share;
    return word;
  });
}
