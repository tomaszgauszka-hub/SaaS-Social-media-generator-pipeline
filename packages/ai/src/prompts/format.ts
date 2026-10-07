import { bullets } from "./registry.ts";
import type { BrandPromptContext, ProductPromptContext } from "./contexts.ts";
import type { ResearchBriefOutput } from "./schemas.ts";

/** Shared prompt fragments. Changing these changes prompt hashes → bump the affected prompt versions. */

export function rulesBlock(brand: BrandPromptContext, economicOutcome?: string): string {
  return [
    "NON-NEGOTIABLE RULES",
    '1. Use ONLY the product facts provided (reference them by id). Never invent specifications, prices, discounts, stock levels, awards, rankings, statistics, reviews, testimonials or personal experiences (no "I tried", "my skin", "we tested").',
    "2. Mention a price only when a verified price is provided; otherwise never mention price, discounts or deals.",
    "3. No medical, health, legal, financial or income claims. No fake urgency or scarcity.",
    `4. Never use these banned words or phrases: ${brand.bannedWords.length ? brand.bannedWords.join(", ") : "(none)"}.`,
    `5. Brand content rules:\n${bullets(brand.contentRules)}`,
    `6. Write in language "${brand.language}" for audiences in ${brand.countries.join(", ") || "any country"}.`,
    ...(economicOutcome ? [`7. The content must drive this measurable outcome: ${economicOutcome}.`] : []),
    ...(brand.complianceNotes ? [`Compliance notes: ${brand.complianceNotes}`] : []),
  ].join("\n");
}

export function brandHeader(brand: BrandPromptContext): Record<string, string> {
  return {
    brandName: brand.name,
    niche: brand.niche,
    tone: brand.toneOfVoice,
    audience: brand.targetAudience,
    monetization: brand.monetizationModels.join(", ") || "affiliate",
    ctaStyles: brand.ctaStyles.length ? brand.ctaStyles.map((c) => `"${c}"`).join(", ") : '"Link in bio"',
    language: brand.language,
  };
}

export function productBlock(p: ProductPromptContext): string {
  return [
    `id: ${p.id}`,
    `title: ${p.title}`,
    `kind: ${p.kind}${p.category ? ` · category: ${p.category}` : ""}${p.manufacturer ? ` · by ${p.manufacturer}` : ""}`,
    `verified price: ${p.priceText ?? "NOT AVAILABLE — do not mention price"}`,
    `monetization: ${p.commissionText} · outcome: ${p.economicOutcome}`,
    ...(p.description ? [`description: ${p.description}`] : []),
    `facts:\n${bullets(
      p.facts.map((f) => `[${f.id}] ${f.claim} (source: ${f.source})`),
      "(no facts — keep claims generic and non-specific)",
    )}`,
  ].join("\n");
}

export function factsBlock(p: ProductPromptContext): string {
  return bullets(p.facts.map((f) => `[${f.id}] ${f.claim}`));
}

export function briefBlock(brief: ResearchBriefOutput): string {
  return [
    `positioning: ${brief.positioning}`,
    `key benefits:\n${bullets(brief.keyBenefits.map((b) => `${b.benefit} [${b.factId}]`))}`,
    `audience pain points:\n${bullets(brief.audiencePainPoints)}`,
    `objections:\n${bullets(brief.objections.map((o) => `${o.objection} → ${o.answer}`))}`,
    `claims we must NOT make:\n${bullets(brief.forbiddenClaims)}`,
  ].join("\n");
}

export function performanceText(summary: string): string {
  return summary.trim()
    ? summary.trim()
    : "No performance data yet — rely on proven direct-response best practices.";
}
