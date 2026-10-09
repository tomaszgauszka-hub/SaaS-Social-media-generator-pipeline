import { z } from "zod";
import { CostBreakdown } from "./cost.ts";
import { BlenderProfile, Capability, HookStrategy, LocaleTag, PlatformId, QualityTier } from "./ids.ts";

/** A capability that did not use its first-choice provider, and why. */
export const FallbackRecord = z.object({
  capability: Capability,
  wanted: z.string(),
  used: z.string(),
  reason: z.string().max(400),
});
export type FallbackRecord = z.infer<typeof FallbackRecord>;

export const QaIssue = z.object({
  code: z.string().max(60),
  severity: z.enum(["blocker", "major", "minor"]),
  message: z.string().max(400),
  atMs: z.number().int().optional(),
  /** a deterministic fix the factory can apply (e.g. "reframe:sh02", "reposition_captions", "renormalize") */
  fix: z.string().max(80).optional(),
});
export type QaIssue = z.infer<typeof QaIssue>;

export const QaReport = z.object({
  score: z.number().min(0).max(100),
  passed: z.boolean(),
  rerenderRequired: z.boolean(),
  checks: z.array(
    z.object({
      id: z.string(),
      passed: z.boolean(),
      value: z.unknown().optional(),
      note: z.string().max(400).optional(),
    }),
  ),
  issues: z.array(QaIssue),
  /** representative frames analysed (10/30/50/70/90 %) */
  frames: z.array(z.object({ atMs: z.number().int(), path: z.string() })),
  visualQa: z
    .object({
      provider: z.string(),
      model: z.string(),
      score: z.number(),
      issues: z.array(z.string()),
      rerenderRequired: z.boolean(),
    })
    .optional(),
  retries: z.array(z.object({ attempt: z.number().int(), fixes: z.array(z.string()) })).default([]),
});
export type QaReport = z.infer<typeof QaReport>;

/** Everything needed to audit, reproduce and learn from one delivered reel. */
export const ReelManifest = z.object({
  manifestVersion: z.literal("reel-manifest/1"),
  jobId: z.string(),
  variantId: z.string(),
  variantKey: z.string(),
  productId: z.string(),
  brandId: z.string(),
  language: LocaleTag,
  market: z.string(),
  platform: PlatformId,
  tier: QualityTier,
  hookStrategy: HookStrategy,
  providers: z.object({
    director: z.string(),
    directorModel: z.string(),
    productAnalysis: z.string(),
    transcreation: z.string(),
    imageProvider: z.string(),
    musicProvider: z.string(),
    voiceProvider: z.string(),
    sfxProvider: z.string(),
    transcriptionProvider: z.string(),
    videoProvider: z.string(),
    visualQa: z.string(),
  }),
  blenderProfile: BlenderProfile,
  shots: z.array(
    z.object({
      id: z.string(),
      preset: z.string(),
      technique: z.string(),
      source: z.string(),
      durationMs: z.number().int(),
      cacheHit: z.boolean(),
      renderMs: z.number().int(),
    }),
  ),
  durationMs: z.number().int(),
  /** wall time per stage */
  timings: z.record(z.string(), z.number().int()),
  renderTimeMs: z.number().int(),
  tokens: z.object({ input: z.number().int(), output: z.number().int() }),
  cost: CostBreakdown,
  totalApiCostUsd: z.number(),
  fallbacks: z.array(FallbackRecord),
  generativeVideo: z.array(
    z.object({
      shotId: z.string(),
      used: z.boolean(),
      reason: z.string(),
      seconds: z.number(),
      costUsd: z.number(),
    }),
  ),
  /** the master video this variant reuses (multilingual / A/B) */
  masterVideo: z.object({ path: z.string(), visualHash: z.string(), reused: z.boolean() }),
  qa: QaReport,
  output: z.object({
    video: z.string(),
    poster: z.string(),
    plan: z.string(),
    captions: z.string().optional(),
  }),
  seed: z.string(),
  configVersion: z.string(),
  createdAt: z.string(),
  /** product source licence / attribution carried into the delivery */
  attribution: z.string().optional(),
});
export type ReelManifest = z.infer<typeof ReelManifest>;

/** Performance of a published reel — stored later, analysed per hook / shot / voice / music / CTA. */
export const ReelOutcome = z.object({
  variantId: z.string(),
  platform: PlatformId,
  collectedAt: z.string(),
  views: z.number().int().min(0).optional(),
  watchTimeMs: z.number().int().min(0).optional(),
  completionRate: z.number().min(0).max(1).optional(),
  ctr: z.number().min(0).max(1).optional(),
  conversions: z.number().int().min(0).optional(),
  sales: z.number().int().min(0).optional(),
  revenueMicros: z.number().int().min(0).optional(),
  likes: z.number().int().min(0).optional(),
  comments: z.number().int().min(0).optional(),
  shares: z.number().int().min(0).optional(),
});
export type ReelOutcome = z.infer<typeof ReelOutcome>;
