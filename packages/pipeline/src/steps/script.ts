import {
  hookVariantsPrompt,
  platformCaptionsPrompt,
  ResearchBriefOutput,
  shortVideoScriptPrompt,
  type PlatformCaptionsOutput,
  type ScriptOutput,
} from "@cre/ai";
import { CONTENT_DEFAULTS } from "@cre/config";
import { transitionContent } from "@cre/core";
import type { Prisma, SceneKind } from "@cre/db";
import { PLATFORM_LIMITS, isSocialPlatform } from "@cre/publishing";
import { FatalError, idempotencyKey, maxSimilarity, toJson } from "@cre/shared";
import type { JobExecution } from "../job-types.ts";
import { payloadString } from "../job-types.ts";
import { runPaidPrompt } from "../paid.ts";
import { brandContext, performanceSummary, productContext, recentHooks } from "../prompt-context.ts";
import { enqueue } from "../outbox.ts";

/** Stored on ContentProject.script: the validated LLM output plus derived platform captions. */
export interface StoredScript extends ScriptOutput {
  platformCaptions?: PlatformCaptionsOutput["variants"];
}

const SCENE_KINDS = new Set<SceneKind>([
  "HOOK",
  "PROBLEM",
  "PRODUCT",
  "AI_SHOT",
  "DEMO",
  "BENEFITS",
  "COMPARISON",
  "OFFER",
  "CTA",
  "GENERIC",
]);

/** Normalise model output: HOOK first, CTA last, total duration inside the target range. */
export function normalizeScript(script: ScriptOutput, targetMs: number): ScriptOutput {
  const beats = [...script.script];
  if (beats[0]?.sceneKind !== "HOOK")
    beats.unshift({
      sceneKind: "HOOK",
      durationSec: 2.5,
      onScreenText: script.hook,
      voiceover: script.hook.replace(/\*/g, ""),
    });
  if (beats.at(-1)?.sceneKind !== "CTA")
    beats.push({ sceneKind: "CTA", durationSec: 3.5, onScreenText: script.cta, voiceover: script.cta });
  beats[0] = {
    ...beats[0]!,
    onScreenText: script.hook,
    durationSec: Math.min(3.5, Math.max(2, beats[0]!.durationSec)),
  };
  const total = beats.reduce((s, b) => s + b.durationSec, 0) * 1000;
  const min = CONTENT_DEFAULTS.shortVideoMinMs;
  const max = CONTENT_DEFAULTS.shortVideoMaxMs;
  const factor = total < min ? targetMs / total : total > max ? targetMs / total : 1;
  const scaled = beats.map((b) => ({ ...b, durationSec: Math.round(b.durationSec * factor * 10) / 10 }));
  const hashtags = [
    ...new Set(
      script.hashtags
        .map((h) => `#${h.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "")}`)
        .filter((h) => h.length > 1),
    ),
  ];
  return {
    ...script,
    script: scaled,
    hashtags,
    estimatedDuration: Math.round(scaled.reduce((s, b) => s + b.durationSec, 0) * 10) / 10,
  };
}

function visualFor(script: ScriptOutput, index: number, kind: string) {
  const v = script.visualPlan.find((p) => p.sceneIndex === index);
  if (v) return v;
  const type =
    kind === "PRODUCT" || kind === "OFFER"
      ? "product_image"
      : kind === "CTA"
        ? "text_card"
        : "generated_image";
  return { sceneIndex: index, type, description: kind } as ScriptOutput["visualPlan"][number];
}

/**
 * pipeline.script — writes (or partially rewrites) the master creative.
 *   FULL / SCRIPT / ENTIRE → full script
 *   HOOK                   → new hook only (assets reused, final render pass only)
 *   CAPTION                → platform captions only
 */
