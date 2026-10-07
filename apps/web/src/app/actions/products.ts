"use server";

import { revalidatePath } from "next/cache";
import { importProductsCsv, ProductInput, saveProduct } from "@cre/core";
import { NotFoundError } from "@cre/shared";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/action-result";
import { db } from "@/lib/db";
import { list, lines, optStr, str } from "@/lib/form";

const MAX_CSV_BYTES = 2 * 1024 * 1024;

async function ownedBrand(brandId: string, workspaceId: string) {
  const brand = await db().brand.findUnique({
    where: { id: brandId },
    select: { id: true, workspaceId: true },
  });
  if (!brand || brand.workspaceId !== workspaceId) throw new NotFoundError("Brand", brandId);
  return brand;
}

function fail(err: unknown): ActionResult {
  if (err instanceof z.ZodError)
    return {
      ok: false,
      message: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    };
  return toActionError(err);
}

/** Facts textarea: one per line, "claim | source". A fact without a source is rejected — no unsourced claims. */
function parseFacts(text: string[]): { claim: string; source: string }[] {
  return text.map((line, i) => {
    const [claim, ...rest] = line.split("|");
    const source = rest.join("|").trim();
    if (!source)
      throw new z.ZodError([
        {
          code: "custom",
          path: ["facts", i],
          message: `fact "${(claim ?? "").trim().slice(0, 40)}" needs a source ("claim | source")`,
          input: line,
        },
      ]);
    return { claim: (claim ?? "").trim(), source };
  });
}

export async function createProductAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const brand = await ownedBrand(str(form, "brandId"), user.workspaceId);
    const programId = optStr(form, "affiliateProgramId") ?? null;
    if (programId) {
      const program = await db().affiliateProgram.findUnique({
        where: { id: programId },
        select: { workspaceId: true },
      });
      if (!program || program.workspaceId !== user.workspaceId)
        throw new NotFoundError("Affiliate program", programId);
    }
    const rate = str(form, "commissionRate");
    const input = ProductInput.parse({
      brandId: brand.id,
      title: str(form, "title"),
      kind: str(form, "kind") || "PRODUCT",
      sku: optStr(form, "sku") ?? null,
      description: optStr(form, "description") ?? null,
      manufacturer: optStr(form, "manufacturer") ?? null,
      category: optStr(form, "category") ?? null,
      productUrl: optStr(form, "productUrl") ?? null,
      affiliateUrl: optStr(form, "affiliateUrl") ?? null,
      imageUrls: list(form, "imageUrls"),
      price: optStr(form, "price") ?? null,
      currency: (str(form, "currency") || "USD").toUpperCase(),
      commissionRate: rate === "" ? null : Number(rate) / 100,
      commissionFixedUsd: optStr(form, "commissionFixedUsd") ?? null,
      tags: list(form, "tags"),
      facts: parseFacts(lines(form, "facts")),
      affiliateProgramId: programId,
    });
    if (input.facts.length === 0)
      return { ok: false, message: "Add at least one sourced fact — generation may only use these claims." };
    const res = await db().$transaction((tx) => saveProduct(tx, user.workspaceId, input));
    revalidatePath("/products");
    return { ok: true, message: res.created ? "Product created." : "Product updated (same SKU)." };
  } catch (err) {
    return fail(err);
  }
}

export async function importProductsAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const brand = await ownedBrand(str(form, "brandId"), user.workspaceId);
    const file = form.get("file");
    let csv = str(form, "csv");
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_CSV_BYTES) return { ok: false, message: "CSV larger than 2 MB." };
      csv = await file.text();
    }
    if (!csv) return { ok: false, message: "Paste CSV or choose a file." };
    const res = await importProductsCsv(db(), { workspaceId: user.workspaceId, brandId: brand.id, csv });
    revalidatePath("/products");
    const errors = res.errors
      .slice(0, 3)
      .map((e) => `line ${e.line}: ${e.message}`)
      .join("; ");
    return {
      ok: res.errors.length === 0,
      message: `${res.created} created, ${res.updated} updated${res.errors.length ? `, ${res.errors.length} error(s): ${errors}` : ""}.`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function setProductStatusAction(input: {
  productId: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
}): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const data = z
      .object({ productId: z.string().min(1), status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]) })
      .parse(input);
    const product = await db().product.findUnique({
      where: { id: data.productId },
      select: { workspaceId: true },
    });
    if (!product || product.workspaceId !== user.workspaceId)
      throw new NotFoundError("Product", data.productId);
    await db().product.update({ where: { id: data.productId }, data: { status: data.status } });
    revalidatePath("/products");
    return { ok: true, message: `Product ${data.status.toLowerCase()}.` };
  } catch (err) {
    return fail(err);
  }
}
