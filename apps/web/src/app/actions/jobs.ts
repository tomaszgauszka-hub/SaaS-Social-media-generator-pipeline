"use server";

import { revalidatePath } from "next/cache";
import { requeueJob, transitionContent } from "@cre/core";
import { NotFoundError } from "@cre/shared";
import { requireActor } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/action-result";
import { db } from "@/lib/db";

/** Re-queue a failed / dead-lettered / budget-blocked job with its original payload. */
export async function retryJobAction(input: { jobId: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("write");
    const job = await db().generationJob.findUnique({
      where: { id: input.jobId },
      select: { id: true, workspaceId: true, projectId: true },
    });
    if (!job || job.workspaceId !== user.workspaceId) throw new NotFoundError("Job", input.jobId);
    const ok = await requeueJob(db(), job.id, "manual retry from dashboard", user.userId);
    if (!ok) return { ok: false, message: "Job is not in a retryable state." };
    // a FAILED project goes back to the step of this job
    if (job.projectId) {
      const project = await db().contentProject.findUnique({
        where: { id: job.projectId },
        select: { status: true, resumeStatus: true },
      });
      if (project?.status === "FAILED" && project.resumeStatus) {
        await transitionContent(db(), {
          projectId: job.projectId,
          from: "FAILED",
          to: project.resumeStatus,
          actor: "USER",
          userId: user.userId,
          reason: "job retried",
          data: { resumeStatus: null, failureReason: null },
        });
      }
    }
    revalidatePath("/jobs");
    return { ok: true, message: "Re-queued." };
  } catch (err) {
    return toActionError(err);
  }
}
