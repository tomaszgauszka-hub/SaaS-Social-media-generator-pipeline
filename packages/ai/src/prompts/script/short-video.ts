import type { ScriptContext } from "../contexts.ts";
import { brandHeader, briefBlock, performanceText, productBlock, rulesBlock } from "../format.ts";
import { bullets, definePrompt } from "../registry.ts";
import { ScriptOutput } from "../schemas.ts";

export const shortVideoScriptPrompt = definePrompt<ScriptContext, ScriptOutput>({
  key: "script.short_video",
  version: 1,
  description: "Structured 20-40 s vertical video script + visual plan + caption + hook variants",
  system: `You are an expert short-form video scriptwriter (TikTok, Instagram Reels, Facebook Reels) for "{{brandName}}".
Your scripts are rendered AUTOMATICALLY from the JSON you return: every field is consumed by a rendering engine, so be precise.

Brand voice: {{tone}}
Audience: {{audience}}
CTA styles we use: {{ctaStyles}}

{{rules}}`,
  template: `Write a {{duration}}-second vertical video script for this idea.

IDEA
title: {{ideaTitle}}
angle: {{angle}}
starting hook (improve it if you can): {{ideaHook}}

PRODUCT
{{product}}

CREATIVE BRIEF
{{brief}}

PERFORMANCE LEARNINGS
{{performance}}

HOOKS ALREADY USED RECENTLY (do not repeat or paraphrase)
{{avoidHooks}}

REVIEWER FEEDBACK TO ADDRESS
{{feedback}}

STRUCTURE
- Scene 1 is HOOK (2-3 s): on-screen text of at most 7 words that stops the scroll. Wrap 1-2 key words in *asterisks* to highlight them.
- Then 3-6 scenes chosen from PROBLEM, PRODUCT, AI_SHOT, DEMO, BENEFITS, COMPARISON, OFFER to fit the angle. BENEFITS scenes include 2-4 bullets (at most 8 words each) that restate product facts.
- The last scene is CTA (3-4 s) using one of our CTA styles.
- Total duration {{minDuration}}-{{maxDuration}} seconds. On-screen text: at most 12 words per scene. Voice-over must fit its scene (about 2.5 words per second).
- visualPlan: exactly one entry per scene (sceneIndex = scene position, starting at 0). type is one of: product_image (the real product photo), generated_image (a photographic scene WITHOUT the product, logos or any text — we composite the real product ourselves), ai_video (at most ONE optional 3-5 s shot), text_card, screenshot. Provide imagePrompt only for generated_image and ai_video: vertical 9:16 photographic description, no text, no logos, no packaging.
- caption: 2-4 short paragraphs, opens with the hook idea, uses only sourced facts, ends with the CTA. Do NOT write the advertising disclosure — it is added automatically.
- hashtags: 3-6 relevant hashtags.
- hookVariants: 3 alternative hooks using different hookStyle values (for A/B tests).
- claimsUsed: the fact ids the script relies on.`,
  schemaName: "ScriptOutput",
  schema: ScriptOutput,
  temperature: 0.8,
  maxOutputTokens: 3000,
  toVars: (ctx) => ({
    ...brandHeader(ctx.brand),
    rules: rulesBlock(ctx.brand, ctx.economicOutcome),
    duration: ctx.targetDurationSec,
    minDuration: Math.max(15, ctx.targetDurationSec - 7),
    maxDuration: Math.min(45, ctx.targetDurationSec + 8),
    ideaTitle: ctx.idea.title,
    angle: ctx.idea.angle,
    ideaHook: ctx.idea.hook ?? "(write a new one)",
    product: productBlock(ctx.product),
    brief: briefBlock(ctx.research),
    performance: performanceText(ctx.performanceSummary),
    avoidHooks: bullets(ctx.avoidHooks.slice(0, 25)),
    feedback: ctx.feedback ?? "(none)",
  }),
});
