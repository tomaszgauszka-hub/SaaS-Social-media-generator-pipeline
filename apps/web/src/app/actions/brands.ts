"use server";

import { revalidatePath } from "next/cache";
import { requestIdeation } from "@cre/core";
import { Prisma } from "@cre/db";
import { NotFoundError, toJson } from "@cre/shared";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/action-result";
import { db, env } from "@/lib/db";
import { all, bool, lines, list, money, optStr, str } from "@/lib/form";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colours must be #RRGGBB");
const PLATFORMS = ["INSTAGRAM", "FACEBOOK", "TIKTOK"] as const;
const TIERS = ["TIER_0", "TIER_1", "TIER_2", "TIER_3"] as const;
const Money = z
  .string()
  .regex(/^\d{1,7}(\.\d{1,6})?$/, "amounts must be plain numbers like 2.50")
  .nullable();

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

export async function requestIdeasAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const data = z
      .object({
        brandId: z.string().min(1),
        count: z.coerce.number().int().min(1).max(5),
        quality: z.enum(["DRAFT", "STANDARD", "PREMIUM"]),
      })
      .parse({
        brandId: str(form, "brandId"),
        count: str(form, "count") || "1",
        quality: str(form, "quality") || "STANDARD",
      });
    await ownedBrand(data.brandId, user.workspaceId);
    await requestIdeation(db(), {
      brandId: data.brandId,
      count: data.count,
      requestedQuality: data.quality,
      requestedBy: user.userId,
    });
    revalidatePath("/content");
    return {
      ok: true,
      message: `Queued — ${data.count} idea(s) will be researched, scripted, rendered and QA-checked by the worker.`,
    };
  } catch (err) {
    return fail(err);
  }
}

const BrandInput = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(1000).optional(),
  niche: z.string().min(2).max(120),
  targetAudience: z.string().min(2).max(500),
  toneOfVoice: z.string().min(2).max(500),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "unknown time zone"),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(30),
  ctaStyles: z.array(z.string().max(120)).max(10),
  contentRules: z.array(z.string().max(300)).max(30),
  bannedWords: z.array(z.string().max(60)).max(100),
  complianceNotes: z.string().max(2000).optional(),
  targetPlatforms: z.array(z.enum(PLATFORMS)).min(1),
  maxTier: z.enum(TIERS),
  allowAiVideo: z.boolean(),
  ttsEnabled: z.boolean(),
  voiceId: z.string().max(100).optional(),
  experimentsEnabled: z.boolean(),
  autoIdeationEnabled: z.boolean(),
  ideasPerCycle: z.coerce.number().int().min(1).max(10),
  qaThreshold: z.coerce.number().int().min(40).max(100),
  defaultTemplateKey: z.enum(["vertical-bold", "vertical-clean"]),
  status: z.enum(["ACTIVE", "PAUSED"]),
  colors: z.object({ primary: Hex, secondary: Hex, accent: Hex, text: Hex, background: Hex }),
});

function brandFromForm(form: FormData) {
  return BrandInput.parse({
    name: str(form, "name"),
    description: optStr(form, "description"),
    niche: str(form, "niche"),
    targetAudience: str(form, "targetAudience"),
    toneOfVoice: str(form, "toneOfVoice"),
    language: str(form, "language") || "en",
    timezone: str(form, "timezone") || "UTC",
    countries: list(form, "countries").map((c) => c.toUpperCase()),
    ctaStyles: lines(form, "ctaStyles"),
    contentRules: lines(form, "contentRules"),
    bannedWords: list(form, "bannedWords"),
    complianceNotes: optStr(form, "complianceNotes"),
    targetPlatforms: all(form, "targetPlatforms"),
    maxTier: str(form, "maxTier") || "TIER_1",
    allowAiVideo: bool(form, "allowAiVideo"),
    ttsEnabled: bool(form, "ttsEnabled"),
    voiceId: optStr(form, "voiceId"),
    experimentsEnabled: bool(form, "experimentsEnabled"),
    autoIdeationEnabled: bool(form, "autoIdeationEnabled"),
    ideasPerCycle: str(form, "ideasPerCycle") || "2",
    qaThreshold: str(form, "qaThreshold") || "70",
    defaultTemplateKey: str(form, "defaultTemplateKey") || "vertical-bold",
    status: str(form, "status") || "ACTIVE",
    colors: {
      primary: str(form, "color_primary"),
      secondary: str(form, "color_secondary"),
      accent: str(form, "color_accent"),
      text: str(form, "color_text"),
      background: str(form, "color_background"),
    },
  });
}

