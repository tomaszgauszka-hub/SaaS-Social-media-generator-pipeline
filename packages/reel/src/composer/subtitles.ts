import {
  assInlineAlpha,
  assInlineColor,
  buildAssDocument,
  measureText,
  roundedRectPath,
  sanitizeAssText,
  type AssEvent,
} from "@cre/media";
import { WEAK_WORDS } from "../audio/captions.ts";
import { language } from "../audio/voice/text.ts";
import type { CaptionPhrase, CaptionTrack, TextElement } from "../contracts/media.ts";
import type { Rect } from "../contracts/profiles.ts";

/**
 * One libass document per localized reel: dynamic captions (4 styles) + every text element (hook, overlays, CTA
 * headline, CTA button, disclosure) with rounded panels. All text may come from a model or a translation, so
 * every string goes through sanitizeAssText (no override blocks, no backslash commands, no control chars).
 *
 * Layers: 0 panels · 1 text elements · 5 captions.
 */

/** font file → the face name libass matches (full name, e.g. "Inter ExtraBold") */
export type FaceOf = (fontFile: string) => string;

/**
 * font file → libass's \fs per em. Every size here is an em size (what the layout measured with the font's
 * advances), but libass, like VSFilter, scales a font so that \fs is its ascent + descent (OS/2 win metrics):
 * Inter at \fs88 draws 88 / 1.21 = 73 px em. \fs is therefore em × this ratio (1 = draw \fs as the em).
 */
export type CellRatioOf = (fontFile: string) => number;

const r = (n: number) => Math.round(n);

/** \\fn + \\fs of a font file at an em size */
const fontTags = (fontFile: string, emPx: number, faceOf: FaceOf, cellOf: CellRatioOf) =>
  `\\fn${faceOf(fontFile)}\\fs${r(emPx * cellOf(fontFile))}`;

export function clampBox(b: Rect, W: number, H: number, margin = 0): Rect {
  const w = Math.min(b.w, W - 2 * margin);
  const h = Math.min(b.h, H - 2 * margin);
  return {
    x: Math.min(Math.max(margin, b.x), W - margin - w),
    y: Math.min(Math.max(margin, b.y), H - margin - h),
    w,
    h,
  };
}

/** Text lines (explicit "\n" from the layout engine) → sanitised ASS text joined with \N. */
export function assLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => sanitizeAssText(l))
    .filter(Boolean)
    .join("\\N");
}

function animation(kind: TextElement["kind"], cx: number, cy: number, durationMs: number): string {
  const pos = `\\pos(${r(cx)},${r(cy)})`;
  switch (kind) {
    case "hook":
      return `${pos}\\fad(120,160)\\fscx92\\fscy92\\t(0,180,\\fscx100\\fscy100)`;
    case "overlay":
      return `\\move(${r(cx)},${r(cy + 26)},${r(cx)},${r(cy)},0,260)\\fad(180,160)`;
    case "cta":
      return `${pos}\\fad(100,0)\\fscx72\\fscy72\\t(0,170,\\fscx106\\fscy106)\\t(170,280,\\fscx100\\fscy100)`;
    case "button": {
      const pulse =
        durationMs > 1600 ? `\\t(1000,1200,\\fscx105\\fscy105)\\t(1200,1420,\\fscx100\\fscy100)` : "";
      return `${pos}\\fad(90,0)\\fscx60\\fscy60\\t(0,160,\\fscx108\\fscy108)\\t(160,270,\\fscx100\\fscy100)${pulse}`;
    }
    case "disclosure":
      return pos;
  }
}

