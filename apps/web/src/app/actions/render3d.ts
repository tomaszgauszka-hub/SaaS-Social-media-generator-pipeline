"use server";

import { revalidatePath } from "next/cache";
import { requeueJob } from "@cre/core";
import { Recipe3D, type Asset3D } from "@cre/render3d/contracts";
import { NotFoundError } from "@cre/shared";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/action-result";
import { db, env } from "@/lib/db";
import { str } from "@/lib/form";
import {
  CLIP_TYPES,
  clipRecipe,
  isDemoProduct,
  nextSeedRecipe,
  parseAsset,
  productionGate,
  recipeFieldErrors,
  recipeInputFromForm,
  renderJobId,
  renderJobKey,
  resolveProductModel,
  routePreview,
  stationStatus,
  workspaceLibrary,
  type FormField,
  type RoutePreview,
} from "@/lib/render3d";
import { ROUTE_ENGINE_LABEL } from "@/lib/render3d-labels";
import { enqueueRender3d, registerDemoProduct } from "@/lib/render3d-runtime";

/*
 * 3D studio actions. Every action re-checks the signed-in user and that the clip / model belongs to their
 * workspace. Nothing here publishes: rendering happens on the render station (job queue), approval is recorded
 * on the library record with the user's email.
 */

const PATH = "/studio-3d";
const AssetId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/)
  .refine((s) => !s.includes(".."));
const RETRYABLE = ["FAILED", "DEAD_LETTER", "BUDGET_BLOCKED", "CANCELLED"];

export interface Render3DFormState extends ActionResult {
  fieldErrors?: Partial<Record<FormField, string>>;
  route?: RoutePreview | null;
  jobId?: string;
}

/** Enqueue (idempotent per job id); an earlier failed job with the same id is re-queued instead. */
async function enqueue(
  user: { workspaceId: string; userId: string },
  jobId: string,
  recipe: Recipe3D,
): Promise<{ created: boolean; status: string; requeued: boolean }> {
  const res = await enqueueRender3d(db(), {
    jobId,
    recipe,
    workspaceId: user.workspaceId,
    brandId: null,
    ...(isDemoProduct(recipe.productAssetId) ? { demoProduct: recipe.productAssetId } : {}),
  });
  if (res.created) return { created: true, status: "QUEUED", requeued: false };
  const job = await db().generationJob.findUnique({
    where: { idempotencyKey: renderJobKey(jobId) },
    select: { id: true, status: true, workspaceId: true },
  });
  if (!job || job.workspaceId !== user.workspaceId) throw new NotFoundError("Render job", jobId);
  if (RETRYABLE.includes(job.status)) {
    const requeued = await requeueJob(db(), job.id, "re-submitted from the 3D studio", user.userId);
    return { created: false, status: requeued ? "QUEUED" : job.status, requeued };
  }
  return { created: false, status: job.status, requeued: false };
}

function enqueueMessage(
  r: { created: boolean; status: string; requeued: boolean },
  route: RoutePreview,
  what: string,
): Render3DFormState {
  if (!r.created && !r.requeued) {
    if (r.status === "SUCCEEDED")
      return {
        ok: false,
        message:
          "This exact recipe was already rendered — the same recipe gives the same pixels. Change a setting, or use “Regenerate shot” on the clip for a new take.",
        route,
      };
    return {
      ok: true,
      message: `Already in the queue (${r.status.toLowerCase()}) — nothing new queued.`,
      route,
    };
  }
  const prefix = r.requeued
    ? `Re-queued the earlier failed ${what}`
    : `${what[0]!.toUpperCase()}${what.slice(1)} queued`;
  if (!route.stationOnline || route.engine === "DEFER")
    return {
      ok: true,
      message: `${prefix}. The render station is offline — the job waits in the queue and resumes by itself when the station is back.`,
      route,
    };
  const eta = route.estimate ? ` (≈ ${Math.max(1, Math.round(route.estimate.seconds / 60))} min)` : "";
  return {
    ok: true,
    message: `${prefix} on ${ROUTE_ENGINE_LABEL[route.engine] ?? route.engine}${eta}. The clip appears in the library after render and QA.`,
    route,
  };
}

