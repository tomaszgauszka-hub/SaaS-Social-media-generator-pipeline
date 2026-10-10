import { z } from "zod";
import { Capability, HookStrategy, LocaleTag, PlatformId, QualityTier, SafeId } from "./ids.ts";

/** One production order: a product → a sales reel (+ localized and A/B variants). */
export const ReelJob = z.object({
  jobId: SafeId,
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
  /**
   * more platforms from the same master and audio (logo, text layout, captions and QA per platform) — one
   * Blender render, several distribution channels
   */
  extraPlatforms: z.array(PlatformId).max(3).default([]),
  /**
   * A/B arms: "copy" (default) re-hooks the arm-A plan — same master video, music and SFX, only the hook copy /
   * voice changes (≈ free); "full" asks the director again for each arm (new shots → new renders)
   */
  abMode: z.enum(["copy", "full"]).default("copy"),
  /** affiliate economics for the payback estimate (never shown in the reel) */
  economics: z
    .object({
      /** commission share of the sale price (0..1) */
      commissionRate: z.number().min(0).max(1).optional(),
      /** or a fixed commission per sale (USD) */
      commissionUsd: z.number().min(0).optional(),
    })
    .default({}),
});
export type ReelJob = z.infer<typeof ReelJob>;
export type ReelJobInput = z.input<typeof ReelJob>;
