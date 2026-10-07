"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { importConversionsCsv, parseMoney, recordConversion } from "@cre/core";
import { microsToDecimal, Prisma } from "@cre/db";
import { NotFoundError, sha256Hex } from "@cre/shared";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/action-result";
import { db, env } from "@/lib/db";
import { optStr, str } from "@/lib/form";

const MAX_CSV_BYTES = 5 * 1024 * 1024;

function fail(err: unknown): ActionResult {
  if (err instanceof z.ZodError)
    return {
      ok: false,
      message: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    };
  return toActionError(err);
}

async function ownedProgram(id: string | null, workspaceId: string) {
  if (!id) return null;
  const program = await db().affiliateProgram.findUnique({
    where: { id },
    select: { id: true, workspaceId: true },
  });
  if (!program || program.workspaceId !== workspaceId) throw new NotFoundError("Affiliate program", id);
  return program;
}

export async function addConversionAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const data = z
      .object({
        programId: z.string().nullable(),
        productId: z.string().nullable(),
        type: z.enum(["SALE", "LEAD", "SIGNUP", "INQUIRY", "INSTALL", "OTHER"]),
        status: z.enum(["PENDING", "APPROVED", "REVERSED"]),
        occurredAt: z.coerce.date(),
        commission: z.string().min(1),
        orderValue: z.string().nullable(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        fxRateToUsd: z.coerce.number().positive().max(10_000),
        clickId: z.string().max(64).nullable(),
        externalId: z.string().max(120).nullable(),
      })
      .parse({
        programId: optStr(form, "programId") ?? null,
        productId: optStr(form, "productId") ?? null,
        type: str(form, "type") || "SALE",
        status: str(form, "status") || "APPROVED",
        occurredAt: str(form, "occurredAt") || new Date().toISOString(),
        commission: str(form, "commission"),
        orderValue: optStr(form, "orderValue") ?? null,
        currency: (str(form, "currency") || "USD").toUpperCase(),
        fxRateToUsd: str(form, "fxRateToUsd") || "1",
        clickId: optStr(form, "clickId") ?? null,
        externalId: optStr(form, "externalId") ?? null,
      });
    await ownedProgram(data.programId, user.workspaceId);
    if (data.productId) {
      const product = await db().product.findUnique({
        where: { id: data.productId },
        select: { workspaceId: true },
      });
      if (!product || product.workspaceId !== user.workspaceId)
        throw new NotFoundError("Product", data.productId);
    }
    const commission = parseMoney(data.commission);
    if (commission === null) return { ok: false, message: "Commission must be a number." };
    const res = await recordConversion(db(), {
      workspaceId: user.workspaceId,
      source: "manual",
      affiliateProgramId: data.programId,
      externalId: data.externalId,
      clickId: data.clickId,
      productId: data.productId,
      type: data.type,
      status: data.status,
      occurredAt: data.occurredAt,
      commissionMicros: commission,
      orderValueMicros: data.orderValue ? parseMoney(data.orderValue) : null,
      currency: data.currency,
      fxRateToUsd: data.currency === "USD" ? 1 : data.fxRateToUsd,
    });
    revalidatePath("/revenue");
    const where = res.attribution.projectId
      ? "attributed to content"
      : res.attribution.productId
        ? "attributed to the product"
        : "unattributed (no click id)";
    return { ok: true, message: `${res.created ? "Conversion recorded" : "Conversion updated"} — ${where}.` };
  } catch (err) {
    return fail(err);
  }
}

