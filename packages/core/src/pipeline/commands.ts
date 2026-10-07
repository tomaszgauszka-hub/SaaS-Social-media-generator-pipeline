import type { DbClient, PrismaClient, QualityLevel } from "@cre/db";
import { idempotencyKey, NotFoundError, StateConflictError } from "@cre/shared";
import { enqueueJob, requeueJob } from "../jobs/outbox.ts";
import { CONTENT_WORKING_STATES } from "../lifecycle/state-machine.ts";
import { transitionContent } from "../lifecycle/transitions.ts";

/**
 * Commands the dashboard (and CLI) issue to the pipeline. They only write rows (outbox jobs, state changes);
 * the worker does the work. Safe to call from the web app — no Redis, no provider calls.
 */
export async function requestIdeation(
  db: DbClient,
  input: {
    brandId: string;
    count?: number;
    productIds?: string[];
    requestedQuality?: QualityLevel;
    requestedBy?: string | null;
    now?: Date;
  },
): Promise<{ jobId: string }> {
  const brand = await db.brand.findUnique({
    where: { id: input.brandId },
    select: { id: true, workspaceId: true, status: true },
  });
  if (!brand) throw new NotFoundError("Brand", input.brandId);
  if (brand.status !== "ACTIVE") throw new StateConflictError(`Brand is ${brand.status}`);
  const now = input.now ?? new Date();
  const job = await enqueueJob(db, {
    type: "strategy.ideate",
    payload: {
      brandId: brand.id,
      ...(input.count ? { count: input.count } : {}),
      ...(input.productIds?.length ? { productIds: input.productIds } : {}),
      requestedQuality: input.requestedQuality ?? "STANDARD",
      trigger: "manual",
      requestedBy: input.requestedBy ?? null,
    },
    idempotencyKey: idempotencyKey("ideate", {
      brandId: brand.id,
      at: now.toISOString(),
      products: input.productIds ?? [],
    }),
    workspaceId: brand.workspaceId,
    brandId: brand.id,
    runAt: now,
  });
  return { jobId: job.id };
}

/**
 * Resume a FAILED project at the step that failed: the project returns to its resume state and the failed /
 * dead-lettered jobs are re-queued with their original payload.
 */
export async function retryProject(
  prisma: PrismaClient,
  input: { projectId: string; userId: string | null; now?: Date },
): Promise<{ requeued: number }> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const project = await tx.contentProject.findUnique({ where: { id: input.projectId } });
    if (!project) throw new NotFoundError("ContentProject", input.projectId);
    if (project.status !== "FAILED") throw new StateConflictError(`Content is ${project.status}, not FAILED`);
    const target =
      project.resumeStatus && (CONTENT_WORKING_STATES as readonly string[]).includes(project.resumeStatus)
        ? project.resumeStatus
        : null;
    if (!target) throw new StateConflictError("No resumable step recorded for this content");
    const failed = await tx.generationJob.findMany({
      where: { projectId: project.id, status: { in: ["FAILED", "DEAD_LETTER"] } },
      orderBy: { createdAt: "desc" },
    });
    await transitionContent(tx, {
      projectId: project.id,
      from: "FAILED",
      to: target,
      actor: "USER",
      userId: input.userId,
      reason: "manual retry",
      data: { resumeStatus: null, failureReason: null },
    });
    let requeued = 0;
    for (const j of failed)
      if (await requeueJob(tx, j.id, "manual project retry", input.userId, now)) requeued++;
    if (requeued === 0) {
      // nothing to re-run (e.g. the failure happened in the state machine) → re-enter the step
      const type =
        target === "RESEARCHING"
          ? "pipeline.research"
          : target === "SCRIPTING"
            ? "pipeline.script"
            : target === "ASSET_PLANNING"
              ? "pipeline.plan_assets"
              : target === "GENERATING_ASSETS"
                ? "pipeline.assets"
                : target === "RENDERING"
                  ? "pipeline.render"
                  : "pipeline.qa";
      await enqueueJob(tx, {
        type,
        payload: { projectId: project.id },
        idempotencyKey: idempotencyKey("retry", { projectId: project.id, at: now.getTime() }),
        runAt: now,
        workspaceId: project.workspaceId,
        brandId: project.brandId,
        projectId: project.id,
      });
      requeued = 1;
    }
    return { requeued };
  });
}