/**
 * "Generate 3D material" form: intent = check (router dry run, nothing written) | preview | production.
 * Validates with Recipe3D, routes like the render worker would, then enqueues through the outbox.
 */
export async function render3dFormAction(
  _prev: Render3DFormState | null,
  form: FormData,
): Promise<Render3DFormState> {
  try {
    const user = await requireActor("write");
    const intent = str(form, "intent");
    if (intent !== "check" && intent !== "preview" && intent !== "production")
      return { ok: false, message: "Unknown action." };
    const quality = intent === "production" ? "production" : "preview";
    const parsed = Recipe3D.safeParse(recipeInputFromForm(form, quality));
    if (!parsed.success)
      return {
        ok: false,
        message: "Check the highlighted fields.",
        fieldErrors: recipeFieldErrors(parsed.error),
      };
    const recipe = parsed.data;
    const prisma = db();
    const product = await resolveProductModel(prisma, user.workspaceId, recipe.productAssetId);
    if (!product)
      return {
        ok: false,
        message: "Check the highlighted fields.",
        fieldErrors: { productAssetId: "This product model is not in your library (or was rejected)." },
      };
    if (recipe.focus && product.parts.length && !product.parts.some((p) => p.name === recipe.focus))
      return {
        ok: false,
        message: "Check the highlighted fields.",
        fieldErrors: { focus: `“${recipe.focus}” is not a part of ${product.assetId}.` },
      };

    const station = await stationStatus(prisma);
    const { decision, preview } = await routePreview(prisma, user.workspaceId, recipe, product, station);
    const productionCheck = await productionGate(
      prisma,
      user.workspaceId,
      [recipe, decision.recipe],
      product,
    );
    const route: RoutePreview = {
      ...preview,
      production: productionCheck,
    };

    if (intent === "check")
      return {
        ok: decision.engine !== "BLOCKED",
        message: "Dry run — nothing was queued or saved.",
        route,
      };

    switch (decision.engine) {
      case "BLOCKED":
        return {
          ok: false,
          message: `Not queued: ${decision.reasons.join("; ")}`,
          route,
          ...(/template|construction|structure/i.test(decision.reasons.join(" "))
            ? { fieldErrors: { template: "Not possible with this model (see the router decision)." } }
            : /focus/i.test(decision.reasons.join(" "))
              ? { fieldErrors: { focus: "Not a part of this model." } }
              : {}),
        };
      case "EXISTING_ASSET":
        return {
          ok: true,
          message: `Already in the library: ${decision.existingAsset?.assetId ?? "existing clip"} — reused, nothing to render.`,
          route,
        };
      case "PROGRAMMATIC_2D":
        return {
          ok: recipe.engine === "2D_ONLY",
          message:
            recipe.engine === "EXISTING_ASSET"
              ? "Not queued: no clip with this recipe in the library yet — render a preview with engine Auto or Blender first."
              : `Not queued — no 3D render needed: ${decision.reasons.join("; ")}. The 2D pipeline animates the product media in the reel.`,
          route,
        };
      case "EXTERNAL_AI":
        return { ok: false, message: "External AI generation is not enabled for 3D clips.", route };
      case "BLENDER":
      case "UNREAL":
      case "DEFER":
        break;
    }

    if (quality === "production" && !productionCheck.ready)
      return { ok: false, message: productionCheck.message, route };

    // a demo product enters the library on its first render (idempotent; the worker registers it too)
    if (isDemoProduct(recipe.productAssetId))
      await registerDemoProduct(workspaceLibrary(prisma, user.workspaceId), recipe.productAssetId);
    const jobId = renderJobId(user.workspaceId, recipe);
    const r = await enqueue(user, jobId, recipe);
    revalidatePath(PATH);
    return { ...enqueueMessage(r, route, `${quality} render`), jobId };
  } catch (err) {
    return toActionError(err);
  }
}

