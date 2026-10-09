import { z } from "zod";

/*
 * Whitelists. Everything a model (the Gemini director, a product analyzer, a visual QA model) may choose is one
 * of these closed enums or a bounded number — never a path, a command, a filter string or free-form code. The
 * application maps the ids to concrete, safe actions (bpy keyframes, FFmpeg arguments, provider calls).
 */

/** Procedural Blender shots (keyframes are computed in Python from these ids + bounded params). */
export const SHOT_PRESETS = [
  "hero_reveal",
  "turntable",
  "slow_turntable",
  "orbit",
  "macro_push",
  "macro_pull",
  "camera_slide",
  "top_down",
  "low_angle",
  "floating_product",
  "light_sweep",
  "silhouette_reveal",
  "exploded_view",
  "parts_reveal",
  "assembly",
  "feature_highlight",
  "detail_closeup",
  "impact",
  "product_drop",
  "technical_cutaway",
  "cta_hero",
] as const;
export const ShotPreset = z.enum(SHOT_PRESETS);
export type ShotPreset = z.infer<typeof ShotPreset>;

/**
 * How a shot is produced. `plate` = one realistic still rendered by Blender, the camera move is done in FFmpeg
 * (cheap: push / pull / slide on a static set). `sequence` = real Blender frames (the object or the light moves).
 * `relight` = two plates (lights off / on) blended in linear light — physically exact for a light switching on.
 */
export const ShotTechnique = z.enum(["plate", "sequence", "relight"]);
export type ShotTechnique = z.infer<typeof ShotTechnique>;

/** Studio environments (procedural sets built in bpy). */
export const STUDIO_ENVIRONMENTS = [
  "dark_premium",
  "warm_living",
  "bright_minimal",
  "industrial",
  "natural_daylight",
  "soft_pastel",
] as const;
export const StudioEnvironment = z.enum(STUDIO_ENVIRONMENTS);
export type StudioEnvironment = z.infer<typeof StudioEnvironment>;

/** Blender render profiles. */
export const BlenderProfile = z.enum(["FAST", "QUALITY"]);
export type BlenderProfile = z.infer<typeof BlenderProfile>;

/** Transitions the composer implements (each maps to a fixed FFmpeg xfade mode or a cut). */
export const TRANSITIONS = [
  "cut",
  "fade",
  "fadeblack",
  "fadewhite",
  "slideleft",
  "slideup",
  "smoothleft",
  "wipeleft",
  "circleopen",
  "zoomin",
  "dissolve",
] as const;
export const Transition = z.enum(TRANSITIONS);
export type Transition = z.infer<typeof Transition>;

/** Hook strategies (the hook engine owns the templates; the director only picks one). */
export const HOOK_STRATEGIES = [
  "problem_hook",
  "visual_surprise",
  "price_hook",
  "comparison",
  "before_after",
  "question",
  "pain_point",
  "benefit_first",
  "curiosity",
  "social_proof",
  "speed_demo",
  "feature_reveal",
] as const;
export const HookStrategy = z.enum(HOOK_STRATEGIES);
export type HookStrategy = z.infer<typeof HookStrategy>;

/** Sales roles of a reel segment (not every reel uses all of them). */
export const SALES_ROLES = ["HOOK", "PROBLEM", "BENEFIT", "PROOF", "DEMO", "DESIRE", "VALUE", "CTA"] as const;
export const SalesRole = z.enum(SALES_ROLES);
export type SalesRole = z.infer<typeof SalesRole>;

/** Sound effect library kinds. */
export const SFX_KINDS = [
  "whoosh",
  "impact",
  "metal_hit",
  "metal_click",
  "mechanical_click",
  "motor",
  "snap",
  "air_release",
  "electronic_beep",
  "transition",
  "riser",
  "bass_hit",
  "ui_click",
  "shimmer",
  "light_switch",
] as const;
export const SfxKind = z.enum(SFX_KINDS);
export type SfxKind = z.infer<typeof SfxKind>;

/** Music moods / genres the local composer knows (providers may know more; these are the portable intents). */
export const MUSIC_MOODS = [
  "confident",
  "warm",
  "uplifting",
  "calm",
  "energetic",
  "dark",
  "playful",
  "elegant",
] as const;
export const MusicMood = z.enum(MUSIC_MOODS);
export type MusicMood = z.infer<typeof MusicMood>;

export const MUSIC_GENRES = [
  "industrial_electronic",
  "lofi_house",
  "cinematic",
  "minimal_tech",
  "acoustic_pop",
  "deep_house",
  "ambient",
  "funk",
] as const;
export const MusicGenre = z.enum(MUSIC_GENRES);
export type MusicGenre = z.infer<typeof MusicGenre>;

/** Caption presets the composer renders (libass, burned in). */
export const CAPTION_STYLES = ["word_highlight", "phrase_pop", "karaoke_fill", "minimal_lower"] as const;
export const CaptionStyle = z.enum(CAPTION_STYLES);
export type CaptionStyle = z.infer<typeof CaptionStyle>;

/** Platforms (static profiles live in contracts/platform.ts). */
export const PLATFORM_IDS = ["tiktok", "instagram_reels", "youtube_shorts", "facebook_reels"] as const;
export const PlatformId = z.enum(PLATFORM_IDS);
export type PlatformId = z.infer<typeof PlatformId>;

/** Quality tiers. */
export const QualityTier = z.enum(["ECONOMY", "STANDARD", "PREMIUM"]);
export type QualityTier = z.infer<typeof QualityTier>;

/** Product animation the studio can apply (all deterministic). */
export const PRODUCT_ANIMATIONS = [
  "none",
  "rotate",
  "float",
  "drop",
  "explode",
  "assemble",
  "light_on",
  "spin_part",
] as const;
export const ProductAnimation = z.enum(PRODUCT_ANIMATIONS);
export type ProductAnimation = z.infer<typeof ProductAnimation>;

/** Lighting looks. */
export const LIGHTING_PRESETS = [
  "three_point",
  "rim_dramatic",
  "soft_box",
  "window_daylight",
  "warm_practical",
  "top_spot",
] as const;
export const LightingPreset = z.enum(LIGHTING_PRESETS);
export type LightingPreset = z.infer<typeof LightingPreset>;

/** BCP-47-ish locale tag (pl-PL, en-US, de-DE …). Not limited to a fixed list. */
export const LocaleTag = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-\d{3})?$/, "locale like pl-PL");
export type LocaleTag = z.infer<typeof LocaleTag>;

/** Text slot id inside a plan (copy lives in the locale copy, never inside visual specs). */
export const SlotId = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);
export type SlotId = z.infer<typeof SlotId>;

/** Fact id referencing ProductSource.facts (claim provenance). */
export const FactId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
export type FactId = z.infer<typeof FactId>;

/** Hex colour. */
export const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export type HexColor = z.infer<typeof HexColor>;

/** Every capability the factory can route to a provider. */
export const CAPABILITIES = [
  "director",
  "product_analysis",
  "transcreation",
  "image",
  "music",
  "voice",
  "transcription",
  "sfx",
  "embedding",
  "generative_video",
  "visual_qa",
  "render_3d",
  "compose",
] as const;
export const Capability = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof Capability>;
