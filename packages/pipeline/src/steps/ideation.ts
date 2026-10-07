import { ideasPrompt, type IdeaOut } from "@cre/ai";
import { enqueueJob, productRelevance, scoreOpportunity, SCORING_MODEL, transitionContent } from "@cre/core";
import {
  decimalFieldToMicros,
  decimalToNumber,
  microsToDecimal,
  type Prisma,
  type QualityLevel,
} from "@cre/db";
import { FatalError, idempotencyKey, maxSimilarity, toJson } from "@cre/shared";
import type { JobExecution } from "../job-types.ts";
import { runPaidPrompt } from "../paid.ts";
import {
  brandContext,
  economicOutcomeFor,
  performanceSummary,
  productContext,
  recentHooks,
} from "../prompt-context.ts";
import { brandBaseline } from "../stats.ts";

/**
 * strategy.ideate — the Opportunity Engine + Content Strategist.
 * Asks the LLM for 2× candidate ideas, scores every idea with the transparent heuristic, stores ideas and
 * their (estimated!) scores, and starts pipeline runs for the best ones.
 */
export async function ideationHandler(exec: JobExecution) {
  const { ctx } = exec;
  const now = ctx.clock.now();
  const brandId = String(exec.payload.brandId);
  const productIds = Array.isArray(exec.payload.productIds) ? (exec.payload.productIds as string[]) : null;
  const requestedQuality = (exec.payload.requestedQuality as QualityLevel | undefined) ?? "STANDARD";
  const brand = await ctx.prisma.brand.findUniqueOrThrow({
    where: { id: brandId },
    include: {
      products: {
        where: { status: "ACTIVE", ...(productIds ? { id: { in: productIds } } : {}) },
        include: { offers: { where: { isPrimary: true } } },
      },
    },
  });
  if (brand.status !== "ACTIVE") throw new FatalError(`Brand ${brand.name} is ${brand.status}`);
  if (brand.products.length === 0)
    throw new FatalError(`Brand ${brand.name} has no active products to promote`);

  // Prefer products that pay the most per conversion.
  const products = [...brand.products].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 6);
  const selectCount = Math.max(1, Number(exec.payload.count ?? brand.ideasPerCycle));
  const hooks = await recentHooks(ctx.prisma, brand.id, now);
  const pastIdeas = await ctx.prisma.contentIdea.findMany({
    where: { brandId: brand.id },
    select: { title: true },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  const run = await runPaidPrompt(
    exec,
    ideasPrompt,
    {
      brand: brandContext(brand),
      products: products.map((p) => productContext(p, now)),
      count: Math.min(10, selectCount * 2 + 1),
      formats: ["SHORT_VIDEO"],
      performanceSummary: await performanceSummary(ctx.prisma, brand.id),
      avoidTitles: [...pastIdeas.map((i) => i.title), ...hooks],
    },
    { workspaceId: brand.workspaceId, brandId: brand.id, projectId: null, opKey: `ideate:${exec.job.id}` },
  );

  const productById = new Map(products.map((p) => [p.id, p]));
  const valid = run.data.ideas.filter((i) => productById.has(i.productId));
  if (valid.length === 0) throw new FatalError("LLM returned no ideas for known products");

  const latestProfile = await ctx.prisma.brandPerformanceProfile.findFirst({
    where: { brandId: brand.id },
    orderBy: { version: "desc" },
  });
  const angleLifts = extractLifts(latestProfile?.summary, "angle");
  const corpus = [...hooks, ...pastIdeas.map((i) => i.title)];

  const scored = await Promise.all(
    valid.map(async (idea) => {
      const product = productById.get(idea.productId)!;
      const outcome = economicOutcomeFor(product);
      const baseline = await brandBaseline(ctx.prisma, brand.id, now, ctx.env.MOCK_SOCIAL, outcome);
      const similarity = Math.max(
        maxSimilarity(idea.hook, corpus).score,
        maxSimilarity(idea.title, corpus).score,
      );
      const score = scoreOpportunity({
        idea: {
          angle: idea.angle,
          hookStrength: idea.hookStrength,
          purchaseIntent: idea.purchaseIntent,
          confidence: idea.confidence,
        },
        product: {
          priceMicros: product.price ? decimalFieldToMicros(product.price) : null,
          commissionRate: decimalToNumber(product.commissionRate),
          commissionFixedMicros: product.commissionFixedUsd
            ? decimalFieldToMicros(product.commissionFixedUsd)
            : null,
          kind: product.kind,
          economicOutcome: outcome,
        },
        baseline,
        historicalLift: angleLifts[idea.angle] ?? null,
        similarity,
        relevance: productRelevance(
          { category: product.category, tags: product.tags, title: product.title },
          brand.niche,
        ),
        estimatedCostMicros: 40_000, // Tier-0 production estimate (router refines this later)
      });
      return { idea, product, score };
    }),
  );
  scored.sort((a, b) => b.score.totalScore - a.score.totalScore);

  const selected: string[] = [];
  for (const [rank, s] of scored.entries()) {
    const isSelected = rank < selectCount;
    const projectId = await ctx.prisma.$transaction(async (tx) => {
      const idea = await tx.contentIdea.create({
        data: {
          workspaceId: brand.workspaceId,
          brandId: brand.id,
          productId: s.product.id,
          offerId: s.product.offers[0]?.id ?? null,
          title: s.idea.title,
          angle: s.idea.angle,
          hook: s.idea.hook,
          summary: s.idea.whyItConverts,
          format: s.idea.format,
          economicOutcome: s.idea.economicOutcome,
          targetAudience: s.idea.targetAudience,
          rationale: s.idea.whyItConverts,
          riskNotes: s.idea.riskNotes || null,
          status: isSelected ? "SELECTED" : "PROPOSED",
          source: "strategy_engine",
          promptVersionId: run.promptVersionId,
          score: {
            create: {
              totalScore: s.score.totalScore,
              expectedCtr: s.score.expectedCtr,
              expectedConversionRate: s.score.expectedConversionRate,
              expectedImpressions: s.score.expectedImpressions,
              estimatedRevenueUsd: microsToDecimal(s.score.estimatedRevenueMicros),
              estimatedCostUsd: microsToDecimal(s.score.estimatedCostMicros),
              expectedProfitUsd: microsToDecimal(s.score.expectedProfitMicros),
              novelty: s.score.novelty,
              relevance: s.score.relevance,
              similarity: s.score.similarity,
              commissionScore: s.score.commissionScore,
              confidence: s.score.confidence,
              factors: toJson({
                ...s.score.factors,
                hookStrength: s.idea.hookStrength,
                purchaseIntent: s.idea.purchaseIntent,
              }) as Prisma.InputJsonValue,
              model: SCORING_MODEL,
            },
          },
        },
      });
      if (!isSelected) return null;
      return startProject(tx, {
        brand,
        idea: s.idea,
        ideaId: idea.id,
        productId: s.product.id,
        offerId: s.product.offers[0]?.id ?? null,
        requestedQuality,
        trigger: exec.payload.trigger === "auto" ? "STRATEGY" : "MANUAL",
        now,
      });
    });
    if (projectId) selected.push(projectId);
  }
  exec.log.info({ ideas: scored.length, selected: selected.length }, "ideation complete");
  return {
    ideas: scored.length,
    selectedProjectIds: selected,
    topScore: scored[0]?.score.totalScore ?? null,
  };
}

function valueOf(p: {
  price: Prisma.Decimal | null;
  commissionRate: Prisma.Decimal | null;
  commissionFixedUsd: Prisma.Decimal | null;
}): number {
  const fixed = p.commissionFixedUsd ? decimalFieldToMicros(p.commissionFixedUsd) : 0;
  if (fixed) return fixed;
  return p.price && p.commissionRate
    ? decimalFieldToMicros(p.price) * (decimalToNumber(p.commissionRate) ?? 0)
    : 0;
}

function extractLifts(summary: unknown, dimension: string): Record<string, number> {
  const stats =
    (summary as { byDimension?: Record<string, { value: string; lift: number | null; n: number }[]> } | null)
      ?.byDimension?.[dimension] ?? [];
  return Object.fromEntries(stats.filter((s) => s.lift !== null && s.n >= 3).map((s) => [s.value, s.lift!]));
}

interface StartProjectInput {
  brand: { id: string; workspaceId: string; language: string; defaultTemplateKey: string };
  idea: Pick<IdeaOut, "title" | "angle" | "hook" | "economicOutcome" | "format">;
  ideaId: string;
  productId: string | null;
  offerId: string | null;
  requestedQuality: QualityLevel;
  trigger: "STRATEGY" | "MANUAL";
  /** pipeline clock "now" (research is due immediately) */
  now: Date;
}

/** Create a ContentProject for an idea, open a PipelineRun and queue research — atomically. */
export async function startProject(tx: Prisma.TransactionClient, input: StartProjectInput): Promise<string> {
  const template = await tx.template.findFirst({
    where: { key: input.brand.defaultTemplateKey, isActive: true },
    orderBy: { version: "desc" },
  });
  const project = await tx.contentProject.create({
    data: {
      workspaceId: input.brand.workspaceId,
      brandId: input.brand.id,
      ideaId: input.ideaId,
      productId: input.productId,
      offerId: input.offerId,
      templateId: template?.id ?? null,
      format: input.idea.format,
      economicOutcome: input.idea.economicOutcome,
      requestedQuality: input.requestedQuality,
      title: input.idea.title,
      angle: input.idea.angle,
      hook: input.idea.hook,
      language: input.brand.language,
    },
  });
  const run = await tx.pipelineRun.create({
    data: {
      workspaceId: input.brand.workspaceId,
      brandId: input.brand.id,
      projectId: project.id,
      trigger: input.trigger,
    },
  });
  await transitionContent(tx, {
    projectId: project.id,
    from: "IDEA",
    to: "RESEARCHING",
    actor: "WORKER",
    reason: "pipeline started",
  });
  await enqueueJob(tx, {
    type: "pipeline.research",
    payload: { projectId: project.id },
    idempotencyKey: idempotencyKey("research", { projectId: project.id, revision: 1 }),
    workspaceId: input.brand.workspaceId,
    brandId: input.brand.id,
    projectId: project.id,
    runId: run.id,
    runAt: input.now,
  });
  return project.id;
}
