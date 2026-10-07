/**
 * Lightweight text similarity used for duplicate-hook detection, novelty scoring and repetition checks.
 * Character-trigram Jaccard on normalised text: robust to small rewordings, cheap, no model required.
 */

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop punctuation & emoji
    .replace(/\s+/g, " ")
    .trim();
}

export function trigrams(text: string): Set<string> {
  const normalized = ` ${normalizeText(text)} `;
  const grams = new Set<string>();
  if (normalized.trim().length === 0) return grams;
  for (let i = 0; i < normalized.length - 2; i++) grams.add(normalized.slice(i, i + 3));
  return grams;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** 0 = unrelated, 1 = identical after normalisation. */
export function textSimilarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

export function maxSimilarity(text: string, corpus: readonly string[]): { score: number; index: number } {
  const target = trigrams(text);
  let best = { score: 0, index: -1 };
  corpus.forEach((candidate, index) => {
    const score = jaccard(target, trigrams(candidate));
    if (score > best.score) best = { score, index };
  });
  return best;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}
