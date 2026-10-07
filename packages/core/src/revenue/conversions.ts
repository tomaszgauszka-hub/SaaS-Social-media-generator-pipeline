import type {
  ConversionStatus,
  ConversionType,
  DbClient,
  Platform,
  Prisma,
  PrismaClient,
  RevenueKind,
} from "@cre/db";
import { decimalFieldToMicros, microsToDecimal } from "@cre/db";
import { toJson, type Micros } from "@cre/shared";

/**
 * Revenue attribution. Conversions arrive from manual entry, CSV exports, network webhooks/postbacks or APIs.
 * They are attributed via our click id (passed to the network as sub-id) → Click → TrackedLink → content,
 * platform, product and brand. Revenue is booked as RevenueEntry rows (a ledger: reversals add negative
 * adjustments instead of deleting history).
 */
export interface ConversionInput {
  workspaceId: string;
  source: "manual" | "csv" | "webhook" | "api" | "mock";
  affiliateProgramId?: string | null;
  externalId?: string | null;
  /** public click id reported back by the network (sub-id) */
  clickId?: string | null;
  /** tracked link code (direct-link programs report the static sub-id) */
  linkCode?: string | null;
  productId?: string | null;
  brandId?: string | null;
  type: ConversionType;
  status: ConversionStatus;
  occurredAt: Date;
  orderValueMicros?: Micros | null;
  /** commission in the original currency */
  commissionMicros?: Micros | null;
  currency?: string;
  fxRateToUsd?: number;
  isSimulated?: boolean;
  raw?: Record<string, unknown>;
}

export interface Attribution {
  brandId: string | null;
  clickRefId: string | null;
  trackedLinkId: string | null;
  projectId: string | null;
  variantId: string | null;
  publicationId: string | null;
  productId: string | null;
  platform: Platform | null;
}

export async function attributeConversion(db: DbClient, input: ConversionInput): Promise<Attribution> {
  const empty: Attribution = {
    brandId: input.brandId ?? null,
    clickRefId: null,
    trackedLinkId: null,
    projectId: null,
    variantId: null,
    publicationId: null,
    productId: input.productId ?? null,
    platform: null,
  };
  if (input.clickId) {
    const click = await db.click.findUnique({ where: { clickId: input.clickId } });
    if (click) {
      return {
        brandId: click.brandId,
        clickRefId: click.id,
        trackedLinkId: click.trackedLinkId,
        projectId: click.projectId,
        variantId: click.variantId,
        publicationId: click.publicationId,
        productId: click.productId ?? input.productId ?? null,
        platform: click.platform,
      };
    }
  }
  const code = input.linkCode ?? input.clickId; // direct-link programs echo the link code as sub-id
  if (code) {
    const link = await db.trackedLink.findUnique({
      where: { code },
      include: { variant: { select: { id: true, platform: true } } },
    });
    if (link) {
      return {
        ...empty,
        brandId: link.brandId,
        trackedLinkId: link.id,
        projectId: link.projectId,
        variantId: link.variant?.id ?? null,
        productId: link.productId ?? empty.productId,
        platform: link.platform ?? link.variant?.platform ?? null,
      };
    }
  }
  if (input.productId && !empty.brandId) {
    const product = await db.product.findUnique({
      where: { id: input.productId },
      select: { brandId: true },
    });
    return { ...empty, brandId: product?.brandId ?? null };
  }
  return empty;
}

function revenueKindFor(type: ConversionType, productKind?: string | null): RevenueKind {
  if (type === "LEAD" || type === "INQUIRY") return "LEAD_FEE";
  if (productKind === "OWN_PRODUCT" || productKind === "DIGITAL_PRODUCT") return "SALE";
  return "COMMISSION";
}

export interface RecordConversionResult {
  conversionId: string;
  created: boolean;
  attribution: Attribution;
  revenueDeltaMicros: Micros;
}

const PERSONAL_KEY =
  /e-?mail|^(?:first|last|full|given|family|customer|buyer|user)?[_-]?name$|phone|mobile|(?:^|_)tel(?:ephone)?$|address|street|city|zip|postal|post_?code|^ip$|ip_?addr|user_?agent|^ua$|customer|buyer|shopper|birth|^dob$|gender|card|iban|ssn|passport/i;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const IP_VALUE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;

