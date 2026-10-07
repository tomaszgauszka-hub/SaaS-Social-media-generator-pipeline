import { researchPrompt, type ResearchBriefOutput } from "@cre/ai";
import { transitionContent } from "@cre/core";
import type { Prisma } from "@cre/db";
import { idempotencyKey, toJson } from "@cre/shared";
import type { JobExecution } from "../job-types.ts";
import { payloadString } from "../job-types.ts";
import { runPaidPrompt } from "../paid.ts";
import { brandContext, productContext, productFacts } from "../prompt-context.ts";
import { enqueue } from "../outbox.ts";

/** pipeline.research — sourced facts → creative brief (positioning, benefits, objections, forbidden claims). */
export async function researchHandler(exec: JobExecution) {
  const { ctx } = exec;
  const projectId = payloadString(exec, "projectId");
  const project = await ctx.prisma.contentProject.findUniqueOrThrow({
    where: { id: projectId },
    include: { brand: true, product: true, idea: true },
  });
  if (project.status !== "RESEARCHING") {
    exec.log.info(
      { status: project.status },
      "project no longer researching — skipping (idempotent re-delivery)",
    );
    return { skipped: true };
  }
  const now = ctx.clock.now();
  let brief: ResearchBriefOutput;
  if (project.product) {
    const run = await runPaidPrompt(
      exec,
      researchPrompt,
      {
        brand: brandContext(project.brand),
        product: productContext(project.product, now),
        idea: { title: project.title, angle: project.angle ?? "problem_solution", hook: project.hook },
      },
      {
        workspaceId: project.workspaceId,
        brandId: project.brandId,
        projectId: project.id,
        opKey: `research:${project.id}:${project.revision}`,
      },
    );
    // keep only benefits that cite a real fact
    const factIds = new Set(productFacts(project.product).map((f) => f.id));
    brief = { ...run.data, keyBenefits: run.data.keyBenefits.filter((b) => factIds.has(b.factId)) };
    if (brief.keyBenefits.length === 0 && run.data.keyBenefits.length > 0) brief = run.data;
  } else {
    brief = {
      positioning: project.title,
      keyBenefits: [],
      audiencePainPoints: [],
      objections: [],
      forbiddenClaims: [],
      complianceNotes: [],
    };
  }

  await ctx.prisma.$transaction(async (tx) => {
    await transitionContent(tx, {
      projectId: project.id,
      from: "RESEARCHING",
      to: "SCRIPTING",
      actor: "WORKER",
      data: { researchBrief: toJson(brief) as Prisma.InputJsonValue },
    });
    await enqueue(ctx, tx, {
      type: "pipeline.script",
      payload: {
        projectId: project.id,
        scope: exec.payload.scope ?? "FULL",
        feedback: exec.payload.feedback ?? null,
      },
      idempotencyKey: idempotencyKey("script", { projectId: project.id, revision: project.revision }),
      workspaceId: project.workspaceId,
      brandId: project.brandId,
      projectId: project.id,
      runId: exec.job.runId,
    });
  });
  return { benefits: brief.keyBenefits.length };
}
