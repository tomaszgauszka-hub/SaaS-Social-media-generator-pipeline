import type { IdeasContext, ResearchContext } from "../contexts.ts";
import { brandHeader, productBlock, performanceText, rulesBlock } from "../format.ts";
import { bullets, definePrompt } from "../registry.ts";
import { IdeasOutput, ResearchBriefOutput } from "../schemas.ts";

export const ideasPrompt = definePrompt<IdeasContext, IdeasOutput>({
  key: "strategy.ideas",
  version: 1,
  description: "Propose monetizable short-form content ideas for a brand's products",
  system: `You are the head of content strategy for "{{brandName}}", a social media brand in the {{niche}} niche.
Your job is to propose content that creates a MEASURABLE economic outcome (affiliate click, lead, sale, sign-up) — not vanity engagement.

Brand voice: {{tone}}
Audience: {{audience}}
Monetization: {{monetization}}

{{rules}}`,
  template: `Propose {{count}} content ideas for the products below.
Prefer ideas with strong purchase intent (specific problems the product solves, "before you buy", comparisons, spec breakdowns) over generic education or motivation.
Spread the ideas across products and angles. Each idea targets exactly one product (productId must be one of the ids below).

PRODUCTS
{{products}}

PERFORMANCE LEARNINGS (from our own analytics)
{{performance}}

AVOID REPEATING THESE RECENT TITLES / HOOKS
{{avoid}}

Allowed formats: {{formats}}

For every idea rate hookStrength (1-10: will it stop the scroll in 2 seconds?) and purchaseIntent (1-10: how close is the viewer to buying after watching?) and give an honest confidence (0-1). Put compliance or claim risks in riskNotes.`,
  schemaName: "IdeasOutput",
  schema: IdeasOutput,
  temperature: 0.9,
  maxOutputTokens: 2500,
  toVars: (ctx) => ({
    ...brandHeader(ctx.brand),
    rules: rulesBlock(ctx.brand),
    count: ctx.count,
    products: ctx.products.map((p) => productBlock(p)).join("\n\n"),
    performance: performanceText(ctx.performanceSummary),
    avoid: bullets(ctx.avoidTitles.slice(0, 30)),
    formats: ctx.formats.join(", "),
  }),
});

export const researchPrompt = definePrompt<ResearchContext, ResearchBriefOutput>({
  key: "strategy.research",
  version: 1,
  description:
    "Turn sourced product facts into a creative brief (positioning, benefits, objections, forbidden claims)",
  system: `You are a meticulous product researcher preparing a creative brief for "{{brandName}}" ({{niche}}).
You only work from the sourced facts provided. Anything not in the facts is unknown.

Audience: {{audience}}

{{rules}}`,
  template: `Prepare a creative brief for this content idea.

IDEA
title: {{ideaTitle}}
angle: {{angle}}
working hook: {{ideaHook}}

PRODUCT
{{product}}

Instructions
- positioning: one or two sentences on why this product matters to the audience, grounded in the facts.
- keyBenefits: translate facts into audience benefits; every benefit must cite the factId it comes from.
- audiencePainPoints: real situations the audience recognises (no invented statistics).
- objections: likely objections and an honest answer (cite a factId or use null when facts do not answer it).
- forbiddenClaims: tempting claims we must NOT make because the facts do not support them.
- complianceNotes: anything the script writer must be careful about.`,
  schemaName: "ResearchBriefOutput",
  schema: ResearchBriefOutput,
  temperature: 0.4,
  maxOutputTokens: 1500,
  toVars: (ctx) => ({
    ...brandHeader(ctx.brand),
    rules: rulesBlock(ctx.brand, ctx.product.economicOutcome),
    ideaTitle: ctx.idea.title,
    angle: ctx.idea.angle,
    ideaHook: ctx.idea.hook ?? "(none yet)",
    product: productBlock(ctx.product),
  }),
});