/**
 * Data minimisation for stored postback / CSV payloads: we need ids, amounts and statuses for attribution and
 * audits — never the buyer. Keys that look personal and values that look like e-mail or IP addresses are
 * replaced before anything is written.
 */
export function redactPersonalData(raw: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (PERSONAL_KEY.test(key)) {
      out[key] = "[redacted]";
    } else if (typeof value === "string") {
      out[key] = EMAIL_VALUE.test(value) || IP_VALUE.test(value.trim()) ? "[redacted]" : value.slice(0, 500);
    } else if (value && typeof value === "object" && !Array.isArray(value) && depth < 3) {
      out[key] = redactPersonalData(value as Record<string, unknown>, depth + 1);
    } else if (Array.isArray(value)) {
      out[key] = "[list omitted]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Idempotent per (program, externalId): repeats update status/amount and book adjustments. */
export async function recordConversion(
  prisma: PrismaClient,
  rawInput: ConversionInput,
): Promise<RecordConversionResult> {
  const input = rawInput.raw ? { ...rawInput, raw: redactPersonalData(rawInput.raw) } : rawInput;
  return prisma.$transaction(async (tx) => {
    const attribution = await attributeConversion(tx, input);
    const fx = input.fxRateToUsd ?? 1;
    const commission = input.commissionMicros ?? 0;
    const commissionUsd = Math.round(commission * fx);
    const bookable = input.status === "REVERSED" ? 0 : commissionUsd;
    const product = attribution.productId
      ? await tx.product.findUnique({ where: { id: attribution.productId }, select: { kind: true } })
      : null;
    const kind = revenueKindFor(input.type, product?.kind);

    const existing =
      input.affiliateProgramId && input.externalId
        ? await tx.conversion.findUnique({
            where: {
              affiliateProgramId_externalId: {
                affiliateProgramId: input.affiliateProgramId,
                externalId: input.externalId,
              },
            },
            include: { revenueEntries: true },
          })
        : null;

    if (existing) {
      const booked = existing.revenueEntries.reduce((s, e) => s + decimalFieldToMicros(e.amountUsd), 0);
      const delta = bookable - booked;
      await tx.conversion.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          commission: microsToDecimal(commission),
          commissionUsd: microsToDecimal(commissionUsd),
          ...(input.orderValueMicros !== undefined && input.orderValueMicros !== null
            ? { orderValue: microsToDecimal(input.orderValueMicros) }
            : {}),
          ...(input.raw ? { raw: toJson(input.raw) as Prisma.InputJsonValue } : {}),
        },
      });
      if (delta !== 0) {
        await tx.revenueEntry.create({
          data: {
            workspaceId: input.workspaceId,
            brandId: existing.brandId,
            conversionId: existing.id,
            projectId: existing.projectId,
            variantId: existing.variantId,
            productId: existing.productId,
            platform: existing.platform,
            kind: "ADJUSTMENT",
            amount: microsToDecimal(Math.round(delta / fx)),
            currency: input.currency ?? existing.currency,
            fxRateToUsd: fx,
            amountUsd: microsToDecimal(delta),
            occurredAt: new Date(),
            source: input.source,
            isSimulated: existing.isSimulated,
            note: input.status === "REVERSED" ? "conversion reversed" : "commission updated",
          },
        });
      }
      return { conversionId: existing.id, created: false, attribution, revenueDeltaMicros: delta };
    }

    const conversion = await tx.conversion.create({
      data: {
        workspaceId: input.workspaceId,
        brandId: attribution.brandId,
        affiliateProgramId: input.affiliateProgramId ?? null,
        clickRefId: attribution.clickRefId,
        clickIdRaw: input.clickId ?? null,
        trackedLinkId: attribution.trackedLinkId,
        productId: attribution.productId,
        projectId: attribution.projectId,
        variantId: attribution.variantId,
        publicationId: attribution.publicationId,
        platform: attribution.platform,
        type: input.type,
        status: input.status,
        externalId: input.externalId ?? null,
        source: input.source,
        occurredAt: input.occurredAt,
        orderValue:
          input.orderValueMicros !== undefined && input.orderValueMicros !== null
            ? microsToDecimal(input.orderValueMicros)
            : null,
        commission: microsToDecimal(commission),
        currency: input.currency ?? "USD",
        commissionUsd: microsToDecimal(commissionUsd),
        isSimulated: input.isSimulated ?? false,
        ...(input.raw ? { raw: toJson(input.raw) as Prisma.InputJsonValue } : {}),
      },
    });
    if (bookable !== 0) {
      await tx.revenueEntry.create({
        data: {
          workspaceId: input.workspaceId,
          brandId: attribution.brandId,
          conversionId: conversion.id,
          projectId: attribution.projectId,
          variantId: attribution.variantId,
          productId: attribution.productId,
          platform: attribution.platform,
          kind,
          amount: microsToDecimal(commission),
          currency: input.currency ?? "USD",
          fxRateToUsd: fx,
          amountUsd: microsToDecimal(bookable),
          occurredAt: input.occurredAt,
          source: input.source,
          isSimulated: input.isSimulated ?? false,
        },
      });
    }
    return { conversionId: conversion.id, created: true, attribution, revenueDeltaMicros: bookable };
  });
}

