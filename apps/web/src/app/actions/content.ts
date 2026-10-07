"use server";

import { revalidatePath } from "next/cache";
import {
  approveContent,
  editContentText,
  rejectContent,
  requestRegeneration,
  retryProject,
  unapproveContent,
} from "@cre/core";
import { NotFoundError } from "@cre/shared";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/action-result";
import { db } from "@/lib/db";

const Id = z.string().min(1).max(64);
const REASONS = [
  "WEAK_HOOK",
  "BAD_IMAGE",
  "BAD_VIDEO",
  "INCORRECT_PRODUCT",
  "BAD_VOICE",
  "BAD_CTA",
  "FACTUAL_PROBLEM",
  "OTHER",
] as const;
const SCOPES = ["ENTIRE", "SCRIPT", "HOOK", "IMAGE", "VIDEO_SCENE", "VOICE", "CAPTION"] as const;

/** Every action re-checks that the content belongs to the signed-in user's workspace. */
async function ownedProject(projectId: string, workspaceId: string) {
  const project = await db().contentProject.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, title: true },
  });
  if (!project || project.workspaceId !== workspaceId) throw new NotFoundError("Content", projectId);
  return project;
}

/**
 * App pages are dynamic (rendered per request), so no cache needs purging for the approval decisions. Not
 * revalidating keeps the decided card on screen — dimmed, with its result — instead of unmounting it mid-tap.
 * Actions whose page should visibly change (retry / withdraw on the detail page) refresh that page explicitly.
 */
function refreshDetail(projectId: string) {
  revalidatePath(`/content/${projectId}`);
}

export async function approveAction(input: {
  projectId: string;
  variantIds?: string[];
  note?: string;
}): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const data = z
      .object({
        projectId: Id,
        variantIds: z.array(Id).max(10).optional(),
        note: z.string().max(1000).optional(),
      })
      .parse(input);
    const project = await ownedProject(data.projectId, user.workspaceId);
    const { publications } = await approveContent(db(), {
      projectId: project.id,
      userId: user.userId,
      ...(data.variantIds?.length ? { variantIds: data.variantIds } : {}),
      ...(data.note ? { note: data.note } : {}),
    });
    return {
      ok: true,
      message: publications.length
        ? `Approved — ${publications.length} post(s) scheduled.`
        : "Approved. No connected account for these platforms yet — nothing scheduled.",
    };
  } catch (err) {
    return err instanceof z.ZodError ? { ok: false, message: "Invalid request." } : toActionError(err);
  }
}

export async function rejectAction(input: {
  projectId: string;
  reasons: string[];
  note?: string;
}): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const data = z
      .object({
        projectId: Id,
        reasons: z.array(z.enum(REASONS)).min(1).max(8),
        note: z.string().max(2000).optional(),
      })
      .parse(input);
    const project = await ownedProject(data.projectId, user.workspaceId);
    await rejectContent(db(), {
      projectId: project.id,
      userId: user.userId,
      reasons: data.reasons,
      ...(data.note ? { note: data.note } : {}),
    });
    return { ok: true, message: "Rejected. Use Regenerate to get a new version, or leave it." };
  } catch (err) {
    return err instanceof z.ZodError
      ? { ok: false, message: "Pick at least one reason." }
      : toActionError(err);
  }
}

export async function regenerateAction(input: {
  projectId: string;
  scope: string;
  sceneId?: string;
  note?: string;
}): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const data = z
      .object({
        projectId: Id,
        scope: z.enum(SCOPES),
        sceneId: Id.optional(),
        note: z.string().max(2000).optional(),
      })
      .parse(input);
    const project = await ownedProject(data.projectId, user.workspaceId);
    await requestRegeneration(db(), {
      projectId: project.id,
      userId: user.userId,
      scope: data.scope,
      ...(data.sceneId ? { sceneId: data.sceneId } : {}),
      ...(data.note ? { note: data.note } : {}),
    });
    return {
      ok: true,
      message: `Regenerating (${data.scope.toLowerCase().replace("_", " ")}) — only that part is redone; it returns to the queue after QA.`,
    };
  } catch (err) {
    return err instanceof z.ZodError
      ? { ok: false, message: "Choose what to regenerate (and the scene for image/video)." }
      : toActionError(err);
  }
}

export async function editTextAction(input: {
  projectId: string;
  hook?: string;
  cta?: string;
  variantCaptions?: Record<string, string>;
}): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const data = z
      .object({
        projectId: Id,
        hook: z.string().trim().min(3).max(140).optional(),
        cta: z.string().trim().min(2).max(90).optional(),
        variantCaptions: z.record(Id, z.string().trim().min(10).max(2200)).optional(),
      })
      .parse(input);
    const project = await ownedProject(data.projectId, user.workspaceId);
    const { next } = await editContentText(db(), {
      projectId: project.id,
      userId: user.userId,
      ...(data.hook !== undefined ? { hook: data.hook } : {}),
      ...(data.cta !== undefined ? { cta: data.cta } : {}),
      ...(data.variantCaptions ? { variantCaptions: data.variantCaptions } : {}),
    });
    return {
      ok: true,
      message:
        next === "QA"
          ? "Captions saved — re-running QA."
          : "Text saved — re-rendering (cached scenes, only the changed voice line is regenerated).",
    };
  } catch (err) {
    return err instanceof z.ZodError
      ? { ok: false, message: "Check the text lengths (hook 3–140, CTA 2–90, captions 10–2200 characters)." }
      : toActionError(err);
  }
}

export async function unapproveAction(input: { projectId: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const project = await ownedProject(Id.parse(input.projectId), user.workspaceId);
    await unapproveContent(db(), { projectId: project.id, userId: user.userId });
    refreshDetail(project.id);
    return { ok: true, message: "Approval withdrawn — scheduled posts cancelled, back in the queue." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function retryProjectAction(input: { projectId: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const project = await ownedProject(Id.parse(input.projectId), user.workspaceId);
    const { requeued } = await retryProject(db(), { projectId: project.id, userId: user.userId });
    refreshDetail(project.id);
    revalidatePath("/jobs");
    return { ok: true, message: `Retrying — ${requeued} job(s) re-queued.` };
  } catch (err) {
    return toActionError(err);
  }
}
