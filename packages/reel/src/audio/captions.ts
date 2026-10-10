import type { FontSpec, TextMeasurer } from "@cre/creative";
import { measureText } from "@cre/media";
import type { CaptionPhrase, CaptionTrack, TextElement, VoiceTrack, WordTime } from "../contracts/media.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import type { BrandProfile, PlatformProfile, Rect } from "../contracts/profiles.ts";
import { estimateWords } from "./voice/align.ts";
import { language } from "./voice/text.ts";

/**
 * Dynamic captions for one locale (deterministic, no model):
 *
 *   words — the voice track's words on the reel timeline (or, for overlay-sourced captions, overlay text timed
 *   over each overlay's window) → phrases: ≤ maxWordsPerPhrase words, ≤ 2 lines of the platform's
 *   maxCharsPerLine (1 line for minimal_lower), a break after sentence punctuation (and after a comma once the
 *   phrase has 2 words), a new phrase after a real pause, never a phrase ending on a weak word ("the", "und",
 *   "w" …) when the next can take it, no one-word orphan when the previous phrase can spare a word; a word is
 *   never split. Timing: a phrase spans its words, lingers 200 ms, closes gaps < 300 ms and stays ≥ 700 ms on
 *   screen when the next phrase allows. Style, fonts and colours come from the brand; the box is the platform's
 *   caption band (shifted by plan.captions.offsetYPx) narrowed symmetrically around any UI rail it crosses;
 *   one font size for the whole track, the largest at which every phrase fits.
 */

export interface CaptionIssue {
  code: "CAPTION_WORD_TOO_LONG" | "CAPTION_TOO_SMALL" | "CAPTION_SHORT";
  message: string;
  atMs?: number;
}

export type CaptionTrackResult = CaptionTrack & { issues: CaptionIssue[] };

/** words a phrase (or caption line) should not end on, per language */
export const WEAK_WORDS: Record<string, ReadonlySet<string>> = {
  en: new Set(
    "a an the to of and or for with in on at by from your my our its is are as that this".split(" "),
  ),
  de: new Set(
    "der die das den dem des ein eine einen einem und oder mit für von zu im in am an auf ist".split(" "),
  ),
  pl: new Set("i a w we z ze na do od dla o że to u po".split(" ")),
  fr: new Set("le la les un une des et ou de du à au aux en pour avec sur est".split(" ")),
  es: new Set("el la los las un una unos y o de del a al en con para por es".split(" ")),
  it: new Set("il lo la i gli le un una e o di del a al in con per è".split(" ")),
};