/* ------------------------------------------------------------------ CSV import ------------------ */

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const HEADER_ALIASES: Record<string, string[]> = {
  occurredAt: ["date", "occurred_at", "conversion_date", "event_date", "transaction_date", "click_date"],
  externalId: ["external_id", "order_id", "transaction_id", "conversion_id", "action_id", "id"],
  clickId: ["click_id", "sub_id", "subid", "sub_id1", "subid1", "ascsubtag", "sid", "u1"],
  linkCode: ["link_code", "code"],
  program: ["program", "network", "advertiser", "affiliate_program"],
  sku: ["sku", "product_sku"],
  type: ["type", "event_type", "action_type"],
  status: ["status", "state"],
  orderValue: ["order_value", "sale_amount", "amount", "revenue", "order_amount"],
  commission: ["commission", "payout", "earnings", "commission_amount"],
  currency: ["currency", "currency_code"],
  brand: ["brand", "brand_slug"],
};

export function mapStatus(value: string | undefined): ConversionStatus {
  const v = (value ?? "").trim().toLowerCase();
  if (["approved", "confirmed", "paid", "locked", "valid", "completed"].includes(v)) return "APPROVED";
  if (["reversed", "declined", "rejected", "refunded", "cancelled", "canceled", "invalid"].includes(v))
    return "REVERSED";
  return "PENDING";
}

export function mapType(value: string | undefined): ConversionType {
  const v = (value ?? "").trim().toLowerCase();
  if (v.includes("lead")) return "LEAD";
  if (v.includes("sign") || v.includes("trial") || v.includes("register")) return "SIGNUP";
  if (v.includes("inquir") || v.includes("quote")) return "INQUIRY";
  if (v.includes("install")) return "INSTALL";
  if (v === "" || v.includes("sale") || v.includes("purchase") || v.includes("order")) return "SALE";
  return "OTHER";
}

/** "1,234.50" / "1234,50" / "$12" → micros */
export function parseMoney(value: string | undefined): Micros | null {
  if (!value) return null;
  let v = value.replace(/[^\d.,-]/g, "");
  if (!v) return null;
  if (v.includes(",") && v.includes("."))
    v =
      v.lastIndexOf(",") > v.lastIndexOf(".") ? v.replace(/\./g, "").replace(",", ".") : v.replace(/,/g, "");
  else if (v.includes(",")) v = /,\d{1,2}$/.test(v) ? v.replace(",", ".") : v.replace(/,/g, "");
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : null;
}

export interface CsvImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: { line: number; message: string }[];
}

