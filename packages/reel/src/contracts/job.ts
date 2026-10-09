import { z } from "zod";
import { Capability, HookStrategy, LocaleTag, PlatformId, QualityTier } from "./ids.ts";

/** One production order: a product → a sales reel (+ localized and A/B variants). */
export const ReelJob = z.object({
  jobId: z.string().min(1).max(120),
  productId: z.string().min(1),
  brandId: z.string().min(1),
  platform: PlatformId.default("tiktok"),
  /** master locale first; the rest are localizations that reuse the master video */
  locales: z
    .array(z.object({ locale: LocaleTag, market: z.string().length(2) }))
    .min(1)
    .max(24),
  targetDurationS: z.number().min(6).max(30).default(12),
  tier: QualityTier.default("STANDARD"),
  /** hard API budget for the whole job (all variants), USD; default comes from the tier */
  maxApiCost: z.number().min(0).max(50).optional(),
  objective: z.enum(["conversion", "consideration", "awareness"]).default("conversion"),
  /** A/B: one variant per hook strategy (variant A = director's choice when omitted) */
  abHooks: z.array(HookStrategy).max(4).default([]),
  seed: z.string().max(80).default("1"),
  /** capability → provider names to force (testing, ops overrides); still validated against the registry */
  forceProviders: z.partialRecord(Capability, z.string()).default({}),
  /** opt-in only: allow generative video for special shots (still capped by tier + budget) */
  allowGenerativeVideo: z.boolean().default(false),
});
export type ReelJob = z.infer<typeof ReelJob>;
export type ReelJobInput = z.input<typeof ReelJob>;
