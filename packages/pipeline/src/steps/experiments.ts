import { latestPerPublication } from "@cre/analytics";
import { CONTENT_DEFAULTS } from "@cre/config";
import type { Brand, ContentProject, ContentVariant, Prisma } from "@cre/db";
import type { SocialPlatform } from "@cre/publishing";
import { maxSimilarity, toJson } from "@cre/shared";
import type { PipelineContext } from "../context.ts";
import type { StoredScript } from "./script.ts";

/**
 * Cheap A/B experiments that reuse every asset:
 *   HOOK    (brands without voice-over) — arm B is a final-pass re-render with another on-screen hook (cached scenes)
 *   CAPTION (brands with voice-over)    — arm B keeps the video and opens the caption with the other hook, so the
 *                                         narration never contradicts the on-screen text
 * Both arms go to the brand's primary platform in separate slots and are compared on CTR (tracked-link clicks /
 * impressions) once each has a 72 h snapshot. Simulated (mock) data decides only in mock mode.
 */
export interface ExperimentPlan {
  experimentId: string | null;
  variable: "HOOK" | "CAPTION";
  platform: SocialPlatform;
  hook: string;
  hookStyle: string;
}

interface Arm {
  key: string;
  label: string;
  value: string;
}

export async function planExperiment(
  ctx: PipelineContext,
  project: Pick<ContentProject, "id" | "hook" | "hookStyle"> & {
    brand: Pick<Brand, "experimentsEnabled" | "ttsEnabled">;
  },
  script: StoredScript | null,
  platforms: SocialPlatform[],
): Promise<ExperimentPlan | null> {
  if (!project.brand.experimentsEnabled || platforms.length === 0) return null;
  const running = await ctx.prisma.experiment.findFirst({
    where: { projectId: project.id, status: "RUNNING" },
  });
  if (running) {
    const b = (running.arms as unknown as Arm[]).find((a) => a.key === "B");
    if (!b || (running.variable !== "HOOK" && running.variable !== "CAPTION")) return null;
    return {
      experimentId: running.id,
      variable: running.variable,
      platform: running.primaryPlatform as SocialPlatform,
      hook: b.value,
      hookStyle: b.label,
    };
  }
  if (!script || !project.hook) return null;
  const candidate = script.hookVariants.find(
    (h) =>
      h.style !== script.hookStyle &&
      maxSimilarity(h.text, [project.hook ?? ""]).score < CONTENT_DEFAULTS.duplicateHookSimilarity,
  );
  if (!candidate) return null;
  return {
    experimentId: null,
    variable: project.brand.ttsEnabled ? "CAPTION" : "HOOK",
    platform: platforms.includes("TIKTOK") ? "TIKTOK" : platforms[0]!,
    hook: candidate.text,
    hookStyle: candidate.style,
  };
}

/** Replace the caption's opening paragraph with another hook (plain text). */
export function captionWithOpening(body: string, opening: string): string {
  const plain = opening.replace(/\*/g, "").trim();
  const paragraphs = body.trim().split(/\n\s*\n/);
  return [plain, ...paragraphs.slice(1)].join("\n\n");
}

export async function createExperiment(
  tx: Prisma.TransactionClient,
  input: { projectId: string; plan: ExperimentPlan; hookA: string; styleA: string },
): Promise<string> {
  if (input.plan.experimentId) return input.plan.experimentId;
  const arms: Arm[] = [
    { key: "A", label: input.styleA, value: input.hookA },
    { key: "B", label: input.plan.hookStyle, value: input.plan.hook },
  ];
  const exp = await tx.experiment.create({
    data: {
      projectId: input.projectId,
      variable: input.plan.variable,
      primaryPlatform: input.plan.platform,
      metric: "ctr",
      hypothesis: `${input.plan.variable === "HOOK" ? "On-screen hook" : "Caption opening"} "${input.plan.hook.replace(/\*/g, "")}" (${input.plan.hookStyle}) gets a higher CTR than "${input.hookA.replace(/\*/g, "")}" (${input.styleA})`,
      arms: toJson(arms) as Prisma.InputJsonValue,
    },
  });
  return exp.id;
}

export function armOverrides(variant: Pick<ContentVariant, "overrides">): {
  hook?: string;
  hookStyle?: string;
} {
  return (variant.overrides ?? {}) as { hook?: string; hookStyle?: string };
}