export function textElementEvents(
  t: TextElement,
  faceOf: FaceOf,
  W: number,
  H: number,
  cellOf: CellRatioOf = () => 1,
): AssEvent[] {
  const pad = t.panel?.padding ?? 0;
  const box = clampBox(t.box, W, H, pad);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dur = t.endMs - t.startMs;
  const events: AssEvent[] = [];
  if (t.panel) {
    const pw = box.w + 2 * pad;
    const ph = box.h + 2 * pad;
    events.push({
      layer: 0,
      startMs: t.startMs,
      endMs: t.endMs,
      style: "Base",
      text:
        `{\\an5${animation(t.kind, cx, cy, dur)}\\bord0\\shad0\\c${assInlineColor(t.panel.color)}` +
        `\\1a${assInlineAlpha(t.panel.opacity)}\\p1}${roundedRectPath(pw, ph, t.panel.radius)}{\\p0}`,
    });
  }
  // left / right aligned text anchors on the box edge, centred vertically; the panel stays centred on the box
  const an = t.align === "left" ? 4 : t.align === "right" ? 6 : 5;
  const ax = t.align === "left" ? box.x : t.align === "right" ? box.x + box.w : cx;
  events.push({
    layer: 1,
    startMs: t.startMs,
    endMs: t.endMs,
    style: "Base",
    text:
      `{\\an${an}${animation(t.kind, ax, cy, dur)}\\q2${fontTags(t.font.file, t.fontSizePx, faceOf, cellOf)}\\b0` +
      `\\c${assInlineColor(t.color)}\\bord0\\shad${t.panel ? 0 : 2}\\4c&H000000&\\4a&H90&}${assLines(t.text)}`,
  });
  return events;
}

/* ---------------------------------------------------------------- captions --------------------- */

/** a line must not end on a one-letter word ("w", "z", "i" — Polish typography) or a weak word of `lang` */
function weakLineEnd(token: string, lang: string): boolean {
  const word = token.replace(/[^\p{L}\p{N}]+$/u, "").toLocaleLowerCase();
  return /^\p{L}$/u.test(word) || Boolean(WEAK_WORDS[lang]?.has(word));
}

/**
 * Split a phrase into ≤ 2 lines at a word boundary: both lines inside maxWidth first, then a first line
 * that does not end on a weak word (in `lang`), then the shorter longer line.
 */
