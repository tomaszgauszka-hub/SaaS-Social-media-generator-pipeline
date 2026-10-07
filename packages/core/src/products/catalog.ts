import type { DbClient, Prisma, PrismaClient } from "@cre/db";
import { toJson } from "@cre/shared";
import { z } from "zod";
import { parseCsv } from "../revenue/conversions.ts";

/**
 * Product catalog writes (manual form and CSV import). Facts are the ONLY claims generation may use, so each fact
 * carries its source and verification date; prices carry `priceCheckedAt` (stale prices are never shown).
 */
export const FactInput = z.object({ claim: z.string().min(3).max(300), source: z.string().min(2).max(300) });

export const ProductInput = z.object({
  brandId: z.string().min(1),
  title: z.string().min(2).max(200),
  kind: z.enum(["PRODUCT", "SERVICE", "DIGITAL_PRODUCT", "OWN_PRODUCT", "LEAD_MAGNET"]),
  sku: z.string().max(80).nullable(),
  description: z.string().max(2000).nullable(),
  manufacturer: z.string().max(120).nullable(),
  category: z.string().max(120).nullable(),
  productUrl: z.url().nullable(),
  affiliateUrl: z.url().nullable(),
  imageUrls: z.array(z.url()).max(10),
  price: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,2})?$/)
    .nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  commissionRate: z.number().min(0).max(1).nullable(),
  commissionFixedUsd: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,2})?$/)
    .nullable(),
  tags: z.array(z.string().max(40)).max(20),
  facts: z.array(FactInput).max(30),
  affiliateProgramId: z.string().nullable(),
});
export type ProductInput = z.infer<typeof ProductInput>;

export async function saveProduct(
  db: DbClient,
  workspaceId: string,
  input: ProductInput,
  opts: { now?: Date; source?: "MANUAL" | "CSV" } = {},
): Promise<{ id: string; created: boolean }> {
  const now = opts.now ?? new Date();
  const facts = input.facts.map((f, i) => ({
    id: `f${i + 1}`,
    claim: f.claim,
    source: f.source,
    verifiedAt: now.toISOString(),
  }));
  const data = {
    title: input.title,
    kind: input.kind,
    description: input.description,
    manufacturer: input.manufacturer,
    category: input.category,
    productUrl: input.productUrl,
    affiliateUrl: input.affiliateUrl,
    sourceUrl: input.productUrl,
    imageUrls: input.imageUrls,
    price: input.price,
    currency: input.currency,
    priceCheckedAt: input.price ? now : null,
    commissionRate: input.commissionRate !== null ? input.commissionRate.toFixed(4) : null,
    commissionFixedUsd: input.commissionFixedUsd,
    tags: input.tags,
    facts: toJson(facts) as Prisma.InputJsonValue,
    source: opts.source ?? "MANUAL",
  } as const;
  const existing = input.sku
    ? await db.product.findUnique({ where: { brandId_sku: { brandId: input.brandId, sku: input.sku } } })
    : null;
  const product = existing
    ? await db.product.update({ where: { id: existing.id }, data })
    : await db.product.create({
        data: { ...data, workspaceId, brandId: input.brandId, sku: input.sku, status: "ACTIVE" },
      });
  const landing = input.productUrl ?? input.affiliateUrl;
  if (landing) {
    const offer =
      (await db.offer.findFirst({ where: { productId: product.id, isPrimary: true } })) ??
      (await db.offer.create({
        data: {
          productId: product.id,
          affiliateProgramId: input.affiliateProgramId,
          title: input.title,
          price: input.price,
          currency: input.currency,
          commissionRate: data.commissionRate,
          commissionFixedUsd: input.commissionFixedUsd,
          landingUrl: landing,
          isPrimary: true,
        },
      }));
    if (input.affiliateUrl) {
      const program = input.affiliateProgramId
        ? await db.affiliateProgram.findUnique({ where: { id: input.affiliateProgramId } })
        : null;
      const link = await db.affiliateLink.findFirst({ where: { productId: product.id, offerId: offer.id } });
      if (link)
        await db.affiliateLink.update({
          where: { id: link.id },
          data: {
            url: input.affiliateUrl,
            affiliateProgramId: input.affiliateProgramId,
            subIdParam: program?.subIdParam ?? null,
          },
        });
      else
        await db.affiliateLink.create({
          data: {
            productId: product.id,
            offerId: offer.id,
            affiliateProgramId: input.affiliateProgramId,
            url: input.affiliateUrl,
            subIdParam: program?.subIdParam ?? null,
          },
        });
    }
  }
  return { id: product.id, created: !existing };
}

