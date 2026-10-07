import type {
  ContentStatus,
  DbClient,
  Prisma,
  PrismaClient,
  Publication,
  RegenerationScope,
  RejectionReason,
  TxClient,
} from "@cre/db";
import {
  BudgetBlockedError,
  idempotencyKey,
  NotFoundError,
  StateConflictError,
  toJson,
  ValidationError,
} from "@cre/shared";
import { decimalFieldToMicros } from "@cre/db";
import { evaluateRegenerationLimit } from "../costs/budget-evaluate.ts";
import { enqueueJob, type JobType } from "../jobs/outbox.ts";
import { regenerationEntryState } from "../lifecycle/state-machine.ts";
import { transitionContent, transitionVariant } from "../lifecycle/transitions.ts";
import { scheduleApprovedVariants, type ScheduleMode } from "../scheduling/scheduler.ts";

/**
 * Human-in-the-loop commands. The owner's recurring job is approve / reject / regenerate — everything else
 * (scheduling, publishing, analytics) follows automatically.
 */

async function loadForDecision(db: DbClient, projectId: string) {
  const project = await db.contentProject.findUnique({
    where: { id: projectId },
    include: { variants: true },
  });
  if (!project) throw new NotFoundError("ContentProject", projectId);
  return project;
}

export interface ApproveInput {
  projectId: string;
  userId: string | null;
  /** subset of variants to approve; default = every READY variant ("approve all platform variants") */
  variantIds?: string[];
  note?: string;
  scheduleMode?: ScheduleMode;
  now?: Date;
}

export async function approveContent(
  prisma: PrismaClient,
  input: ApproveInput,
): Promise<{ publications: Publication[] }> {
  return prisma.$transaction(async (tx) => {
    const project = await loadForDecision(tx, input.projectId);
    if (project.status !== "WAITING_APPROVAL") {
      throw new StateConflictError(`Content is ${project.status}, not waiting for approval`);
    }
    const ready = project.variants.filter((v) => v.status === "READY");
    const chosen = input.variantIds?.length ? ready.filter((v) => input.variantIds!.includes(v.id)) : ready;
    if (chosen.length === 0) throw new ValidationError("No ready platform variant selected");
    const now = input.now ?? new Date();

    await transitionContent(tx, {
      projectId: project.id,
      from: "WAITING_APPROVAL",
      to: "APPROVED",
      actor: "USER",
      userId: input.userId,
      data: { approvedAt: now, approvedById: input.userId },
    });
    for (const v of ready) {
      const approved = chosen.some((c) => c.id === v.id);
      await transitionVariant(tx, {
        variantId: v.id,
        from: "READY",
        to: approved ? "APPROVED" : "SKIPPED",
        ...(approved ? { data: { approvedAt: now } } : {}),
      });
    }
    await tx.approval.create({
      data: {
        projectId: project.id,
        userId: input.userId,
        decision: "APPROVED",
        reasons: [],
        note: input.note ?? null,
        revision: project.revision,
        edits: toJson({ variantIds: chosen.map((v) => v.id) }) as Prisma.InputJsonValue,
      },
    });
    const publications = await scheduleApprovedVariants(tx, project.id, {
      now,
      mode: input.scheduleMode ?? "slots",
    });
    if (publications.length > 0) {
      await transitionContent(tx, {
        projectId: project.id,
        from: "APPROVED",
        to: "SCHEDULED",
        actor: "SYSTEM",
        reason: "auto-scheduled",
      });
    }
    return { publications };
  });
}

export interface RejectInput {
  projectId: string;
  userId: string | null;
  reasons: RejectionReason[];
  note?: string;
}

export async function rejectContent(prisma: PrismaClient, input: RejectInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const project = await loadForDecision(tx, input.projectId);
    await transitionContent(tx, {
      projectId: project.id,
      from: "WAITING_APPROVAL",
      to: "REJECTED",
      actor: "USER",
      userId: input.userId,
      reason: input.reasons.join(","),
    });
    for (const v of project.variants.filter((x) => x.status === "READY")) {
      await transitionVariant(tx, { variantId: v.id, from: "READY", to: "REJECTED" });
    }
    await tx.approval.create({
      data: {
        projectId: project.id,
        userId: input.userId,
        decision: "REJECTED",
        reasons: input.reasons.length ? input.reasons : ["OTHER"],
        note: input.note ?? null,
        revision: project.revision,
      },
    });
  });
}

export interface RegenerateInput {
  projectId: string;
  userId: string | null;
  scope: RegenerationScope;
  /** scene for IMAGE / VIDEO_SCENE regeneration */
  sceneId?: string;
  note?: string;
  /** system-initiated (QA auto-reject) vs user request */
  actor?: "USER" | "SYSTEM";
  now?: Date;
}

const JOB_FOR_ENTRY: Partial<Record<ContentStatus, JobType>> = {
  RESEARCHING: "pipeline.research",
  SCRIPTING: "pipeline.script",
  GENERATING_ASSETS: "pipeline.assets",
};

