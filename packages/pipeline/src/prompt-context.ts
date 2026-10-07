import type { BrandPromptContext, ProductPromptContext } from "@cre/ai";
import { CONTENT_DEFAULTS } from "@cre/config";
import { decimalFieldToMicros, decimalToNumber, type Brand, type DbClient, type Product } from "@cre/db";
import { addDays, formatUsd } from "@cre/shared";
import { z } from "zod";

/** Builders for the structured prompt contexts (shared by real prompts and the mock LLM). */

export const FactSchema = z.object({
  id: z.string(),
  claim: z.string(),
  source: z.string().default("unspecified"),
  verifiedAt: z.string().optional(),
});
export const FactsSchema = z.array(FactSchema);

export function productFacts(product: Pick<Product, "facts">): z.infer<typeof FactsSchema> {
  const parsed = FactsSchema.safeParse(product.facts);
  return parsed.success ? parsed.data : [];
}

export function brandContext(brand: Brand): BrandPromptContext {
  return {
    name: brand.name,
    niche: brand.niche,
    targetAudience: brand.targetAudience,
    toneOfVoice: brand.toneOfVoice,
    language: brand.language,
    countries: brand.countries,
    contentRules: brand.contentRules,
    bannedWords: brand.bannedWords,
    ctaStyles: brand.ctaStyles,
    complianceNotes: brand.complianceNotes,
    monetizationModels: brand.monetizationModels,
  };
}

/** A price may be mentioned only when it was verified recently. */
export function isPriceFresh(product: Pick<Product, "price" | "priceCheckedAt">, now: Date): boolean {
  if (product.price === null || !product.priceCheckedAt) return false;
  return product.priceCheckedAt.getTime() >= addDays(now, -CONTENT_DEFAULTS.priceStaleDays).getTime();
}

export function formatPrice(product: Pick<Product, "price" | "currency">): string | null {
  if (product.price === null) return null;
  const micros = decimalFieldToMicros(product.price);
  if (product.currency === "USD") return formatUsd(micros);
  return `${(micros / 1_000_000).toFixed(2)} ${product.currency}`;
}

export function economicOutcomeFor(product: Pick<Product, "kind" | "commissionFixedUsd">): string {
  if (product.kind === "SERVICE" || product.kind === "LEAD_MAGNET") return "LEAD";
  if (product.kind === "OWN_PRODUCT" || product.kind === "DIGITAL_PRODUCT") return "SALE";
  return "AFFILIATE_CLICK";
}

export function commissionText(
  product: Pick<Product, "kind" | "commissionRate" | "commissionFixedUsd">,
): string {
  const fixed = product.commissionFixedUsd ? decimalFieldToMicros(product.commissionFixedUsd) : 0;
  if (fixed > 0)
    return `${formatUsd(fixed)} per ${product.kind === "SERVICE" ? "qualified lead" : "conversion"}`;
  const rate = decimalToNumber(product.commissionRate);
  if (rate === null) return "commission unknown";
  if (product.kind === "OWN_PRODUCT") return "own product (full margin)";
  return `${(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}% commission`;
}

export function productContext(product: Product, now: Date): ProductPromptContext {
  return {
    id: product.id,
    title: product.title,
    kind: product.kind,
    manufacturer: product.manufacturer,
    category: product.category,
    description: product.description,
    priceText: isPriceFresh(product, now) ? formatPrice(product) : null,
    commissionText: commissionText(product),
    tags: product.tags,
    facts: productFacts(product).map((f) => ({ id: f.id, claim: f.claim, source: f.source })),
    economicOutcome: economicOutcomeFor(product),
  };
}

export async function performanceSummary(db: DbClient, brandId: string): Promise<string> {
  const profile = await db.brandPerformanceProfile.findFirst({
    where: { brandId },
    orderBy: { version: "desc" },
  });
  return profile?.promptText ?? "";
}

/** Recent hooks/titles of a brand (for duplicate avoidance). */
export async function recentHooks(
  db: DbClient,
  brandId: string,
  now: Date,
  excludeProjectId?: string,
): Promise<string[]> {
  const since = addDays(now, -CONTENT_DEFAULTS.duplicateLookbackDays);
  const projects = await db.contentProject.findMany({
    where: {
      brandId,
      createdAt: { gte: since },
      hook: { not: null },
      ...(excludeProjectId ? { id: { not: excludeProjectId } } : {}),
    },
    select: { hook: true },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  return projects.map((p) => p.hook!).filter(Boolean);
}

export async function recentCaptions(
  db: DbClient,
  brandId: string,
  now: Date,
  excludeProjectId: string,
): Promise<string[]> {
  const since = addDays(now, -CONTENT_DEFAULTS.duplicateLookbackDays);
  const projects = await db.contentProject.findMany({
    where: { brandId, createdAt: { gte: since }, caption: { not: null }, id: { not: excludeProjectId } },
    select: { caption: true },
    take: 40,
  });
  return projects.map((p) => p.caption!).filter(Boolean);
}

/** Brand niche → music mood for the procedural music bed. */
export function musicMoodFor(niche: string): "upbeat" | "chill" | "tech" {
  const n = niche.toLowerCase();
  if (/(beauty|skin|wellness|fashion|home decor|lifestyle)/.test(n)) return "chill";
  if (/(software|saas|ai|tech|it|productivity|electronics)/.test(n)) return "tech";
  return "upbeat";
}
