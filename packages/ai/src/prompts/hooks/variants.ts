import type { HooksContext } from "../contexts.ts";
import { brandHeader, performanceText, productBlock, rulesBlock } from "../format.ts";
import { bullets, definePrompt } from "../registry.ts";
import { HookVariantsOutput } from "../schemas.ts";

export const hookVariantsPrompt = definePrompt<HooksContext, HookVariantsOutput>({
  key: "hooks.variants",
  version: 1,
  description: "Alternative scroll-stopping hooks (hook-only regeneration and A/B tests)",
  system: `You write scroll-stopping opening lines for short-form videos for "{{brandName}}" ({{niche}}).
A hook has at most 9 words, is concrete, and creates curiosity or names a real problem. No clickbait that the video does not pay off.

Brand voice: {{tone}}
Audience: {{audience}}

{{rules}}`,
  template: `Write {{count}} new hooks for this product and angle. Use a different hookStyle for each.
Wrap 1-2 key words in *asterisks* to highlight them on screen.

ANGLE: {{angle}}
CURRENT HOOK (to replace): {{currentHook}}

PRODUCT
{{product}}

PERFORMANCE LEARNINGS
{{performance}}

DO NOT REPEAT OR PARAPHRASE
{{avoid}}

REVIEWER FEEDBACK
{{feedback}}`,
  schemaName: "HookVariantsOutput",
  schema: HookVariantsOutput,
  temperature: 1,
  maxOutputTokens: 800,
  toVars: (ctx) => ({
    ...brandHeader(ctx.brand),
    rules: rulesBlock(ctx.brand),
    count: ctx.count,
    angle: ctx.angle,
    currentHook: ctx.currentHook,
    product: productBlock(ctx.product),
    performance: performanceText(ctx.performanceSummary),
    avoid: bullets([ctx.currentHook, ...ctx.avoidHooks].slice(0, 25)),
    feedback: ctx.feedback ?? "(none)",
  }),
});
