import { z } from "zod";
import {
  BlenderProfile,
  Capability,
  CaptionStyle,
  FactId,
  HexColor,
  HookStrategy,
  LightingPreset,
  LocaleTag,
  MusicGenre,
  MusicMood,
  PlatformId,
  ProductAnimation,
  SalesRole,
  SfxKind,
  ShotPreset,
  ShotTechnique,
  SlotId,
  StudioEnvironment,
  Transition,
} from "./ids.ts";

export const REEL_PLAN_VERSION = "reel-plan/1";

/* ================================================================== DirectorDecision ============= */
/*
 * The SMALL structured output a director (Gemini, or the deterministic template director) returns. It says
 * WHAT to do. The PlanCompiler turns it into a ReelPlan (absolute timing, whitelisted techniques, providers,
 * caps) — HOW it is done is decided by code, never by the model.
 */

const ShortText = (max: number) => z.string().trim().min(1).max(max);

export const ShotFocus = z.enum(["whole", "top", "middle", "base", "detail"]);
export type ShotFocus = z.infer<typeof ShotFocus>;

export const DirectorShot = z.object({
  role: SalesRole,
  preset: ShotPreset,
  seconds: z.number().min(0.8).max(6),
  productAnimation: ProductAnimation.default("none"),
  focus: ShotFocus.default("whole"),
  /** on-screen text for this shot (master locale), optional */
  overlay: z.object({ text: ShortText(60), factIds: z.array(FactId).max(4).default([]) }).optional(),
  transition: Transition.default("cut"),
});
export type DirectorShot = z.infer<typeof DirectorShot>;

export const DirectorDecision = z.object({
  objective: z.enum(["conversion", "consideration", "awareness"]).default("conversion"),
  durationS: z.number().min(6).max(30),
  targetAudience: ShortText(140),
  hook: z.object({
    strategy: HookStrategy,
    text: ShortText(70),
    factIds: z.array(FactId).max(4).default([]),
  }),
  visualStyle: z.object({
    environment: StudioEnvironment,
    energy: z.number().min(0).max(1),
    lighting: LightingPreset.default("three_point"),
  }),
  shots: z.array(DirectorShot).min(3).max(6),
  voiceover: z.object({
    enabled: z.boolean(),
    lines: z
      .array(z.object({ role: SalesRole, text: ShortText(140), factIds: z.array(FactId).max(4).default([]) }))
      .max(6)
      .default([]),
    pace: z.number().min(0.8).max(1.25).default(1),
  }),
  music: z.object({
    genre: MusicGenre,
    mood: MusicMood,
    bpm: z.number().int().min(70).max(150),
    energyCurve: z
      .array(z.object({ atS: z.number().min(0).max(30), energy: z.number().min(0).max(1) }))
      .min(1)
      .max(8),
    finalHitAtS: z.number().min(0).max(30).optional(),
  }),
  sfx: z
    .array(
      z.object({
        shotIndex: z.number().int().min(0).max(5),
        kind: SfxKind,
        at: z.enum(["start", "mid", "end"]).default("start"),
      }),
    )
    .max(12)
    .default([]),
  captions: z.object({ style: CaptionStyle.default("word_highlight") }).default({ style: "word_highlight" }),
  cta: z.object({
    text: ShortText(48),
    buttonText: ShortText(24),
    factIds: z.array(FactId).max(3).default([]),
  }),
});
export type DirectorDecision = z.infer<typeof DirectorDecision>;
export type DirectorDecisionInput = z.input<typeof DirectorDecision>;

/* ================================================================== LocaleCopy =================== */

export const CopySlotKind = z.enum(["hook", "voice", "overlay", "cta", "button", "disclosure", "caption"]);
export type CopySlotKind = z.infer<typeof CopySlotKind>;

export const CopySlot = z.object({
  kind: CopySlotKind,
  text: z.string().min(1).max(200),
  /** facts this text relies on (empty for purely emotional lines) */
  factIds: z.array(FactId).max(6).default([]),
});
export type CopySlot = z.infer<typeof CopySlot>;

