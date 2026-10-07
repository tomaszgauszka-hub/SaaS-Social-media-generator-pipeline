export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function truncate(value: string, max: number, ellipsis = "…"): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - ellipsis.length)).trimEnd() + ellipsis;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Rough token estimate (≈4 characters per token for English, ≈3 for code/JSON-heavy prompts).
 * Used only for *pre-call* cost estimates; real token counts come from the provider response.
 */
export function estimateTokens(text: string, charsPerToken = 3.6): number {
  return Math.ceil(text.length / charsPerToken);
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** Human label for SCREAMING_SNAKE enum values: WAITING_APPROVAL → "Waiting approval". */
export function enumLabel(value: string): string {
  return capitalize(value.toLowerCase().replace(/_/g, " "));
}