export async function importConversionsCsv(
  prisma: PrismaClient,
  opts: {
    workspaceId: string;
    csv: string;
    defaultProgramId?: string | null;
    fxRates?: Record<string, number>;
  },
): Promise<CsvImportResult> {
  const rows = parseCsv(opts.csv);
  const result: CsvImportResult = { imported: 0, updated: 0, skipped: 0, errors: [] };
  if (rows.length < 2) return { ...result, errors: [{ line: 1, message: "CSV has no data rows" }] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const col = (key: string) => header.findIndex((h) => HEADER_ALIASES[key]!.includes(h));
  const idx = Object.fromEntries(Object.keys(HEADER_ALIASES).map((k) => [k, col(k)])) as Record<
    string,
    number
  >;
  if (idx.occurredAt === -1 || idx.commission === -1) {
    return {
      ...result,
      errors: [{ line: 1, message: "CSV needs at least a date and a commission/payout column" }],
    };
  }
  const programs = await prisma.affiliateProgram.findMany({
    where: { workspaceId: opts.workspaceId },
    select: { id: true, name: true },
  });
  const products = await prisma.product.findMany({
    where: { workspaceId: opts.workspaceId, sku: { not: null } },
    select: { id: true, sku: true },
  });

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const get = (key: string) => (idx[key]! >= 0 ? row[idx[key]!]?.trim() : undefined);
    try {
      const date = new Date(get("occurredAt") ?? "");
      if (Number.isNaN(date.getTime())) throw new Error("invalid date");
      const programName = get("program");
      const programId = programName
        ? (programs.find((p) => p.name.toLowerCase() === programName.toLowerCase())?.id ?? null)
        : (opts.defaultProgramId ?? null);
      const currency = (get("currency") || "USD").toUpperCase();
      const fx = currency === "USD" ? 1 : opts.fxRates?.[currency];
      if (fx === undefined) throw new Error(`no FX rate for ${currency}`);
      const sku = get("sku");
      const res = await recordConversion(prisma, {
        workspaceId: opts.workspaceId,
        source: "csv",
        affiliateProgramId: programId,
        externalId: get("externalId") || null,
        clickId: get("clickId") || null,
        linkCode: get("linkCode") || null,
        productId: sku ? (products.find((p) => p.sku === sku)?.id ?? null) : null,
        type: mapType(get("type")),
        status: mapStatus(get("status")),
        occurredAt: date,
        orderValueMicros: parseMoney(get("orderValue")),
        commissionMicros: parseMoney(get("commission")),
        currency,
        fxRateToUsd: fx,
        raw: Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""])),
      });
      if (res.created) result.imported++;
      else if (res.revenueDeltaMicros !== 0) result.updated++;
      else result.skipped++;
    } catch (err) {
      result.errors.push({ line: r + 1, message: (err as Error).message });
    }
  }
  return result;
}

/** Map an arbitrary webhook JSON payload using a program's field map (dot paths). */
export function mapWebhookPayload(
  payload: Record<string, unknown>,
  fieldMap: Record<string, string> | null,
): {
  externalId?: string;
  clickId?: string;
  linkCode?: string;
  status: ConversionStatus;
  type: ConversionType;
  commission: Micros | null;
  orderValue: Micros | null;
  currency: string;
  occurredAt: Date;
} {
  const map = {
    externalId: "transaction_id",
    clickId: "sub_id",
    linkCode: "link_code",
    status: "status",
    type: "type",
    commission: "commission",
    orderValue: "order_value",
    currency: "currency",
    occurredAt: "occurred_at",
    ...(fieldMap ?? {}),
  };
  const read = (path: string): string | undefined => {
    let cur: unknown = payload;
    for (const part of path.split(".")) {
      if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>))
        cur = (cur as Record<string, unknown>)[part];
      else return undefined;
    }
    if (typeof cur === "string") return cur;
    if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
    return undefined;
  };
  const occurred = read(map.occurredAt);
  const date = occurred ? new Date(occurred) : new Date();
  return {
    ...(read(map.externalId) ? { externalId: read(map.externalId)! } : {}),
    ...(read(map.clickId) ? { clickId: read(map.clickId)! } : {}),
    ...(read(map.linkCode) ? { linkCode: read(map.linkCode)! } : {}),
    status: mapStatus(read(map.status)),
    type: mapType(read(map.type)),
    commission: parseMoney(read(map.commission)),
    orderValue: parseMoney(read(map.orderValue)),
    currency: (read(map.currency) ?? "USD").toUpperCase(),
    occurredAt: Number.isNaN(date.getTime()) ? new Date() : date,
  };
}
