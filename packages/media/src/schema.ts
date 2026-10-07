import { z } from "zod";

/**
 * VideoProject — the complete, reproducible description of a render.
 * Stored in the database (ContentProject.renderSpec) so any video can be re-rendered byte-for-byte
 * from JSON. Media sources are references ("asset:<id>" or absolute paths) resolved at render time.
 */

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB");
export const MediaSrc = z.string().min(1);

export const MotionType = z.enum([
  "static",
  "zoom_in",
  "zoom_out",
  "kenburns",
  "pan_left",
  "pan_right",
  "pan_up",
  "pan_down",
]);
export type MotionType = z.infer<typeof MotionType>;

export const TransitionType = z.enum([
  "cut",
  "fade",
  "fadeblack",
  "slideleft",
  "slideup",
  "wipeleft",
  "smoothleft",
  "circleopen",
  "zoomin",
]);
export type TransitionType = z.infer<typeof TransitionType>;

export const Motion = z.object({
  type: MotionType.default("kenburns"),
  /** zoom amount / pan travel (0.12 = 12 %) */
  intensity: z.number().min(0).max(0.5).default(0.12),
});

export const Background = z.discriminatedUnion("type", [
  z.object({ type: z.literal("color"), color: HexColor }),
  z.object({
    type: z.literal("gradient"),
    colors: z.tuple([HexColor, HexColor]),
    animated: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("image"),
    src: MediaSrc,
    motion: Motion.default({ type: "kenburns", intensity: 0.12 }),
    blur: z.number().min(0).max(80).default(0),
    darken: z.number().min(0).max(0.9).default(0),
  }),
  z.object({
    type: z.literal("video"),
    src: MediaSrc,
    blur: z.number().min(0).max(80).default(0),
    darken: z.number().min(0).max(0.9).default(0),
  }),
]);
export type Background = z.infer<typeof Background>;

export const LayerEnter = z.enum(["none", "fade", "slide_up", "slide_left", "slide_right", "rise"]);

export const ImageLayer = z.object({
  type: z.literal("image"),
  src: MediaSrc,
  /** centre position in px */
  x: z.number(),
  y: z.number(),
  /** bounding box; the image is fitted inside (contain) */
  width: z.number().positive(),
  height: z.number().positive(),
  enter: LayerEnter.default("fade"),
  enterAtMs: z.number().min(0).default(0),
  enterDurationMs: z.number().min(0).default(450),
  /** gentle vertical bobbing ("floating product") */
  float: z.boolean().default(false),
  shadow: z.boolean().default(true),
  /** horizontal drift in px over the scene (parallax against the background) */
  driftX: z.number().default(0),
});
export type ImageLayer = z.infer<typeof ImageLayer>;

export const Scene = z.object({
  id: z.string(),
  kind: z.string(),
  durationMs: z.number().int().min(300).max(30_000),
  background: Background,
  layers: z.array(ImageLayer).default([]),
  transitionIn: z
    .object({ type: TransitionType, durationMs: z.number().int().min(0).max(2000) })
    .default({ type: "fade", durationMs: 300 }),
  vignette: z.boolean().default(false),
});
export type Scene = z.infer<typeof Scene>;

export const TextStyleName = z.enum([
  "headline",
  "subheadline",
  "body",
  "list",
  "badge",
  "cta",
  "disclosure",
  "label",
]);
export type TextStyleName = z.infer<typeof TextStyleName>;

export const TextAnimation = z.enum(["none", "fade", "pop", "slide_up", "words"]);
export type TextAnimation = z.infer<typeof TextAnimation>;

export const TextOverlay = z.object({
  id: z.string(),
  /** plain text; `*word*` marks accent-highlighted words */
  text: z.string(),
  style: TextStyleName,
  /** anchor point (centre of the block for align=center) */
  x: z.number(),
  y: z.number(),
  align: z.enum(["center", "left", "right"]).default("center"),
  maxWidth: z.number().positive(),
  fontSize: z.number().positive(),
  color: HexColor,
  accentColor: HexColor,
  /** outline colour for highlighted words (defaults to outlineColor) */
  accentOutlineColor: HexColor.optional(),
  outlineColor: HexColor.default("#000000"),
  outline: z.number().min(0).default(0),
  shadow: z.number().min(0).default(0),
  bold: z.boolean().default(true),
  uppercase: z.boolean().default(false),
  animation: TextAnimation.default("fade"),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  layer: z.number().int().min(0).default(2),
});
export type TextOverlay = z.infer<typeof TextOverlay>;