/** Every word a viewer reads or hears, for one locale. Visual specs reference slots by id only. */
export const LocaleCopy = z.object({
  locale: LocaleTag,
  market: z.string().length(2),
  slots: z.record(SlotId, CopySlot),
  transcreation: z.object({
    provider: z.string(),
    model: z.string(),
    sourceLocale: LocaleTag,
    /** true when this copy is the master (not a localization) */
    isMaster: z.boolean(),
  }),
});
export type LocaleCopy = z.infer<typeof LocaleCopy>;

/* ================================================================== ReelPlan ===================== */

export const ShotParams = z.object({
  /** 0..1 how strong the move is */
  intensity: z.number().min(0).max(1).default(0.5),
  /** camera azimuth around the product (deg) */
  angleDeg: z.number().min(-180).max(180).default(-25),
  /** camera height relative to the product height (0 = floor, 1 = top) */
  height: z.number().min(-0.2).max(1.6).default(0.55),
  focus: ShotFocus.default("whole"),
  /** framing: product height as a share of the frame height */
  fill: z.number().min(0.25).max(2.5).default(0.62),
  /** orbit / turntable sweep (deg) */
  sweepDeg: z.number().min(0).max(360).default(40),
});
export type ShotParams = z.infer<typeof ShotParams>;

export const PlanShot = z.object({
  id: z.string().regex(/^sh\d{2}$/),
  role: SalesRole,
  startMs: z.number().int().min(0),
  durationMs: z.number().int().min(500).max(8000),
  preset: ShotPreset,
  technique: ShotTechnique,
  environment: StudioEnvironment,
  lighting: LightingPreset,
  params: ShotParams,
  productAnimation: ProductAnimation,
  transitionIn: z.object({ type: Transition, ms: z.number().int().min(0).max(800) }),
  /** where the pixels come from */
  source: z.enum(["blender", "existing_asset", "product_photo", "ai_image", "generative_video"]),
  /** retriever asset id when `source` reuses an asset (never a path) */
  assetRef: z.string().max(200).optional(),
  /** on-screen text slot for this shot (locale pass) */
  overlaySlot: SlotId.optional(),
  /** filled when the decision engine allows generative video for this shot */
  generativeVideo: z
    .object({
      reason: z.string().max(300),
      seconds: z.number().min(0).max(10),
      estimatedCostUsd: z.number().min(0),
    })
    .optional(),
});
export type PlanShot = z.infer<typeof PlanShot>;

export const MusicEvent = z.object({
  timeMs: z.number().int().min(0),
  energy: z.number().min(0).max(1).optional(),
  event: z.enum(["final_hit", "drop", "riser", "stop"]).optional(),
});
export type MusicEvent = z.infer<typeof MusicEvent>;

export const MusicIntent = z.object({
  genre: MusicGenre,
  mood: MusicMood,
  bpm: z.number().int().min(60).max(180),
  energy: z.number().min(0).max(1),
  instrumental: z.literal(true).default(true),
  durationMs: z.number().int().min(1000).max(120_000),
  brandFeel: z.string().max(120).default(""),
  events: z.array(MusicEvent).max(16).default([]),
  seed: z.string().max(80),
});
export type MusicIntent = z.infer<typeof MusicIntent>;

export const DuckingParams = z.object({
  enabled: z.boolean().default(true),
  /** music level reduction under the voice (dB) */
  depthDb: z.number().min(0).max(30).default(10),
  attackMs: z.number().int().min(5).max(1000).default(80),
  releaseMs: z.number().int().min(20).max(3000).default(350),
});
export type DuckingParams = z.infer<typeof DuckingParams>;

