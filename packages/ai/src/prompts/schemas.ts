import { z } from "zod";

/**
 * Structured output contracts for every LLM call. Application state is only ever derived from these
 * validated objects — never from free-form prose.
 */

export const HookStyle = z.enum([
  "problem_solution",
  "question",
  "bold_claim",
  "number_list",
  "comparison",
  "myth_busting",
  "pov",
  "deal_alert",
  "how_to",
  "mistake_warning",
  "curiosity_gap",
]);
export type HookStyle = z.infer<typeof HookStyle>;

export const ContentAngle = z.enum([
  "problem_solution",
  "comparison",
  "top_benefits",
  "myth_busting",
  "before_you_buy",
  "deal_alert",
  "how_to_use",
  "mistakes_to_avoid",
  "use_case",
  "spec_breakdown",
]);
export type ContentAngle = z.infer<typeof ContentAngle>;

export const CtaType = z.enum([
  "link_in_bio",
  "comment_keyword",
  "save_post",
  "visit_link",
  "dm_keyword",
  "follow",
]);
export type CtaType = z.infer<typeof CtaType>;

export const ScriptSceneKind = z.enum([
  "HOOK",
  "PROBLEM",
  "PRODUCT",
  "AI_SHOT",
  "DEMO",
  "BENEFITS",
  "COMPARISON",
  "OFFER",
  "CTA",
]);

export const VisualType = z.enum(["product_image", "generated_image", "ai_video", "text_card", "screenshot"]);

export const EconomicOutcomeOut = z.enum([
  "AFFILIATE_CLICK",
  "LEAD",
  "SALE",
  "SERVICE_INQUIRY",
  "EMAIL_SIGNUP",
]);

/* ------------------------------------------------------------------ strategy.ideas -------------- */

export const IdeaOut = z.object({
  productId: z.string().min(1),
  title: z.string().min(4).max(140),
  angle: ContentAngle,
  format: z.enum(["SHORT_VIDEO", "STATIC_POST", "CAROUSEL"]),
  economicOutcome: EconomicOutcomeOut,
  hook: z.string().min(4).max(140),
  targetAudience: z.string().max(240),
  whyItConverts: z.string().max(400),
  riskNotes: z.string().max(400).default(""),
  hookStrength: z.number().int().min(1).max(10),
  purchaseIntent: z.number().int().min(1).max(10),
  confidence: z.number().min(0).max(1),
});
export type IdeaOut = z.infer<typeof IdeaOut>;

export const IdeasOutput = z.object({ ideas: z.array(IdeaOut).min(1).max(12) });
export type IdeasOutput = z.infer<typeof IdeasOutput>;

/* ------------------------------------------------------------------ research.brief ------------ */

export const ResearchBriefOutput = z.object({
  positioning: z.string().min(10).max(400),
  keyBenefits: z
    .array(z.object({ benefit: z.string().max(160), factId: z.string() }))
    .min(1)
    .max(6),
  audiencePainPoints: z.array(z.string().max(160)).max(6),
  objections: z
    .array(
      z.object({
        objection: z.string().max(160),
        answer: z.string().max(240),
        factId: z.string().nullable(),
      }),
    )
    .max(5),
  forbiddenClaims: z.array(z.string().max(160)).max(10),
  complianceNotes: z.array(z.string().max(240)).max(6),
});
export type ResearchBriefOutput = z.infer<typeof ResearchBriefOutput>;

/* ------------------------------------------------------------------ script.short_video -------- */

export const ScriptBeat = z.object({
  sceneKind: ScriptSceneKind,
  durationSec: z.number().min(1.5).max(12),
  onScreenText: z.string().max(160),
  voiceover: z.string().max(450).default(""),
  bullets: z.array(z.string().max(80)).max(4).optional(),
});
export type ScriptBeat = z.infer<typeof ScriptBeat>;

export const VisualPlanItem = z.object({
  sceneIndex: z.number().int().min(0),
  type: VisualType,
  description: z.string().max(400),
  imagePrompt: z.string().max(700).optional(),
  motion: z
    .enum(["static", "zoom_in", "zoom_out", "kenburns", "pan_left", "pan_right", "pan_up", "pan_down"])
    .optional(),
});
export type VisualPlanItem = z.infer<typeof VisualPlanItem>;

export const HookVariant = z.object({ text: z.string().min(4).max(140), style: HookStyle });

export const ScriptOutput = z.object({
  hook: z.string().min(4).max(140),
  hookStyle: HookStyle,
  angle: z.string().max(240),
  targetAudience: z.string().max(240),
  script: z.array(ScriptBeat).min(3).max(9),
  visualPlan: z.array(VisualPlanItem).min(1).max(9),
  cta: z.string().min(2).max(90),
  ctaType: CtaType,
  caption: z.string().min(10).max(1800),
  hashtags: z.array(z.string().max(40)).max(10),
  estimatedDuration: z.number().min(8).max(90),
  commercialIntent: z.string().max(240),
  confidence: z.number().min(0).max(1),
  /** ids of product facts the script relies on */
  claimsUsed: z.array(z.string()).default([]),
  hookVariants: z.array(HookVariant).max(4).default([]),
});
export type ScriptOutput = z.infer<typeof ScriptOutput>;

/* ------------------------------------------------------------------ hooks.variants ------------- */

export const HookVariantsOutput = z.object({
  hooks: z
    .array(z.object({ text: z.string().min(4).max(140), style: HookStyle, rationale: z.string().max(240) }))
    .min(1)
    .max(5),
});
export type HookVariantsOutput = z.infer<typeof HookVariantsOutput>;

/* ------------------------------------------------------------------ caption.platform ----------- */

export const PlatformCaptionsOutput = z.object({
  variants: z
    .array(
      z.object({
        platform: z.enum(["INSTAGRAM", "FACEBOOK", "TIKTOK"]),
        caption: z.string().min(10).max(2100),
        hashtags: z.array(z.string().max(40)).max(8),
        firstComment: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(3),
});
export type PlatformCaptionsOutput = z.infer<typeof PlatformCaptionsOutput>;

/* ------------------------------------------------------------------ qa.text_review ------------- */

export const QaReviewOutput = z.object({
  issues: z
    .array(
      z.object({
        type: z.enum([
          "spelling",
          "grammar",
          "unsupported_claim",
          "contradiction",
          "tone",
          "compliance",
          "clarity",
        ]),
        severity: z.enum(["blocker", "major", "minor"]),
        excerpt: z.string().max(240),
        explanation: z.string().max(400),
        suggestion: z.string().max(400).optional(),
      }),
    )
    .max(20),
  overallAssessment: z.string().max(500),
  score: z.number().min(0).max(100),
});
export type QaReviewOutput = z.infer<typeof QaReviewOutput>;

/* ------------------------------------------------------------------ generic classify / score --- */

export const ClassificationOutput = z.object({ label: z.string(), confidence: z.number().min(0).max(1) });
export const ScoreOutput = z.object({ score: z.number().min(0).max(100), rationale: z.string().max(500) });