export function captionLineBreak(
  tokens: readonly string[],
  fontSizePx: number,
  maxWidth: number,
  lang = "",
): number | null {
  if (tokens.length < 2 || measureText(tokens.join(" "), fontSizePx) <= maxWidth) return null;
  let best = 1;
  let bestScore = Infinity;
  for (let i = 1; i < tokens.length; i++) {
    const w = Math.max(
      measureText(tokens.slice(0, i).join(" "), fontSizePx),
      measureText(tokens.slice(i).join(" "), fontSizePx),
    );
    // lexicographic: overflow ≫ weak line end ≫ width (px, far below 1e6)
    const score = (w > maxWidth ? 2e6 : 0) + (weakLineEnd(tokens[i - 1]!, lang) ? 1e6 : 0) + w;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function join(tokens: readonly string[], breakAt: number | null): string {
  return tokens.map((t, i) => (i === 0 ? t : `${breakAt === i ? "\\N" : " "}${t}`)).join("");
}

const cs = (ms: number) => Math.max(0, Math.round(ms / 10));

/** Non-overlapping phrases (a phrase ends no later than the next one starts). */
export function normalisePhrases(phrases: readonly CaptionPhrase[]): CaptionPhrase[] {
  const sorted = [...phrases]
    .filter((p) => p.words.length && p.endMs > p.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  return sorted.map((p, i) => {
    const next = sorted[i + 1];
    return next && p.endMs > next.startMs ? { ...p, endMs: Math.max(p.startMs + 40, next.startMs) } : p;
  });
}

export function captionEvents(
  track: CaptionTrack,
  faceOf: FaceOf,
  W: number,
  H: number,
  cellOf: CellRatioOf = () => 1,
  locale = "",
): AssEvent[] {
  const lang = language(locale);
  const box = clampBox(track.box, W, H);
  const minimal = track.style === "minimal_lower";
  const size = r(minimal ? track.fontSizePx * 0.74 : track.fontSizePx);
  const cx = box.x + box.w / 2;
  const cy = minimal ? box.y + box.h - size : box.y + box.h / 2;
  const base = assInlineColor(track.color);
  const hi = assInlineColor(track.highlightColor);
  const bord = minimal ? 2 : Math.max(3, r(size * 0.085));
  const common =
    `\\an5\\pos(${r(cx)},${r(cy)})\\q2${fontTags(track.font.file, size, faceOf, cellOf)}\\b0\\c${base}` +
    `\\3c${assInlineColor(track.outlineColor)}\\bord${bord}\\shad${minimal ? 0 : 2}\\4c&H000000&\\4a&H80&`;
  const events: AssEvent[] = [];
  for (const phrase of normalisePhrases(track.phrases)) {
    const tokens = phrase.words.map((w) =>
      sanitizeAssText(track.uppercase ? w.text.toLocaleUpperCase() : w.text),
    );
    const brk = captionLineBreak(tokens, size, box.w, lang);
    const ev = (startMs: number, endMs: number, tags: string, text: string): AssEvent => ({
      layer: 5,
      startMs,
      endMs,
      style: "Base",
      text: `{${common}${tags}}${text}`,
    });
    switch (track.style) {
      case "word_highlight": {
        phrase.words.forEach((w, i) => {
          const start = i === 0 ? phrase.startMs : Math.max(phrase.startMs, w.startMs);
          const end =
            i === phrase.words.length - 1
              ? phrase.endMs
              : Math.min(phrase.endMs, phrase.words[i + 1]!.startMs);
          if (end <= start) return;
          const text = join(
            tokens.map((t, j) => (j === i ? `{\\c${hi}}${t}{\\c${base}}` : t)),
            brk,
          );
          events.push(ev(start, end, i === 0 ? "\\fscx94\\fscy94\\t(0,90,\\fscx100\\fscy100)" : "", text));
        });
        break;
      }
      case "phrase_pop":
        events.push(
          ev(
            phrase.startMs,
            phrase.endMs,
            "\\fad(60,80)\\fscx80\\fscy80\\t(0,120,\\fscx104\\fscy104)\\t(120,200,\\fscx100\\fscy100)",
            join(tokens, brk),
          ),
        );
        break;
      case "karaoke_fill": {
        // \1c = sung (filled) colour, \2c = not yet sung; \k gaps keep the fill on the real word times
        let cursor = phrase.startMs;
        const parts = phrase.words.map((w, i) => {
          const gap = cs(w.startMs - cursor);
          const dur = Math.max(1, cs(Math.max(w.endMs, w.startMs + 10) - Math.max(w.startMs, cursor)));
          cursor = Math.max(cursor, w.endMs);
          return `${gap ? `{\\k${gap}}` : ""}{\\kf${dur}}${i === 0 ? "" : brk === i ? "\\N" : " "}${tokens[i]}`;
        });
        events.push(ev(phrase.startMs, phrase.endMs, `\\1c${hi}\\2c${base}`, parts.join("")));
        break;
      }
      case "minimal_lower":
        events.push(ev(phrase.startMs, phrase.endMs, "\\fad(80,80)", join(tokens, brk)));
        break;
    }
  }
  return events;
}

export function buildReelAss(opts: {
  width: number;
  height: number;
  texts: readonly TextElement[];
  captions?: CaptionTrack;
  faceOf: FaceOf;
  cellRatioOf: CellRatioOf;
  defaultFace: string;
  /** locale of the copy (caption lines do not end on its weak words) */
  locale?: string;
}): string {
  const { width: W, height: H, faceOf, cellRatioOf } = opts;
  const events = [
    ...opts.texts.flatMap((t) => textElementEvents(t, faceOf, W, H, cellRatioOf)),
    ...(opts.captions ? captionEvents(opts.captions, faceOf, W, H, cellRatioOf, opts.locale) : []),
  ];
  return buildAssDocument({
    width: opts.width,
    height: opts.height,
    styles: [{ name: "Base", font: opts.defaultFace, size: 48, bold: false }],
    events,
  });
}