// closing quotes: " ' ” (en, pl) “ ‘ (de) ’ » › and a closing bracket
const SENTENCE_END = /[.!?…]["'”“’‘»›)]*$/u;
const CLAUSE_END = /[,;:–—]["'”“’‘»›)]*$/u;
const TRAILING = /[\s"'”“’‘»›),.;:…–—-]+$/u;
/** languages that write ordinals as a number with a dot ("die 3. Generation", "3. generacja") */
const ORDINAL_DOT = new Set(["de", "pl", "cs", "sk", "da", "no", "nb", "fi", "hu", "hr", "sl", "sr", "tr"]);

/** "3." in a language that writes ordinals with a dot: a number, not the end of a sentence */
function isOrdinal(text: string, lang: string): boolean {
  return ORDINAL_DOT.has(lang) && /^\d+\.$/.test(text.replace(/^["'„“«»‚‘‹(]+/u, ""));
}

/**
 * caption form of a word: no leading / closing quotes, no trailing , . ; : … – (a ? or ! stays); a suspended
 * hyphen ("Lese- und Stehlampe") and an ordinal dot ("3. Generation", in `lang`s that write one) stay
 */
export function captionWord(text: string, lang = ""): string {
  const word = text.trim().replace(/^["'„“«»‚‘‹(]+/u, "");
  const tail = TRAILING.exec(word)?.[0] ?? "";
  const core = word.slice(0, word.length - tail.length);
  const keep =
    (tail.startsWith("-") && /[\p{L}\p{N}]$/u.test(core)) ||
    (tail.startsWith(".") && isOrdinal(`${core}.`, lang))
      ? tail[0]!
      : "";
  return `${core}${keep}`.trim();
}

interface Tok {
  word: WordTime;
  /** text as shown */
  shown: string;
  sentenceEnd: boolean;
  clauseEnd: boolean;
}

/** best ≤ maxLines split of the tokens; returns the longest line (chars) */
function longestLineChars(texts: readonly string[], maxLines: number): number {
  const all = texts.join(" ").length;
  if (maxLines < 2 || texts.length < 2) return all;
  let best = all;
  for (let i = 1; i < texts.length; i++)
    best = Math.min(best, Math.max(texts.slice(0, i).join(" ").length, texts.slice(i).join(" ").length));
  return best;
}

export function groupPhrases(
  toks: readonly Tok[],
  opts: { maxWords: number; maxChars: number; maxLines: number; lang: string; pauseMs?: number },
): Tok[][] {
  const weak = WEAK_WORDS[opts.lang] ?? new Set<string>();
  const fits = (p: readonly Tok[]) =>
    p.length <= opts.maxWords &&
    longestLineChars(
      p.map((t) => t.shown),
      opts.maxLines,
    ) <= opts.maxChars;
  const isWeak = (t: Tok) => weak.has(t.shown.toLowerCase());
  const pause = opts.pauseMs ?? 450;
  const phrases: Tok[][] = [];
  let cur: Tok[] = [];
  const flush = () => {
    if (cur.length) phrases.push(cur);
    cur = [];
  };
  for (const t of toks) {
    const prev = cur[cur.length - 1];
    const gap = prev ? t.word.startMs - prev.word.endMs : 0;
    if (cur.length && (!fits([...cur, t]) || gap > pause)) {
      // carry trailing weak words over (when the next phrase can take them)
      const carry: Tok[] = [];
      while (
        cur.length > 1 &&
        isWeak(cur[cur.length - 1]!) &&
        fits([cur[cur.length - 1]!, ...carry, t]) &&
        gap <= pause
      )
        carry.unshift(cur.pop()!);
      flush();
      cur = carry;
    }
    cur.push(t);
    if (t.sentenceEnd || (t.clauseEnd && cur.length >= 2)) flush();
  }
  flush();
  // orphans: a lone word (not a sentence of its own) borrows the previous phrase's last word
  for (let i = 1; i < phrases.length; i++) {
    const p = phrases[i]!;
    const prev = phrases[i - 1]!;
    if (
      p.length !== 1 ||
      prev.length < 3 ||
      prev[prev.length - 1]!.sentenceEnd ||
      prev[prev.length - 1]!.clauseEnd
    )
      continue;
    const moved = [prev[prev.length - 1]!, ...p];
    if (fits(moved) && p[0]!.word.startMs - prev[prev.length - 1]!.word.endMs <= pause) {
      phrases[i] = moved;
      prev.pop();
    }
  }
  return phrases.filter((p) => p.length);
}

/** caption band: platform band shifted by offsetY, narrowed around UI rails crossing it */
export function captionBox(platform: PlatformProfile, offsetYPx = 0, minMargin = 60, pad = 16): Rect {
  const h = platform.captions.maxHeight;
  const y = Math.round(platform.captions.centerY + offsetYPx - h / 2);
  const W = platform.width;
  let margin = minMargin;
  for (const u of platform.unsafe) {
    const r = u.rect;
    if (r.w >= W * 0.9 || r.y >= y + h || r.y + r.h <= y) continue;
    const intrusion = r.x + r.w / 2 > W / 2 ? W - r.x : r.x + r.w;
    margin = Math.max(margin, intrusion);
  }
  margin += pad;
  return { x: margin, y, w: Math.max(200, W - 2 * margin), h };
}

function fontSpec(font: BrandProfile["fonts"]["captions"]): FontSpec {
  return {
    family: font.family,
    weight: font.weight,
    style: "normal",
    letterSpacing: 0,
    transform: "none",
    lineHeight: 1.2,
  };
}

function relativeLuminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

export function buildCaptionTrack(opts: {
  voice?: Pick<VoiceTrack, "words">;
  overlays?: readonly Pick<TextElement, "text" | "startMs" | "endMs">[];
  plan: Pick<ReelPlan, "captions" | "durationMs" | "copy">;
  platform: PlatformProfile;
  brand: BrandProfile;
  measurer?: TextMeasurer;
  minPhraseMs?: number;
}): CaptionTrackResult {
  const { plan, platform, brand } = opts;
  const locale = plan.copy.locale;
  const lang = language(locale);
  const style = plan.captions.style;
  const uppercase = brand.captionStyle.uppercase;
  const issues: CaptionIssue[] = [];
  const minMs = opts.minPhraseMs ?? 700;

  // words on the reel timeline
  let words: WordTime[] = [];
  if (plan.captions.source === "voiceover" && opts.voice?.words.length) words = [...opts.voice.words];
  else if (opts.overlays?.length)
    words = opts.overlays.flatMap((o) =>
      estimateWords(o.text, Math.max(200, Math.round((o.endMs - o.startMs) * 0.85)), locale, o.startMs),
    );
  words = words
    .filter((w) => w.endMs > w.startMs && w.startMs < plan.durationMs)
    .sort((a, b) => a.startMs - b.startMs);

  const toks: Tok[] = words.flatMap((w) => {
    const shown = captionWord(w.text, lang);
    if (!shown) return [];
    const sentenceEnd = SENTENCE_END.test(w.text) && !isOrdinal(w.text, lang);
    return [{ word: w, shown, sentenceEnd, clauseEnd: CLAUSE_END.test(w.text) }];
  });
  const maxLines = style === "minimal_lower" ? 1 : 2;
  const maxChars = platform.captions.maxCharsPerLine;
  for (const t of toks)
    if (t.shown.length > maxChars)
      issues.push({
        code: "CAPTION_WORD_TOO_LONG",
        message: `"${t.shown}" is longer than a caption line`,
        atMs: t.word.startMs,
      });
  const groups = groupPhrases(toks, { maxWords: plan.captions.maxWordsPerPhrase, maxChars, maxLines, lang });

  // timing: span the words, linger, close small gaps, minimum on-screen time
  const phrases: CaptionPhrase[] = groups.map((g) => ({
    startMs: g[0]!.word.startMs,
    endMs: g[g.length - 1]!.word.endMs,
    words: g.map((t) => ({ text: t.shown, startMs: t.word.startMs, endMs: t.word.endMs })),
  }));
  phrases.forEach((p, i) => {
    const next = phrases[i + 1]?.startMs ?? plan.durationMs;
    let end = Math.min(next, p.endMs + 200);
    if (next - end < 300) end = next;
    if (end - p.startMs < minMs) end = Math.min(next, p.startMs + minMs);
    p.endMs = Math.min(plan.durationMs, Math.max(end, p.endMs));
    if (p.endMs - p.startMs < minMs * 0.6)
      issues.push({
        code: "CAPTION_SHORT",
        message: `phrase at ${p.startMs} ms is on screen ${p.endMs - p.startMs} ms`,
        atMs: p.startMs,
      });
  });

  // one font size: the largest at which every phrase fits the box in its best line split
  const box = captionBox(platform, plan.captions.offsetYPx ?? 0);
  const spec = fontSpec(brand.fonts.captions);
  const shown = (s: string) => (uppercase ? s.toLocaleUpperCase(locale) : s);
  const widthEm = (s: string) =>
    Math.max(opts.measurer ? opts.measurer.advanceEm(shown(s), spec) : 0, measureText(shown(s), 1));
  const lineEm = (texts: string[]) => {
    const all = widthEm(texts.join(" "));
    if (maxLines < 2 || texts.length < 2) return all;
    let best = all;
    for (let i = 1; i < texts.length; i++)
      best = Math.min(
        best,
        Math.max(widthEm(texts.slice(0, i).join(" ")), widthEm(texts.slice(i).join(" "))),
      );
    return best;
  };
  const maxSize = 78;
  const minSize = 44;
  let size = Math.min(maxSize, Math.floor(box.h / (maxLines * 1.25)));
  for (const p of phrases)
    size = Math.min(size, Math.floor(box.w / Math.max(0.1, lineEm(p.words.map((w) => w.text)))));
  if (size < minSize) {
    issues.push({ code: "CAPTION_TOO_SMALL", message: `captions need ${size}px to fit; using ${minSize}px` });
    size = minSize;
  }

  const background = brand.colors.background;
  return {
    style,
    phrases,
    font: { family: brand.fonts.captions.family, file: brand.fonts.captions.file },
    fontSizePx: size,
    color: brand.colors.text,
    highlightColor: brand.captionStyle.highlightColor ?? brand.colors.accent,
    outlineColor: relativeLuminance(background) < 0.2 ? background : "#000000",
    box,
    uppercase,
    issues,
  };
}