export async function updateBrandAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const brand = await ownedBrand(str(form, "brandId"), user.workspaceId);
    const data = brandFromForm(form);
    await db().brand.update({
      where: { id: brand.id },
      data: {
        ...data,
        description: data.description ?? null,
        complianceNotes: data.complianceNotes ?? null,
        voiceId: data.voiceId ?? null,
        colors: toJson(data.colors) as Prisma.InputJsonValue,
      },
    });
    revalidatePath(`/brands/${brand.id}`);
    return { ok: true, message: "Brand saved." };
  } catch (err) {
    return fail(err);
  }
}

export async function createBrandAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const data = brandFromForm(form);
    const slug = data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const prisma = db();
    const brand = await prisma.$transaction(async (tx) => {
      const b = await tx.brand.create({
        data: {
          ...data,
          workspaceId: user.workspaceId,
          slug: `${slug}-${Math.random().toString(36).slice(2, 6)}`,
          description: data.description ?? null,
          complianceNotes: data.complianceNotes ?? null,
          voiceId: data.voiceId ?? null,
          colors: toJson(data.colors) as Prisma.InputJsonValue,
          typography: { headingFont: "Inter", bodyFont: "Inter" },
          monetizationModels: ["AFFILIATE"],
        },
      });
      await tx.budget.create({
        data: {
          workspaceId: user.workspaceId,
          brandId: b.id,
          scopeKey: `brand:${b.id}`,
          dailyLimitUsd: "1.00",
          monthlyLimitUsd: "15.00",
          maxContentCostUsd: "0.50",
          maxAiVideoCostUsd: "0.30",
          maxRegenerations: 3,
        },
      });
      await tx.disclosureRule.create({
        data: {
          brandId: b.id,
          kind: "AFFILIATE",
          text: "#ad · affiliate link",
          placement: "CAPTION_AND_ON_SCREEN",
          jurisdiction: "US-FTC",
        },
      });
      await tx.disclosureRule.create({
        data: {
          brandId: b.id,
          kind: "AI_GENERATED",
          text: "Some visuals are AI-generated.",
          placement: "CAPTION_END",
        },
      });
      const slots = { TIKTOK: "12:00", INSTAGRAM: "15:00", FACEBOOK: "18:00" } as const;
      for (const p of data.targetPlatforms) {
        // MOCK MODE: a mock account per platform so the full lifecycle works without any real connection
        const account = env().MOCK_SOCIAL
          ? await tx.socialAccount.create({
              data: {
                workspaceId: user.workspaceId,
                brandId: b.id,
                platform: p,
                handle: `@${slug}`,
                displayName: `${data.name} (${p.toLowerCase()} mock)`,
                status: "MOCK",
                isMock: true,
              },
            })
          : null;
        await tx.publishingSlot.create({
          data: { brandId: b.id, platform: p, timeOfDay: slots[p], socialAccountId: account?.id ?? null },
        });
      }
      return b;
    });
    revalidatePath("/brands");
    return {
      ok: true,
      message: `Brand "${brand.name}" created with default budget, disclosure rules and posting slots.`,
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      return { ok: false, message: "A brand with that name already exists." };
    return fail(err);
  }
}