/**
 * Scoped regeneration. Only the requested part is invalidated:
 *  - IMAGE / VIDEO_SCENE bump the scene revision (new asset key; other scenes are reused)
 *  - VOICE bumps the voice revision
 *  - HOOK / CAPTION / SCRIPT rerun the script step in that mode; unchanged image prompts keep their assets
 *  - ENTIRE restarts from research
 * Rendering re-uses cached scene clips, so text-only changes cost only a final FFmpeg pass.
 */
export async function requestRegeneration(
  prisma: PrismaClient,
  input: RegenerateInput,
): Promise<{ jobId: string }> {
  return prisma.$transaction(async (tx: TxClient) => {
    const project = await loadForDecision(tx, input.projectId);
    if (project.status !== "WAITING_APPROVAL" && project.status !== "REJECTED") {
      throw new StateConflictError(`Cannot regenerate content in status ${project.status}`);
    }
    const budget = await tx.budget.findUnique({ where: { scopeKey: `brand:${project.brandId}` } });
    const limit = evaluateRegenerationLimit(
      budget?.isEnforced
        ? {
            dailyMicros: null,
            weeklyMicros: null,
            monthlyMicros: null,
            contentCapMicros: budget.maxContentCostUsd
              ? decimalFieldToMicros(budget.maxContentCostUsd)
              : null,
            aiVideoCapMicros: null,
            maxRegenerations: budget.maxRegenerations,
          }
        : null,
      project.regenerationCount,
    );
    if (limit) throw new BudgetBlockedError([limit]);

    if ((input.scope === "IMAGE" || input.scope === "VIDEO_SCENE") && !input.sceneId) {
      throw new ValidationError("sceneId is required for image / video scene regeneration");
    }
    if (input.sceneId) {
      const scene = await tx.scene.findFirst({ where: { id: input.sceneId, projectId: project.id } });
      if (!scene) throw new NotFoundError("Scene", input.sceneId);
      await tx.scene.update({ where: { id: scene.id }, data: { revision: { increment: 1 } } });
    }

    const entry = regenerationEntryState(input.scope);
    const nextRevision = project.revision + 1;
    await transitionContent(tx, {
      projectId: project.id,
      from: ["WAITING_APPROVAL", "REJECTED"],
      to: entry,
      actor: input.actor ?? "USER",
      userId: input.userId,
      reason: `regenerate:${input.scope}`,
      data: {
        revision: nextRevision,
        regenerationCount: { increment: 1 },
        ...(input.scope === "VOICE" ? { voiceRevision: { increment: 1 } } : {}),
        qaScore: null,
        qaPassed: null,
        failureReason: null,
      },
    });
    const newCopy =
      input.scope === "ENTIRE" ||
      input.scope === "SCRIPT" ||
      input.scope === "HOOK" ||
      input.scope === "CAPTION";
    for (const v of project.variants.filter((x) => ["READY", "REJECTED", "SKIPPED"].includes(x.status))) {
      await transitionVariant(tx, {
        variantId: v.id,
        from: v.status,
        to: "PENDING",
        // new copy was requested → owner caption edits no longer apply
        ...(newCopy
          ? { data: { overrides: toJson(unlockCaption(v.overrides)) as Prisma.InputJsonValue } }
          : {}),
      });
    }
    await tx.approval.create({
      data: {
        projectId: project.id,
        userId: input.userId,
        decision: "REGENERATE",
        reasons: [],
        note: input.note ?? null,
        scope: input.scope,
        sceneId: input.sceneId ?? null,
        revision: project.revision,
      },
    });
    const run = await tx.pipelineRun.create({
      data: {
        workspaceId: project.workspaceId,
        brandId: project.brandId,
        projectId: project.id,
        trigger: "REGENERATION",
        scope: input.scope,
      },
    });
    const job = await enqueueJob(tx, {
      type: JOB_FOR_ENTRY[entry] ?? "pipeline.script",
      payload: {
        projectId: project.id,
        scope: input.scope,
        feedback: input.note ?? null,
        revision: nextRevision,
      },
      idempotencyKey: idempotencyKey("regen", { projectId: project.id, revision: nextRevision }),
      runAt: input.now ?? new Date(),
      workspaceId: project.workspaceId,
      brandId: project.brandId,
      projectId: project.id,
      runId: run.id,
    });
    return { jobId: job.id };
  });
}

export interface EditInput {
  projectId: string;
  userId: string | null;
  hook?: string;
  cta?: string;
  caption?: string;
  variantCaptions?: Record<string, string>;
  now?: Date;
}

/** Caption lock flag lives in ContentVariant.overrides next to experiment-arm overrides. */
function unlockCaption(overrides: Prisma.JsonValue | null): Record<string, unknown> {
  const o = { ...((overrides ?? {}) as Record<string, unknown>) };
  delete o.captionLocked;
  return o;
}

