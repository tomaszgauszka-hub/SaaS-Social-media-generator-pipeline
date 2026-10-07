/**
 * Subtitle layout engine (spec §35) — local, deterministic.
 *
 * 1. segment narration into short phrases (2–6 words) at punctuation, avoiding phrases that end on a weak word;
 * 2. time them: exact word timings from TTS when available, otherwise proportional to characters inside the
 *    script window, with a minimum on-screen time;
 * 3. layout happens with the TextFitEngine like any other text slot (role SUBTITLE).
 */
export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
}

export interface Phrase {
  text: string;
  startMs: number;
  endMs: number;
  words: WordTiming[];
}

export interface SegmentOptions {
  maxWords?: number;
  maxChars?: number;
  /** language subtag ("en", "de", …) for weak-word rules */
  language?: string;
}

/** Words a phrase should not end on (would read as cut off). Per language; unknown languages use none. */
const WEAK_WORDS: Record<string, Set<string>> = {
  en: new Set(
    "a an the to of and or for with in on at by from your my our its is are be as that this".split(" "),
  ),
  de: new Set(
    "der die das den dem des ein eine einen und oder mit für von zu im in am an auf ist".split(" "),
  ),
  fr: new Set("le la les un une des et ou de du à au aux en pour avec sur est".split(" ")),
  es: new Set("el la los las un una unos y o de del a al en con para por es".split(" ")),
  it: new Set("il lo la i gli le un una e o di del a al in con per è".split(" ")),
  nl: new Set("de het een en of van voor met in op aan is".split(" ")),
  pl: new Set("i a w z na do od dla o że to jest".split(" ")),
  pt: new Set("o a os as um uma e ou de do da em com para por é".split(" ")),
};

const BREAK_AFTER = /[.,!?;:…]$|[—–]$/;

export function segmentPhrases(text: string, opts: SegmentOptions = {}): string[] {
  const maxWords = opts.maxWords ?? 5;
  const maxChars = opts.maxChars ?? 30;
  const weak = WEAK_WORDS[(opts.language ?? "en").slice(0, 2).toLowerCase()] ?? new Set<string>();
  const words = text.replace(/\*/g, "").split(/\s+/).filter(Boolean);
  const phrases: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) phrases.push(current);
    current = [];
  };
  for (const w of words) {
    const candidate = [...current, w];
    if (current.length && (candidate.length > maxWords || candidate.join(" ").length > maxChars)) {
      // move trailing weak words to the next phrase
      const carry: string[] = [];
      while (
        current.length > 1 &&
        weak.has(current[current.length - 1]!.toLowerCase().replace(/[^\p{L}]/gu, ""))
      ) {
        carry.unshift(current.pop()!);
      }
      flush();
      current = [...carry, w];
    } else {
      current = candidate;
    }
    if (BREAK_AFTER.test(w) && current.length >= 2) flush();
  }
  flush();
  // merge a dangling one-word phrase into its neighbour when that stays within limits
  for (let i = phrases.length - 1; i > 0; i--) {
    const p = phrases[i]!;
    const prev = phrases[i - 1]!;
    if (
      p.length === 1 &&
      prev.length + 1 <= maxWords + 1 &&
      [...prev, ...p].join(" ").length <= maxChars + 6
    ) {
      phrases[i - 1] = [...prev, ...p];
      phrases.splice(i, 1);
    }
  }
  return phrases.map((p) => p.join(" "));
}

export interface TimingOptions {
  startMs: number;
  endMs: number;
  /** exact word timings (TTS) — preferred when available */
  words?: WordTiming[];
  minPhraseMs?: number;
  /** pause inserted after sentence punctuation (ms) */
  punctuationPauseMs?: number;
}

/** Time phrases inside a window. With TTS timings each phrase spans its own words exactly. */
export function timePhrases(phrases: string[], opts: TimingOptions): Phrase[] {
  if (phrases.length === 0) return [];
  if (opts.words?.length) {
    const out: Phrase[] = [];
    let wi = 0;
    for (const p of phrases) {
      const count = p.split(/\s+/).filter(Boolean).length;
      const words = opts.words.slice(wi, wi + count);
      wi += count;
      if (!words.length) continue;
      out.push({ text: p, startMs: words[0]!.startMs, endMs: words[words.length - 1]!.endMs, words });
    }
    return out;
  }
  const minMs = opts.minPhraseMs ?? 650;
  const pause = opts.punctuationPauseMs ?? 140;
  const weights = phrases.map((p) => Math.max(6, p.length) + (/[.!?]$/.test(p) ? pause / 30 : 0));
  const total = weights.reduce((s, w) => s + w, 0);
  const span = Math.max(1, opts.endMs - opts.startMs);
  let t = opts.startMs;
  const out: Phrase[] = [];
  phrases.forEach((p, i) => {
    const d = Math.max(minMs, Math.round((weights[i]! / total) * span));
    const start = Math.min(t, opts.endMs - minMs);
    const end = i === phrases.length - 1 ? opts.endMs : Math.min(opts.endMs, start + d);
    const words = p.split(/\s+/).filter(Boolean);
    const per = (end - start) / words.length;
    out.push({
      text: p,
      startMs: start,
      endMs: end,
      words: words.map((w, j) => ({
        text: w,
        startMs: Math.round(start + j * per),
        endMs: Math.round(start + (j + 1) * per),
      })),
    });
    t = end;
  });
  return out;
}

/** Reading-time budget for on-screen text: ~3.5 words/s plus a 450 ms minimum to notice the text. */
export function readingTimeMs(text: string): number {
  const words = text.replace(/\*/g, "").split(/\s+/).filter(Boolean).length;
  return Math.round(450 + (words / 3.5) * 1000);
}