export async function updateBudgetAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const scope = str(form, "scope");
    const data = z
      .object({
        dailyLimitUsd: Money,
        weeklyLimitUsd: Money,
        monthlyLimitUsd: Money,
        maxContentCostUsd: Money,
        maxAiVideoCostUsd: Money,
        maxRegenerations: z.coerce.number().int().min(0).max(50).nullable(),
        isEnforced: z.boolean(),
      })
      .parse({
        dailyLimitUsd: money(form, "dailyLimitUsd"),
        weeklyLimitUsd: money(form, "weeklyLimitUsd"),
        monthlyLimitUsd: money(form, "monthlyLimitUsd"),
        maxContentCostUsd: money(form, "maxContentCostUsd"),
        maxAiVideoCostUsd: money(form, "maxAiVideoCostUsd"),
        maxRegenerations: str(form, "maxRegenerations") === "" ? null : str(form, "maxRegenerations"),
        isEnforced: bool(form, "isEnforced"),
      });
    let scopeKey: string;
    let brandId: string | null = null;
    if (scope === "workspace") scopeKey = `workspace:${user.workspaceId}`;
    else {
      const brand = await ownedBrand(str(form, "brandId"), user.workspaceId);
      brandId = brand.id;
      scopeKey = `brand:${brand.id}`;
    }
    await db().budget.upsert({
      where: { scopeKey },
      update: data,
      create: { ...data, scopeKey, workspaceId: user.workspaceId, brandId },
    });
    revalidatePath("/costs");
    if (brandId) revalidatePath(`/brands/${brandId}`);
    return { ok: true, message: "Budget saved — enforced before every paid call." };
  } catch (err) {
    return fail(err);
  }
}

export async function addSlotAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const brand = await ownedBrand(str(form, "brandId"), user.workspaceId);
    const data = z
      .object({
        platform: z.enum(PLATFORMS),
        timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:mm"),
        dayOfWeek: z.coerce.number().int().min(0).max(6).nullable(),
      })
      .parse({
        platform: str(form, "platform"),
        timeOfDay: str(form, "timeOfDay"),
        dayOfWeek: str(form, "dayOfWeek") === "" ? null : str(form, "dayOfWeek"),
      });
    const account = await db().socialAccount.findFirst({
      where: { brandId: brand.id, platform: data.platform, status: { not: "DISCONNECTED" } },
    });
    await db().publishingSlot.create({
      data: { brandId: brand.id, ...data, socialAccountId: account?.id ?? null },
    });
    revalidatePath(`/brands/${brand.id}`);
    return { ok: true, message: "Slot added." };
  } catch (err) {
    return fail(err);
  }
}

export async function removeSlotAction(input: { slotId: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const slot = await db().publishingSlot.findUnique({
      where: { id: input.slotId },
      include: { brand: { select: { workspaceId: true } } },
    });
    if (!slot || slot.brand.workspaceId !== user.workspaceId) throw new NotFoundError("Slot", input.slotId);
    await db().publishingSlot.delete({ where: { id: slot.id } });
    revalidatePath(`/brands/${slot.brandId}`);
    return { ok: true, message: "Slot removed." };
  } catch (err) {
    return fail(err);
  }
}

export async function addDisclosureAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const brand = await ownedBrand(str(form, "brandId"), user.workspaceId);
    const data = z
      .object({
        kind: z.enum(["AFFILIATE", "AD", "SPONSORED", "AI_GENERATED"]),
        text: z.string().min(2).max(200),
        placement: z.enum(["CAPTION_START", "CAPTION_END", "ON_SCREEN", "CAPTION_AND_ON_SCREEN"]),
        platform: z.enum(PLATFORMS).nullable(),
        jurisdiction: z.string().max(60).nullable(),
      })
      .parse({
        kind: str(form, "kind"),
        text: str(form, "text"),
        placement: str(form, "placement"),
        platform: str(form, "platform") || null,
        jurisdiction: str(form, "jurisdiction") || null,
      });
    await db().disclosureRule.create({ data: { brandId: brand.id, ...data, isRequired: true } });
    revalidatePath(`/brands/${brand.id}`);
    return { ok: true, message: "Disclosure rule added — QA enforces it on every variant." };
  } catch (err) {
    return fail(err);
  }
}

export async function removeDisclosureAction(input: { ruleId: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const rule = await db().disclosureRule.findUnique({
      where: { id: input.ruleId },
      include: { brand: { select: { workspaceId: true } } },
    });
    if (!rule || rule.brand.workspaceId !== user.workspaceId)
      throw new NotFoundError("Disclosure rule", input.ruleId);
    await db().disclosureRule.delete({ where: { id: rule.id } });
    revalidatePath(`/brands/${rule.brandId}`);
    return { ok: true, message: "Rule removed." };
  } catch (err) {
    return fail(err);
  }
}
