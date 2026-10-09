/**
 * Text helpers shared by TTS, alignment and captions: the word tokens a viewer reads (punctuation-only tokens
 * are attached to the previous word, so every token is a real word), a speaking-time weight per word (syllables
 * per language + digits / spelled-out abbreviations), and TTS-safe text (no control characters, no markup, no
 * emoji — plain text on stdin, never arguments).
 */

const VOWELS = "aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœąęóůěɛ";
const VOWEL_GROUP = new RegExp(`[${VOWELS}]+`, "giu");
const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;

export function language(locale: string): string {
  return (locale.split("-")[0] ?? locale).toLowerCase();
}

/** words as written (whitespace-separated; standalone punctuation such as "–" joins the previous word) */
export function wordTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\*/g, "").split(/\s+/)) {
    if (!raw) continue;
    if (PUNCT_ONLY.test(raw) && out.length) out[out.length - 1] = `${out[out.length - 1]} ${raw}`;
    else if (!PUNCT_ONLY.test(raw)) out.push(raw);
  }
  return out;
}

/** estimated syllables of one written word in a language */
export function syllables(word: string, lang = "en"): number {
  const letters = word.normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "");
  if (!letters) return 0;
  const digits = letters.replace(/\D/g, "").length;
  // numbers are read out: ~1.6 syllables per digit
  if (digits === letters.length) return Math.max(1, Math.round(digits * 1.6));
  // ALL-CAPS abbreviations (LED, USB) are spelled
  if (
    letters.length <= 5 &&
    letters === letters.toUpperCase() &&
    /\p{Lu}/u.test(letters) &&
    letters.length > 1
  )
    return letters.length;
  let count = (letters.toLowerCase().match(VOWEL_GROUP) ?? []).length;
  // silent final -e (en, fr)
  if ((lang === "en" || lang === "fr") && /[^aeiouy]e$/i.test(letters) && count > 1) count--;
  return Math.max(1, count + Math.round(digits * 1.6));
}

/** pause after a word (in syllable units) from its trailing punctuation */
export function pauseAfter(word: string): number {
  if (/[.!?…]["»”']?$/.test(word)) return 1.4;
  if (/[,;:–—-]["»”']?$/.test(word)) return 0.7;
  return 0;
}

/** speaking-time weight of a word: syllables + a small length term */
export function wordWeight(word: string, lang = "en"): number {
  const letters = word.replace(/[^\p{L}\p{N}]/gu, "").length;
  return syllables(word, lang) + 0.06 * letters;
}

/** plain text for a TTS engine: no control chars / markup / emoji, single spaces, bounded length */
export function speechText(text: string, max = 600): string {
  const printable = Array.from(text, (ch) => {
    const cp = ch.codePointAt(0)!;
    return cp < 0x20 || cp === 0x7f ? " " : ch;
  }).join("");
  return printable
    .replace(/[*_`#<>{}[\]|\\^~]/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