/* ------------------------------------------------------------------ decision ----------------- */

export interface ArmResult {
  key: string;
  impressions: number;
  clicks: number;
}

export interface ExperimentDecision {
  winner: string | null;
  liftPct: number | null;
  reason: string;
  arms: (ArmResult & { ctr: number | null })[];
}

/**
 * CTR comparison with deliberately conservative guards: enough impressions per arm and a minimum relative lift,
 * otherwise "inconclusive" (no winner is better than a wrong winner feeding the learning loop).
 */
export function decideExperiment(
  arms: ArmResult[],
  opts: { minImpressions?: number; minLift?: number } = {},
): ExperimentDecision {
  const minImpressions = opts.minImpressions ?? 300;
  const minLift = opts.minLift ?? 0.1;
  const withCtr = arms.map((a) => ({ ...a, ctr: a.impressions > 0 ? a.clicks / a.impressions : null }));
  const a = withCtr.find((x) => x.key === "A");
  const b = withCtr.find((x) => x.key === "B");
  if (!a || !b) return { winner: null, liftPct: null, reason: "missing arm", arms: withCtr };
  if (a.impressions < minImpressions || b.impressions < minImpressions) {
    return {
      winner: null,
      liftPct: null,
      reason: `fewer than ${minImpressions} impressions per arm`,
      arms: withCtr,
    };
  }
  if (!a.ctr || a.ctr === 0) {
    return b.ctr && b.ctr > 0
      ? { winner: "B", liftPct: null, reason: "arm A had no clicks", arms: withCtr }
      : { winner: null, liftPct: null, reason: "no clicks", arms: withCtr };
  }
  const lift = ((b.ctr ?? 0) - a.ctr) / a.ctr;
  const liftPct = Math.round(lift * 1000) / 10;
  if (Math.abs(lift) < minLift)
    return { winner: null, liftPct, reason: `difference below ${minLift * 100}%`, arms: withCtr };
  return { winner: lift > 0 ? "B" : "A", liftPct, reason: "CTR difference above threshold", arms: withCtr };
}

/** Conclude running experiments whose arms all have a 72 h snapshot (called by the maintenance tick). */
export async function concludeExperiments(ctx: PipelineContext, now: Date): Promise<number> {
  const running = await ctx.prisma.experiment.findMany({
    where: { status: "RUNNING" },
    include: { variants: { include: { publications: { include: { snapshots: true } } } } },
    take: 50,
  });
  let concluded = 0;
  for (const exp of running) {
    const pubs = exp.variants.flatMap((v) =>
      v.publications.map((p) => ({ ...p, armKey: v.armKey, variantId: v.id })),
    );
    if (pubs.some((p) => p.status === "FAILED" || p.status === "CANCELLED")) {
      await ctx.prisma.experiment.update({
        where: { id: exp.id },
        data: {
          status: "CANCELLED",
          concludedAt: now,
          results: toJson({ reason: "an arm was not published" }) as Prisma.InputJsonValue,
        },
      });
      continue;
    }
    const ready =
      pubs.length >= 2 &&
      pubs.every(
        (p) =>
          p.status === "PUBLISHED" &&
          p.publishedAt &&
          now.getTime() - p.publishedAt.getTime() >= 72 * 3_600_000,
      );
    if (!ready) continue;
    const latest = latestPerPublication(pubs.flatMap((p) => p.snapshots));
    const arms: ArmResult[] = [];
    for (const key of ["A", "B"]) {
      const armPubs = pubs.filter((p) => p.armKey === key);
      const clicks = await ctx.prisma.click.count({
        where: {
          variantId: { in: armPubs.map((p) => p.variantId) },
          isBot: false,
          ...(ctx.env.MOCK_SOCIAL ? {} : { isSimulated: false }),
        },
      });
      arms.push({
        key,
        impressions: armPubs.reduce((s, p) => s + (latest.get(p.id)?.impressions ?? 0), 0),
        clicks,
      });
    }
    const decision = decideExperiment(arms);
    await ctx.prisma.experiment.update({
      where: { id: exp.id },
      data: {
        status: "CONCLUDED",
        winnerArmKey: decision.winner,
        concludedAt: now,
        results: toJson({
          ...decision,
          method: "ctr-compare-v1",
          simulated: ctx.env.MOCK_SOCIAL,
        }) as Prisma.InputJsonValue,
      },
    });
    concluded++;
  }
  return concluded;
}