export interface ProductImportResult {
  created: number;
  updated: number;
  errors: { line: number; message: string }[];
}

const HEADERS: Record<string, string[]> = {
  sku: ["sku", "asin", "id"],
  title: ["title", "name", "product"],
  kind: ["kind", "type"],
  description: ["description"],
  manufacturer: ["manufacturer", "brand", "vendor"],
  category: ["category"],
  productUrl: ["product_url", "url", "link"],
  affiliateUrl: ["affiliate_url", "affiliate_link", "tracking_url"],
  imageUrls: ["image_url", "image_urls", "image"],
  price: ["price"],
  currency: ["currency"],
  commissionRate: ["commission_rate", "commission_%", "commission"],
  commissionFixedUsd: ["commission_fixed", "payout", "cpa"],
  tags: ["tags"],
  facts: ["facts", "claims"],
  factsSource: ["facts_source", "source"],
  program: ["program", "network"],
};

/** CSV columns: title (required), sku, kind, price, currency, product_url, affiliate_url, image_url, commission_rate (4% or 0.04),
 * commission_fixed, tags (comma), facts ("|" separated claims), facts_source, program (affiliate program name). */
export async function importProductsCsv(
  prisma: PrismaClient,
  opts: { workspaceId: string; brandId: string; csv: string; now?: Date },
): Promise<ProductImportResult> {
  const rows = parseCsv(opts.csv);
  const result: ProductImportResult = { created: 0, updated: 0, errors: [] };
  if (rows.length < 2) return { ...result, errors: [{ line: 1, message: "CSV has no data rows" }] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const idx = Object.fromEntries(
    Object.entries(HEADERS).map(([k, aliases]) => [k, header.findIndex((h) => aliases.includes(h))]),
  );
  if (idx.title === -1) return { ...result, errors: [{ line: 1, message: "CSV needs a title column" }] };
  const programs = await prisma.affiliateProgram.findMany({
    where: { workspaceId: opts.workspaceId },
    select: { id: true, name: true },
  });
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const get = (k: string) => {
      const i = idx[k] ?? -1;
      const v = i >= 0 ? row[i]?.trim() : undefined;
      return v ? v : null;
    };
    try {
      const rateRaw = get("commissionRate");
      const rate =
        rateRaw === null
          ? null
          : rateRaw.endsWith("%")
            ? Number(rateRaw.slice(0, -1)) / 100
            : Number(rateRaw) > 1
              ? Number(rateRaw) / 100
              : Number(rateRaw);
      const programName = get("program");
      const input = ProductInput.parse({
        brandId: opts.brandId,
        title: get("title"),
        kind: (get("kind") ?? "PRODUCT").toUpperCase(),
        sku: get("sku"),
        description: get("description"),
        manufacturer: get("manufacturer"),
        category: get("category"),
        productUrl: get("productUrl"),
        affiliateUrl: get("affiliateUrl"),
        imageUrls: (get("imageUrls") ?? "").split(/[\s,|]+/).filter(Boolean),
        price: get("price")?.replace(/[^0-9.]/g, "") || null,
        currency: (get("currency") ?? "USD").toUpperCase(),
        commissionRate: rate !== null && Number.isFinite(rate) ? rate : null,
        commissionFixedUsd: get("commissionFixedUsd")?.replace(/[^0-9.]/g, "") || null,
        tags: (get("tags") ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        facts: (get("facts") ?? "")
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean)
          .map((claim) => ({ claim, source: get("factsSource") ?? get("productUrl") ?? "CSV import" })),
        affiliateProgramId: programName
          ? (programs.find((p) => p.name.toLowerCase() === programName.toLowerCase())?.id ?? null)
          : null,
      });
      const res = await prisma.$transaction((tx) =>
        saveProduct(tx, opts.workspaceId, input, { source: "CSV", ...(opts.now ? { now: opts.now } : {}) }),
      );
      if (res.created) result.created++;
      else result.updated++;
    } catch (err) {
      result.errors.push({
        line: r + 1,
        message:
          err instanceof z.ZodError
            ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
            : (err as Error).message,
      });
    }
  }
  return result;
}