const plain = (t: string | null | undefined) =>
  (t ?? "")
    .replace(/\*/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * Owner text edits. On-screen text (hook / CTA) → asset check (only a changed voice-over line is re-generated)
 * → re-render (scenes cached); captions only → re-run QA. Edited captions are locked so re-renders keep them.
 * Edits are logged as EDITED approvals.
 */
export async function editContentText(
  prisma: PrismaClient,
  input: EditInput,
): Promise<{ next: "GENERATING_ASSETS" | "QA" }> {
  return prisma.$transaction(async (tx) => {
    const project = await loadForDecision(tx, input.projectId);
    if (project.status !== "WAITING_APPROVAL")
      throw new StateConflictError(`Cannot edit content in status ${project.status}`);
    const onScreenChanged =
      (input.hook !== undefined && input.hook !== project.hook) ||
      (input.cta !== undefined && input.cta !== project.cta);
    const scenes = await tx.scene.findMany({ where: { projectId: project.id }, orderBy: { index: "asc" } });
    const hookScene = scenes[0];
    if (input.hook !== undefined && hookScene) {
      // keep the narration in sync when the voice-over simply spoke the hook
      const speaksHook = plain(hookScene.voiceoverText) === plain(project.hook);
      await tx.scene.update({
        where: { id: hookScene.id },
        data: {
          onScreenText: input.hook,
          ...(speaksHook ? { voiceoverText: input.hook.replace(/\*/g, "") } : {}),
        },
      });
    }
    const ctaScene = scenes.findLast((s) => s.kind === "CTA");
    if (input.cta !== undefined && ctaScene) {
      const speaksCta = plain(ctaScene.voiceoverText) === plain(project.cta);
      await tx.scene.update({
        where: { id: ctaScene.id },
        data: {
          onScreenText: input.cta,
          ...(speaksCta ? { voiceoverText: input.cta.replace(/\*/g, "") } : {}),
        },
      });
    }
    for (const [variantId, caption] of Object.entries(input.variantCaptions ?? {})) {
      const variant = project.variants.find((v) => v.id === variantId);
      if (!variant) throw new ValidationError(`Variant ${variantId} does not belong to this content`);
      await tx.contentVariant.update({
        where: { id: variant.id },
        data: {
          caption,
          overrides: toJson({
            ...((variant.overrides ?? {}) as Record<string, unknown>),
            captionLocked: true,
          }) as Prisma.InputJsonValue,
        },
      });
    }
    const nextRevision = project.revision + 1;
    const next = onScreenChanged ? "GENERATING_ASSETS" : "QA";
    await transitionContent(tx, {
      projectId: project.id,
      from: "WAITING_APPROVAL",
      to: next,
      actor: "USER",
      userId: input.userId,
      reason: "edited",
      data: {
        revision: nextRevision,
        ...(input.hook !== undefined ? { hook: input.hook } : {}),
        ...(input.cta !== undefined ? { cta: input.cta } : {}),
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
      },
    });
    for (const v of project.variants.filter((x) => x.status === "READY")) {
      await transitionVariant(tx, { variantId: v.id, from: "READY", to: "PENDING" });
    }
    await tx.approval.create({
      data: {
        projectId: project.id,
        userId: input.userId,
        decision: "EDITED",
        reasons: [],
        revision: project.revision,
        edits: toJson(input) as Prisma.InputJsonValue,
      },
    });
    await enqueueJob(tx, {
      type: next === "GENERATING_ASSETS" ? "pipeline.assets" : "pipeline.qa",
      payload: { projectId: project.id, revision: nextRevision },
      idempotencyKey: idempotencyKey("edit", { projectId: project.id, revision: nextRevision }),
      runAt: input.now ?? new Date(),
      workspaceId: project.workspaceId,
      brandId: project.brandId,
      projectId: project.id,
    });
    return { next };
  });
}

/** Undo an approval before publishing: cancel scheduled publications and return to the queue. */
export async function unapproveContent(
  prisma: PrismaClient,
  input: { projectId: string; userId: string | null },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const project = await loadForDecision(tx, input.projectId);
    if (project.status !== "APPROVED" && project.status !== "SCHEDULED") {
      throw new StateConflictError(`Cannot unapprove content in status ${project.status}`);
    }
    const pubs = await tx.publication.findMany({
      where: { variant: { projectId: project.id }, status: "SCHEDULED" },
    });
    for (const p of pubs) {
      await tx.publication.update({ where: { id: p.id }, data: { status: "CANCELLED" } });
      await tx.generationJob.updateMany({
        where: { publicationId: p.id, status: { in: ["QUEUED", "DISPATCHED"] } },
        data: { status: "CANCELLED" },
      });
    }
    for (const v of project.variants.filter((x) => ["APPROVED", "SCHEDULED", "SKIPPED"].includes(x.status))) {
      await transitionVariant(tx, { variantId: v.id, from: v.status, to: "READY" });
    }
    await transitionContent(tx, {
      projectId: project.id,
      from: ["APPROVED", "SCHEDULED"],
      to: "WAITING_APPROVAL",
      actor: "USER",
      userId: input.userId,
      reason: "unapproved",
    });
  });
}