export const ReelPlan = z.object({
  version: z.literal(REEL_PLAN_VERSION),
  metadata: z.object({
    planId: z.string(),
    jobId: z.string(),
    variantKey: z.string().max(16).default("A"),
    configVersion: z.string(),
    seed: z.string(),
    hookStrategy: HookStrategy,
    director: z.object({
      provider: z.string(),
      model: z.string(),
      promptVersion: z.string(),
      fallbackUsed: z.boolean(),
    }),
  }),
  product: z.object({
    id: z.string(),
    name: z.string(),
    brand: z.string(),
    /** facts any copy in this plan may rely on */
    factIds: z.array(FactId),
    model3dSha: z.string().optional(),
  }),
  masterLocale: LocaleTag,
  language: LocaleTag,
  market: z.string().length(2),
  platform: PlatformId,
  durationMs: z.number().int().min(5000).max(60_000),
  resolution: z.object({ width: z.number().int(), height: z.number().int() }),
  fps: z.number().int().min(24).max(60),
  objective: z.enum(["conversion", "consideration", "awareness"]),
  targetAudience: z.string().max(140),
  /** sales structure over time */
  structure: z.array(z.object({ role: SalesRole, startMs: z.number().int(), endMs: z.number().int() })),
  visual_style: z.object({
    environment: StudioEnvironment,
    energy: z.number().min(0).max(1),
    lighting: LightingPreset,
    palette: z.object({ primary: HexColor, accent: HexColor, text: HexColor }),
  }),
  camera: z.object({
    lensMm: z.number().min(18).max(200).default(65),
    dof: z.object({ enabled: z.boolean(), fStop: z.number().min(0.95).max(22) }),
    motionBlur: z.boolean(),
  }),
  product_animation: z.object({ default: ProductAnimation }),
  shots: z.array(PlanShot).min(1).max(8),
  voiceover: z.object({
    enabled: z.boolean(),
    personaId: z.string(),
    pace: z.number().min(0.7).max(1.4),
    style: z.string().max(200),
    /** slots in speaking order with the time they should start (ms) */
    segments: z.array(z.object({ slot: SlotId, atMs: z.number().int().min(0) })).max(8),
  }),
  music: z.object({
    intent: MusicIntent,
    gainDb: z.number().min(-40).max(0).default(-12),
    ducking: DuckingParams,
  }),
  sfx: z
    .array(z.object({ atMs: z.number().int().min(0), kind: SfxKind, gainDb: z.number().min(-40).max(6) }))
    .max(24),
  captions: z.object({
    enabled: z.boolean(),
    style: CaptionStyle,
    /** captions follow the voice-over (word timings) or the on-screen overlays */
    source: z.enum(["voiceover", "overlay"]),
    maxWordsPerPhrase: z.number().int().min(1).max(8),
    /** vertical shift of the platform caption band (QA retry "reposition_captions") */
    offsetYPx: z.number().int().min(-400).max(400).optional(),
  }),
  cta: z.object({
    slot: SlotId,
    buttonSlot: SlotId,
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    style: z.enum(["button", "lower_third", "end_card"]),
  }),
  branding: z.object({
    logo: z.object({
      enabled: z.boolean(),
      position: z.enum(["top_left", "top_right", "bottom_right", "end_card"]),
      startMs: z.number().int(),
      endMs: z.number().int(),
    }),
    disclosureSlot: SlotId.optional(),
    brandName: z.string(),
  }),
  render_profile: z.object({
    blender: BlenderProfile,
    encode: z.object({
      crf: z.number().int().min(12).max(30),
      preset: z.enum(["veryfast", "fast", "medium", "slow"]),
    }),
    audio: z.object({ sampleRate: z.literal(48_000), lufs: z.number(), truePeakDb: z.number() }),
  }),
  /** provider planned per capability (the chain head) */
  providers: z.partialRecord(Capability, z.string()),
  /** ordered fallback chain per capability */
  fallbacks: z.partialRecord(Capability, z.array(z.string())),
  budget: z.object({ maxApiCostUsd: z.number().min(0), estimatedApiCostUsd: z.number().min(0) }),
  copy: LocaleCopy,
});
export type ReelPlan = z.infer<typeof ReelPlan>;
export type ReelPlanInput = z.input<typeof ReelPlan>;