/** A clip of the signed-in user's workspace (validated record), or NotFoundError. */
async function ownedClip(assetId: string, workspaceId: string): Promise<Asset3D> {
  const id = AssetId.parse(assetId);
  const row = await db().render3DAsset.findUnique({
    where: { id },
    select: { workspaceId: true, assetType: true, record: true },
  });
  const asset = row ? parseAsset(row.record) : null;
  if (!row || row.workspaceId !== workspaceId || !CLIP_TYPES.includes(row.assetType) || !asset)
    throw new NotFoundError("3D clip", id);
  return asset;
}

export async function approveClip3dAction(input: { assetId: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const clip = await ownedClip(input.assetId, user.workspaceId);
    await workspaceLibrary(db(), user.workspaceId).setApproval(clip.assetId, "APPROVED", user.email);
    revalidatePath(PATH);
    return {
      ok: true,
      message:
        clip.quality === "preview"
          ? "Approved — production renders of this recipe are unlocked."
          : clip.isDemoOnly
            ? "Approved (DEMO_ONLY — never published)."
            : "Approved — the clip can be used in storyboards.",
    };
  } catch (err) {
    return err instanceof z.ZodError ? { ok: false, message: "Invalid request." } : toActionError(err);
  }
}

export async function rejectClip3dAction(input: { assetId: string; note?: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const data = z.object({ assetId: z.string(), note: z.string().trim().max(1000).optional() }).parse(input);
    const clip = await ownedClip(data.assetId, user.workspaceId);
    await workspaceLibrary(db(), user.workspaceId).setApproval(
      clip.assetId,
      "REJECTED",
      user.email,
      data.note || undefined,
    );
    revalidatePath(PATH);
    return {
      ok: true,
      message: "Rejected — it is never reused. Use “Regenerate shot” for a new take.",
    };
  } catch (err) {
    return err instanceof z.ZodError
      ? { ok: false, message: "The note can be at most 1000 characters." }
      : toActionError(err);
  }
}

/** The clip's recipe with a new seed (a production clip gets a preview of the new take first when required). */
export async function regenerateClip3dAction(input: { assetId: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const prisma = db();
    const clip = await ownedClip(input.assetId, user.workspaceId);
    const recipe = await clipRecipe(prisma, user.workspaceId, clip);
    if (!recipe)
      return {
        ok: false,
        message: "The recipe of this clip is not available — create it again in the form.",
      };
    const product = await resolveProductModel(prisma, user.workspaceId, recipe.productAssetId);
    if (!product)
      return { ok: false, message: `The product model ${recipe.productAssetId} is not available.` };
    const previewFirst = recipe.quality === "production" && env().RENDER3D_REQUIRE_APPROVED_PREVIEW;
    const base = previewFirst ? Recipe3D.parse({ ...recipe, quality: "preview" }) : recipe;
    const next = await nextSeedRecipe(prisma, user.workspaceId, base, product);
    if (isDemoProduct(next.recipe.productAssetId))
      await registerDemoProduct(workspaceLibrary(prisma, user.workspaceId), next.recipe.productAssetId);
    const r = await enqueue(user, next.jobId, next.recipe);
    revalidatePath(PATH);
    const station = await stationStatus(prisma);
    const where = station.online
      ? "on the render station"
      : "— the station is offline, the job waits and resumes by itself";
    if (!r.created && !r.requeued)
      return { ok: true, message: `A new take is already queued (${r.status.toLowerCase()}).` };
    return {
      ok: true,
      message: previewFirst
        ? `New take (seed ${next.recipe.seed}) queued as a preview ${where}. Approve it, then render production.`
        : `New take (seed ${next.recipe.seed}) queued ${where}.`,
    };
  } catch (err) {
    return err instanceof z.ZodError ? { ok: false, message: "Invalid request." } : toActionError(err);
  }
}