export async function importConversionsAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const programId = optStr(form, "programId") ?? null;
    await ownedProgram(programId, user.workspaceId);
    const file = form.get("file");
    let csv = str(form, "csv");
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_CSV_BYTES) return { ok: false, message: "CSV larger than 5 MB." };
      csv = await file.text();
    }
    if (!csv) return { ok: false, message: "Paste CSV or choose a file." };
    const fxRates = Object.fromEntries(
      str(form, "fx")
        .split(/[\s,;]+/)
        .map((p) => p.split("="))
        .filter(
          (p): p is [string, string] =>
            p.length === 2 && /^[A-Za-z]{3}$/.test(p[0] ?? "") && Number(p[1]) > 0,
        )
        .map(([c, r]) => [c.toUpperCase(), Number(r)]),
    );
    const res = await importConversionsCsv(db(), {
      workspaceId: user.workspaceId,
      csv,
      defaultProgramId: programId,
      fxRates,
    });
    revalidatePath("/revenue");
    const errors = res.errors
      .slice(0, 3)
      .map((e) => `line ${e.line}: ${e.message}`)
      .join("; ");
    return {
      ok: res.errors.length === 0,
      message: `${res.imported} imported, ${res.updated} updated, ${res.skipped} unchanged${res.errors.length ? `, ${res.errors.length} error(s): ${errors}` : ""}.`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function addExpenseAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const data = z
      .object({
        category: z.enum(["INFRASTRUCTURE", "ADS", "TOOLS", "OTHER"]),
        amount: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/),
        incurredOn: z.coerce.date(),
        periodDays: z.coerce.number().int().min(1).max(366),
        brandId: z.string().nullable(),
        description: z.string().max(300).nullable(),
      })
      .parse({
        category: str(form, "category") || "INFRASTRUCTURE",
        amount: str(form, "amount"),
        incurredOn: str(form, "incurredOn") || new Date().toISOString().slice(0, 10),
        periodDays: str(form, "periodDays") || "30",
        brandId: optStr(form, "brandId") ?? null,
        description: optStr(form, "description") ?? null,
      });
    if (data.brandId) {
      const brand = await db().brand.findUnique({
        where: { id: data.brandId },
        select: { workspaceId: true },
      });
      if (!brand || brand.workspaceId !== user.workspaceId) throw new NotFoundError("Brand", data.brandId);
    }
    await db().expense.create({
      data: {
        workspaceId: user.workspaceId,
        brandId: data.brandId,
        category: data.category,
        amountUsd: data.amount,
        incurredOn: data.incurredOn,
        periodDays: data.periodDays,
        description: data.description,
      },
    });
    revalidatePath("/revenue");
    revalidatePath("/analytics");
    return { ok: true, message: "Expense added — prorated over its period in profit reports." };
  } catch (err) {
    return fail(err);
  }
}

export async function createProgramAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const rate = str(form, "defaultCommissionRate");
    const data = z
      .object({
        name: z.string().min(2).max(80),
        network: z.string().min(2).max(40),
        website: z.url().nullable(),
        redirectPolicy: z.enum(["REDIRECT_ALLOWED", "DIRECT_LINK_ONLY"]),
        subIdParam: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,40}$/)
          .nullable(),
        disclosureText: z.string().max(300).nullable(),
        defaultCommissionRate: z.number().min(0).max(1).nullable(),
        cookieDays: z.coerce.number().int().min(0).max(365).nullable(),
      })
      .parse({
        name: str(form, "name"),
        network: str(form, "network") || "custom",
        website: optStr(form, "website") ?? null,
        redirectPolicy: str(form, "redirectPolicy") || "REDIRECT_ALLOWED",
        subIdParam: optStr(form, "subIdParam") ?? null,
        disclosureText: optStr(form, "disclosureText") ?? null,
        defaultCommissionRate: rate === "" ? null : Number(rate) / 100,
        cookieDays: str(form, "cookieDays") === "" ? null : str(form, "cookieDays"),
      });
    await db().affiliateProgram.create({
      data: {
        ...data,
        workspaceId: user.workspaceId,
        defaultCommissionRate:
          data.defaultCommissionRate !== null ? data.defaultCommissionRate.toFixed(4) : null,
      },
    });
    revalidatePath("/revenue");
    return { ok: true, message: "Program added." };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      return { ok: false, message: "A program with that name exists." };
    return fail(err);
  }
}

/** New postback secret — shown ONCE; only its SHA-256 is stored. */
export async function rotatePostbackSecretAction(input: { programId: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const program = await ownedProgram(input.programId, user.workspaceId);
    if (!program) throw new NotFoundError("Affiliate program", input.programId);
    const secret = randomBytes(24).toString("base64url");
    await db().affiliateProgram.update({
      where: { id: program.id },
      data: { postbackSecretHash: sha256Hex(secret) },
    });
    revalidatePath("/revenue");
    const url = `${env().APP_URL.replace(/\/$/, "")}/api/webhooks/conversions/${program.id}?token=${secret}`;
    return { ok: true, message: `Postback URL (copy now — the token is not shown again): ${url}` };
  } catch (err) {
    return fail(err);
  }
}

export async function recordAdjustmentAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const amount = parseMoney(str(form, "amount"));
    if (amount === null)
      return { ok: false, message: "Amount must be a number (negative for refunds/clawbacks)." };
    await db().revenueEntry.create({
      data: {
        workspaceId: user.workspaceId,
        kind: "ADJUSTMENT",
        amount: microsToDecimal(amount),
        amountUsd: microsToDecimal(amount),
        occurredAt: new Date(),
        source: "manual",
        note: optStr(form, "note") ?? null,
      },
    });
    revalidatePath("/revenue");
    return { ok: true, message: "Adjustment booked." };
  } catch (err) {
    return fail(err);
  }
}
