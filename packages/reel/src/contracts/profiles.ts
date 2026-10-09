import { z } from "zod";
import {
  BlenderProfile,
  CaptionStyle,
  HexColor,
  LocaleTag,
  MusicGenre,
  MusicMood,
  PlatformId,
  QualityTier,
  StudioEnvironment,
} from "./ids.ts";

/* ================================================================== BrandProfile ================= */

/** A brand's voice: the same persona across reels, mapped to concrete voices per provider and language. */
export const VoicePersona = z.object({
  id: z.string().min(1).max(60),
  description: z.string().max(300),
  /** natural-language delivery direction for TTS models that accept style prompts */
  style: z.string().max(200).default("warm, confident, conversational commercial read"),
  pace: z.number().min(0.7).max(1.4).default(1),
  gender: z.enum(["female", "male", "neutral"]).default("neutral"),
  /** provider → locale (or "*") → voice name */
  voices: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
export type VoicePersona = z.infer<typeof VoicePersona>;

export const FontRef = z.object({
  family: z.string().max(80),
  /** absolute or repo-relative path to a TTF/OTF/WOFF2 file the composer can hand to libass */
  file: z.string(),
  weight: z.number().int().min(100).max(900).default(700),
});
export type FontRef = z.infer<typeof FontRef>;

export const BrandProfile = z.object({
  brandId: z.string().min(1).max(80),
  brandName: z.string().min(1).max(80),
  logo: z
    .object({
      /** PNG with alpha */
      path: z.string(),
      position: z.enum(["top_left", "top_right", "bottom_right", "end_card"]).default("top_right"),
      widthPx: z.number().int().min(60).max(600).default(200),
    })
    .optional(),
  colors: z.object({
    primary: HexColor,
    secondary: HexColor,
    accent: HexColor,
    text: HexColor,
    background: HexColor,
  }),
  fonts: z.object({ display: FontRef, body: FontRef, captions: FontRef }),
  voicePersona: VoicePersona,
  captionStyle: z.object({
    preset: CaptionStyle.default("word_highlight"),
    highlightColor: HexColor.optional(),
    uppercase: z.boolean().default(false),
    maxWordsPerPhrase: z.number().int().min(1).max(8).default(4),
  }),
  musicStyle: z.object({
    genres: z.array(MusicGenre).min(1).max(4),
    moods: z.array(MusicMood).min(1).max(4),
    bpm: z.tuple([z.number().int().min(60), z.number().int().max(180)]).default([90, 128]),
  }),
  /** locale → preferred CTA lines (the director picks / adapts; never invents offers) */
  preferredCTA: z.record(z.string(), z.array(z.string().max(60)).max(6)).default({}),
  forbiddenPhrases: z.array(z.string().max(80)).max(200).default([]),
  visualStyle: z.object({
    environment: StudioEnvironment.default("dark_premium"),
    energy: z.number().min(0).max(1).default(0.6),
  }),
  targetMarkets: z
    .array(z.object({ market: z.string().length(2), locale: LocaleTag }))
    .min(1)
    .max(40),
  /** locale → disclosure line burned into every reel of this brand (affiliate / ad) */
  disclosure: z.record(z.string(), z.string().max(80)).default({}),
});
export type BrandProfile = z.infer<typeof BrandProfile>;

/* ================================================================== PlatformProfile ============== */

export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Rect = z.infer<typeof Rect>;

export const PlatformProfile = z.object({
  id: PlatformId,
  displayName: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number().int(),
  durationMs: z.object({ min: z.number().int(), ideal: z.number().int(), max: z.number().int() }),
  /** areas covered by the platform UI (no captions / CTA / logo there) */
  unsafe: z.array(z.object({ name: z.string(), rect: Rect })),
  /** caption band (centre line y and max height) */
  captions: z.object({ centerY: z.number(), maxHeight: z.number(), maxCharsPerLine: z.number().int() }),
  /** max overlay words on screen at once */
  maxOverlayWords: z.number().int(),
  cta: z.object({ style: z.enum(["button", "lower_third", "end_card"]), minMs: z.number().int() }),
  /** typical shot length (pacing) */
  avgShotMs: z.number().int(),
  loudness: z.object({ lufs: z.number(), truePeakDb: z.number() }),
  maxFileMb: z.number(),
});
export type PlatformProfile = z.infer<typeof PlatformProfile>;

const W = 1080;
const H = 1920;
const r = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/** Static platform specs (no DB table: they change with the platforms' UI, not per brand). */
export const PLATFORM_PROFILES: Record<PlatformId, PlatformProfile> = {
  tiktok: {
    id: "tiktok",
    displayName: "TikTok",
    width: W,
    height: H,
    fps: 30,
    durationMs: { min: 7_000, ideal: 13_000, max: 60_000 },
    unsafe: [
      { name: "top bar", rect: r(0, 0, W, 150) },
      { name: "action rail", rect: r(940, 760, 140, 900) },
      { name: "caption / music", rect: r(0, 1560, W, 360) },
    ],
    captions: { centerY: 1180, maxHeight: 260, maxCharsPerLine: 22 },
    maxOverlayWords: 7,
    cta: { style: "button", minMs: 1800 },
    avgShotMs: 2200,
    loudness: { lufs: -14, truePeakDb: -1.5 },
    maxFileMb: 287,
  },
  instagram_reels: {
    id: "instagram_reels",
    displayName: "Instagram Reels",
    width: W,
    height: H,
    fps: 30,
    durationMs: { min: 5_000, ideal: 12_000, max: 90_000 },
    unsafe: [
      { name: "top bar", rect: r(0, 0, W, 220) },
      { name: "action rail", rect: r(950, 900, 130, 760) },
      { name: "caption", rect: r(0, 1600, W, 320) },
    ],
    captions: { centerY: 1160, maxHeight: 260, maxCharsPerLine: 22 },
    maxOverlayWords: 7,
    cta: { style: "button", minMs: 1800 },
    avgShotMs: 2400,
    loudness: { lufs: -14, truePeakDb: -1.5 },
    maxFileMb: 250,
  },
  youtube_shorts: {
    id: "youtube_shorts",
    displayName: "YouTube Shorts",
    width: W,
    height: H,
    fps: 30,
    durationMs: { min: 5_000, ideal: 15_000, max: 60_000 },
    unsafe: [
      { name: "top bar", rect: r(0, 0, W, 140) },
      { name: "action rail", rect: r(930, 880, 150, 820) },
      { name: "title / channel", rect: r(0, 1500, W, 420) },
    ],
    captions: { centerY: 1120, maxHeight: 240, maxCharsPerLine: 22 },
    maxOverlayWords: 8,
    cta: { style: "end_card", minMs: 2000 },
    avgShotMs: 2600,
    loudness: { lufs: -14, truePeakDb: -1.5 },
    maxFileMb: 256,
  },
  facebook_reels: {
    id: "facebook_reels",
    displayName: "Facebook Reels",
    width: W,
    height: H,
    fps: 30,
    durationMs: { min: 5_000, ideal: 14_000, max: 90_000 },
    unsafe: [
      { name: "top bar", rect: r(0, 0, W, 200) },
      { name: "action rail", rect: r(950, 900, 130, 760) },
      { name: "caption", rect: r(0, 1560, W, 360) },
    ],
    captions: { centerY: 1160, maxHeight: 260, maxCharsPerLine: 22 },
    maxOverlayWords: 7,
    cta: { style: "button", minMs: 1800 },
    avgShotMs: 2400,
    loudness: { lufs: -14, truePeakDb: -1.5 },
    maxFileMb: 250,
  },
};

/* ================================================================== Quality tiers ================ */

export const TierProfile = z.object({
  tier: QualityTier,
  /** template = deterministic director only; llm = Gemini director with template fallback */
  director: z.enum(["template", "llm"]),
  productAnalysis: z.enum(["deterministic", "llm"]),
  transcreation: z.enum(["template", "llm"]),
  music: z.enum(["local", "api"]),
  voice: z.enum(["local", "api", "premium"]),
  sfx: z.enum(["local", "api"]),
  blender: BlenderProfile,
  /** AI images allowed (background plates / stylised elements only — never the product) */
  aiImages: z.boolean(),
  /** hard cap of generative video seconds in one reel (0 = never) */
  maxGenerativeVideoSeconds: z.number().min(0).max(10),
  visualQa: z.enum(["deterministic", "ai"]),
  /** default API budget per reel in USD when the job gives none */
  defaultMaxApiCostUsd: z.number().min(0),
});
export type TierProfile = z.infer<typeof TierProfile>;

export const TIER_PROFILES: Record<QualityTier, TierProfile> = {
  ECONOMY: {
    tier: "ECONOMY",
    director: "template",
    productAnalysis: "deterministic",
    transcreation: "template",
    music: "local",
    voice: "local",
    sfx: "local",
    blender: "FAST",
    aiImages: false,
    maxGenerativeVideoSeconds: 0,
    visualQa: "deterministic",
    defaultMaxApiCostUsd: 0,
  },
  STANDARD: {
    tier: "STANDARD",
    director: "llm",
    productAnalysis: "llm",
    transcreation: "llm",
    music: "api",
    voice: "api",
    sfx: "local",
    blender: "FAST",
    aiImages: false,
    maxGenerativeVideoSeconds: 0,
    visualQa: "ai",
    defaultMaxApiCostUsd: 0.2,
  },
  PREMIUM: {
    tier: "PREMIUM",
    director: "llm",
    productAnalysis: "llm",
    transcreation: "llm",
    music: "api",
    voice: "premium",
    sfx: "api",
    blender: "QUALITY",
    aiImages: true,
    maxGenerativeVideoSeconds: 2,
    visualQa: "ai",
    defaultMaxApiCostUsd: 1.5,
  },
};