export const ShapeOverlay = z.object({
  id: z.string(),
  type: z.literal("rounded_rect"),
  /** centre position */
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  radius: z.number().min(0),
  color: HexColor,
  opacity: z.number().min(0).max(1).default(1),
  animation: z.enum(["none", "fade", "pop"]).default("fade"),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  layer: z.number().int().min(0).default(1),
});
export type ShapeOverlay = z.infer<typeof ShapeOverlay>;

export const SubtitleWord = z.object({
  text: z.string(),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
});
export type SubtitleWord = z.infer<typeof SubtitleWord>;

export const Subtitles = z.object({
  enabled: z.boolean().default(true),
  style: z.enum(["word_pop", "line"]).default("word_pop"),
  words: z.array(SubtitleWord),
  /** centre y of the caption block */
  y: z.number(),
  fontSize: z.number().positive(),
  color: HexColor,
  highlightColor: HexColor,
  outlineColor: HexColor.default("#000000"),
  maxWordsPerGroup: z.number().int().min(1).max(8).default(3),
  maxCharsPerGroup: z.number().int().min(4).max(60).default(22),
});
export type Subtitles = z.infer<typeof Subtitles>;

export const Audio = z.object({
  music: z
    .object({
      src: MediaSrc,
      volume: z.number().min(0).max(2).default(0.22),
      /** lower the music while the voice-over speaks */
      duck: z.boolean().default(true),
    })
    .optional(),
  voiceover: z
    .object({
      src: MediaSrc,
      volume: z.number().min(0).max(2).default(1),
      startMs: z.number().min(0).default(0),
    })
    .optional(),
  sfx: z
    .array(
      z.object({ src: MediaSrc, atMs: z.number().min(0), volume: z.number().min(0).max(2).default(0.5) }),
    )
    .default([]),
  /** loudness normalisation target (social platforms ≈ -14 LUFS) */
  targetLufs: z.number().min(-30).max(-5).default(-14),
});
export type Audio = z.infer<typeof Audio>;

export const Format = z.object({
  aspect: z.enum(["9:16", "4:5", "1:1"]),
  width: z.number().int().min(144).max(4096),
  height: z.number().int().min(144).max(4096),
  fps: z.number().int().min(10).max(60).default(30),
});
export type Format = z.infer<typeof Format>;

export const SafeArea = z.object({
  top: z.number().min(0),
  bottom: z.number().min(0),
  left: z.number().min(0),
  right: z.number().min(0),
});
export type SafeArea = z.infer<typeof SafeArea>;

export const BrandStyle = z.object({
  name: z.string(),
  primary: HexColor,
  secondary: HexColor,
  accent: HexColor,
  text: HexColor,
  background: HexColor,
  headingFont: z.string().default("Inter"),
  bodyFont: z.string().default("Inter"),
});
export type BrandStyle = z.infer<typeof BrandStyle>;

export const VideoProject = z.object({
  version: z.literal(1),
  templateKey: z.string(),
  format: Format,
  safeArea: SafeArea,
  brand: BrandStyle,
  scenes: z.array(Scene).min(1).max(30),
  texts: z.array(TextOverlay).default([]),
  shapes: z.array(ShapeOverlay).default([]),
  subtitles: Subtitles.optional(),
  audio: Audio.default({ sfx: [], targetLufs: -14 }),
  progressBar: z
    .object({ enabled: z.boolean(), color: HexColor, height: z.number().int().min(2).max(40) })
    .optional(),
  logo: z
    .object({
      src: MediaSrc,
      position: z.enum(["top_left", "top_right", "bottom_left", "bottom_right"]).default("top_left"),
      width: z.number().positive(),
      opacity: z.number().min(0).max(1).default(0.9),
    })
    .optional(),
  /** where the cover/thumbnail frame is taken (ms) */
  coverAtMs: z.number().min(0).default(1200),
  output: z
    .object({
      crf: z.number().int().min(10).max(35).default(20),
      preset: z.string().default("veryfast"),
      audioBitrate: z.string().default("160k"),
    })
    .default({ crf: 20, preset: "veryfast", audioBitrate: "160k" }),
});
export type VideoProject = z.infer<typeof VideoProject>;
export type VideoProjectInput = z.input<typeof VideoProject>;

/** Static post / carousel slide: one frame composed from the same primitives. */
export const StillProject = z.object({
  version: z.literal(1),
  format: Format,
  safeArea: SafeArea,
  brand: BrandStyle,
  background: Background,
  layers: z.array(ImageLayer).default([]),
  texts: z.array(TextOverlay).default([]),
  shapes: z.array(ShapeOverlay).default([]),
  output: z.object({
    format: z.enum(["jpg", "png"]).default("jpg"),
    quality: z.number().int().min(1).max(31).default(2),
  }),
});
export type StillProject = z.infer<typeof StillProject>;