export async function scriptHandler(exec: JobExecution) {
  const { ctx } = exec;
  const projectId = payloadString(exec, "projectId");
  const scope = typeof exec.payload.scope === "string" ? exec.payload.scope : "FULL";
  const project = await ctx.prisma.contentProject.findUniqueOrThrow({
    where: { id: projectId },
    include: { brand: true, product: true, approvals: { orderBy: { createdAt: "desc" }, take: 3 } },
  });
  if (project.status !== "SCRIPTING") return { skipped: true, status: project.status };
  if (!project.product) throw new FatalError("Content project has no product — nothing to script against");
  const now = ctx.clock.now();
  const brand = brandContext(project.brand);
  const product = productContext(project.product, now);
  const scopeKey = { workspaceId: project.workspaceId, brandId: project.brandId, projectId: project.id };
  const feedback =
    [
      typeof exec.payload.feedback === "string" ? exec.payload.feedback : null,
      ...project.approvals
        .filter((a) => a.decision === "REJECTED" || a.decision === "AUTO_REJECTED")
        .map((a) => [a.reasons.join(", "), a.note].filter(Boolean).join(": ")),
    ]
      .filter(Boolean)
      .join("\n") || null;
  const avoidHooks = await recentHooks(ctx.prisma, project.brandId, now, project.id);

  let script: StoredScript;
  if (scope === "HOOK" || scope === "CAPTION") {
    if (!project.script)
      throw new FatalError(`Cannot regenerate ${scope.toLowerCase()} before a script exists`);
    script = project.script as unknown as StoredScript;
  } else {
    const research = ResearchBriefOutput.safeParse(project.researchBrief);
    const run = await runPaidPrompt(
      exec,
      shortVideoScriptPrompt,
      {
        brand,
        product,
        idea: {
          title: project.title,
          angle: project.angle ?? "problem_solution",
          hook: scope === "FULL" ? project.hook : null,
        },
        research: research.success
          ? research.data
          : {
              positioning: project.title,
              keyBenefits: [],
              audiencePainPoints: [],
              objections: [],
              forbiddenClaims: [],
              complianceNotes: [],
            },
        targetDurationSec: Math.round(CONTENT_DEFAULTS.shortVideoTargetMs / 1000),
        performanceSummary: await performanceSummary(ctx.prisma, project.brandId),
        economicOutcome: project.economicOutcome,
        avoidHooks,
        feedback,
      },
      { ...scopeKey, opKey: `script:${project.id}:${project.revision}` },
    );
    script = { ...normalizeScript(run.data, CONTENT_DEFAULTS.shortVideoTargetMs) };
    await ctx.prisma.contentProject.update({
      where: { id: project.id },
      data: { scriptPromptVersionId: run.promptVersionId },
    });
  }

  if (scope === "HOOK") {
    const hooks = await runPaidPrompt(
      exec,
      hookVariantsPrompt,
      {
        brand,
        product,
        angle: project.angle ?? "problem_solution",
        currentHook: script.hook,
        count: 3,
        performanceSummary: await performanceSummary(ctx.prisma, project.brandId),
        avoidHooks: [...avoidHooks, ...script.hookVariants.map((h) => h.text)],
        feedback,
      },
      { ...scopeKey, opKey: `hooks:${project.id}:${project.revision}` },
    );
    const fresh =
      hooks.data.hooks.find(
        (h) =>
          maxSimilarity(h.text, [script.hook, ...avoidHooks]).score <
          CONTENT_DEFAULTS.duplicateHookSimilarity,
      ) ?? hooks.data.hooks[0]!;
    const beats = [...script.script];
    beats[0] = { ...beats[0]!, onScreenText: fresh.text, voiceover: `${fresh.text.replace(/\*/g, "")}.` };
    script = { ...script, hook: fresh.text, hookStyle: fresh.style, script: beats };
  }

  // Platform captions (cheap; re-run for every scope so captions follow the hook/script).
  const platforms = project.brand.targetPlatforms.filter(isSocialPlatform);
  if (platforms.length) {
    const caps = await runPaidPrompt(
      exec,
      platformCaptionsPrompt,
      {
        brand,
        product,
        hook: script.hook.replace(/\*/g, ""),
        cta: script.cta,
        masterCaption: script.caption,
        hashtags: script.hashtags,
        platforms: platforms.map((p) => ({
          platform: p,
          maxChars:
            Math.min(PLATFORM_LIMITS[p].captionMaxChars, CONTENT_DEFAULTS.captionMaxChars[p] ?? 2200) - 200,
          maxHashtags: CONTENT_DEFAULTS.maxHashtags[p] ?? 5,
          linkClickable: PLATFORM_LIMITS[p].linkClickable,
        })),
      },
      { ...scopeKey, opKey: `captions:${project.id}:${project.revision}` },
    );
    script = { ...script, platformCaptions: caps.data.variants };
  }

  const hasGenerated = script.visualPlan.some((v) => v.type === "generated_image" || v.type === "ai_video");
  await ctx.prisma.$transaction(async (tx) => {
    const existing = await tx.scene.findMany({ where: { projectId: project.id } });
    for (const [index, beat] of script.script.entries()) {
      const kind: SceneKind = SCENE_KINDS.has(beat.sceneKind) ? beat.sceneKind : "GENERIC";
      const visual = visualFor(script, index, kind);
      const data = {
        kind,
        durationMs: Math.round(beat.durationSec * 1000),
        onScreenText: beat.onScreenText,
        voiceoverText: beat.voiceover || null,
        visualType: visual.type,
        visualDescription: visual.description,
        imagePrompt: visual.imagePrompt ?? null,
        motion: visual.motion ?? null,
      };
      const current = existing.find((s) => s.index === index);
      if (current) await tx.scene.update({ where: { id: current.id }, data });
      else await tx.scene.create({ data: { projectId: project.id, index, ...data } });
    }
    await tx.scene.deleteMany({ where: { projectId: project.id, index: { gte: script.script.length } } });
    await transitionContent(tx, {
      projectId: project.id,
      from: "SCRIPTING",
      to: "ASSET_PLANNING",
      actor: "WORKER",
      reason: `script:${scope}`,
      data: {
        hook: script.hook,
        hookStyle: script.hookStyle,
        angle: project.angle ?? script.angle,
        cta: script.cta,
        ctaType: script.ctaType,
        caption: script.caption,
        hashtags: script.hashtags,
        script: toJson(script) as Prisma.InputJsonValue,
        visualPlan: toJson(script.visualPlan) as Prisma.InputJsonValue,
        commercialIntent: script.commercialIntent,
        confidence: script.confidence,
        targetDurationMs: Math.round(script.estimatedDuration * 1000),
        aiGenerated: hasGenerated,
      },
    });
    await enqueue(ctx, tx, {
      type: "pipeline.plan_assets",
      // hook/caption-only regenerations keep the production tier: no new spending the owner did not ask for
      payload: { projectId: project.id, keepTier: scope === "HOOK" || scope === "CAPTION" },
      idempotencyKey: idempotencyKey("plan", { projectId: project.id, revision: project.revision }),
      workspaceId: project.workspaceId,
      brandId: project.brandId,
      projectId: project.id,
      runId: exec.job.runId,
    });
  });
  return { scope, hook: script.hook, scenes: script.script.length, durationSec: script.estimatedDuration };
}
