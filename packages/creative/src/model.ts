import { z } from "zod";

/**
 * Creative Engine V2 — renderer-independent scene model.
 *
 *   VISUAL STORY (storyboard: beats, media, motion, layout, text *slots*)
 *   +
 *   LOCALE CONTENT (LocalePack: slot → string)
 *   =
 *   RenderPlan (resolved, measured text) → any renderer (Remotion today)
 *
 * Nothing in a storyboard bakes language into visuals: every visible string is a text slot, so one master
 * storyboard renders in any locale and only the language layer changes.
 *
 * Coordinates are pixels in the 1080×1920 master frame; media anchors are normalised (0–1) media coordinates.
 */
export const CREATIVE_MODEL_VERSION = 1;
export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;
export const FRAME_FPS = 30;

export const Point = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof Point>;

export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Rect = z.infer<typeof Rect>;

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB");

/* ------------------------------------------------------------------ vocabulary ------------------ */

/** Reusable commercial creative structures (spec §23). */
export const CreativeStructure = z.enum([
  "PRODUCT_HERO",
  "PROBLEM_SOLUTION",
  "BEFORE_AFTER",
  "TOP_3_FEATURES",
  "THREE_THINGS_TO_KNOW",
  "SPEC_BREAKDOWN",
  "PRODUCT_DEMO",
  "COMPARISON",
  "HOW_TO",
  "MYTH_VS_FACT",
  "BUYING_GUIDE",
  "SAAS_UI_DEMO",
  "TEST_RESULT",
  "QUESTION_HOOK",
  "CONTRARIAN_HOOK",
]);
export type CreativeStructure = z.infer<typeof CreativeStructure>;

/** Visual beat types (spec §24). */
export const VisualBeatType = z.enum([
  "HOOK_VISUAL",
  "PRODUCT_HERO",
  "PRODUCT_MACRO",
  "PRODUCT_IN_USE",
  "FEATURE_CALLOUT",
  "SPEC_CALLOUT",
  "PROBLEM_VISUAL",
  "SOLUTION_VISUAL",
  "BEFORE_AFTER",
  "SIDE_BY_SIDE",
  "SCREEN_DEMO",
  "NUMBER_STAT",
  "COMPARISON",
  "PROCESS_STEP",
  "SOCIAL_PROOF",
  "CTA_CARD",
]);
export type VisualBeatType = z.infer<typeof VisualBeatType>;

export const BeatPurpose = z.enum([
  "HOOK",
  "PROBLEM",
  "SOLUTION",
  "PRODUCT",
  "FEATURE",
  "SPEC",
  "DEMO",
  "PROOF",
  "COMPARISON",
  "STEP",
  "RECAP",
  "CTA",
]);
export type BeatPurpose = z.infer<typeof BeatPurpose>;

/** Typography roles (spec §32). */
export const TextRole = z.enum(["DISPLAY", "HEADLINE", "BODY", "CAPTION", "SUBTITLE", "STAT", "SPEC", "CTA"]);
export type TextRole = z.infer<typeof TextRole>;

/** Camera / media motion primitives (spec §26) — all local, no AI video. */
export const MotionPreset = z.enum([
  "none",
  "cinematic_push",
  "slow_zoom",
  "pan_left",
  "pan_right",
  "pan_up",
  "pan_down",
  "crop_reveal",
  "masked_reveal",
  "parallax",
  "product_float",
  "drop_in",
  "slide_in_left",
  "slide_in_right",
  "whip_in",
  "macro_drift",
  "tilt_in",
]);
export type MotionPreset = z.infer<typeof MotionPreset>;

export const TransitionType = z.enum([
  "cut",
  "match_cut",
  "whip_left",
  "whip_right",
  "whip_up",
  "slide_left",
  "slide_up",
  "scale_in",
  "blur",
  "mask_wipe",
  "flash",
  "fade",
]);
export type TransitionType = z.infer<typeof TransitionType>;

export const CropStrategy = z.enum(["contain", "cover", "focus", "macro"]);
export type CropStrategy = z.infer<typeof CropStrategy>;

export const LayoutId = z.enum([
  "hero_center",
  "hero_low",
  "macro_focus",
  "callout_left",
  "callout_right",
  "split_vertical",
  "split_horizontal",
  "stat_big",
  "list_card",
  "steps_row",
  "full_bleed",
  "screen_demo",
  "cta_card",
]);
export type LayoutId = z.infer<typeof LayoutId>;

/* ------------------------------------------------------------------ media ----------------------- */

export const MediaKind = z.enum(["image", "video", "vector"]);
export const MediaRole = z.enum([
  "product",
  "product_detail",
  "lifestyle",
  "scene",
  "background",
  "ui",
  "prop",
  /** explanatory illustration (how it works, ingredient, mechanism) */
  "diagram",
]);
export type MediaRole = z.infer<typeof MediaRole>;

/** Provenance in priority order for production content (spec §28): real merchant imagery first, demo last. */
export const MediaProvenance = z.enum([
  "merchant",
  "affiliate_network",
  "owned",
  "licensed",
  "cutout",
  "generated",
  "demo",
]);
export type MediaProvenance = z.infer<typeof MediaProvenance>;

export const ParamValue = z.union([z.number(), z.string(), z.boolean()]);
export type ParamValue = z.infer<typeof ParamValue>;

export const MediaRef = z.object({
  id: z.string().min(1),
  kind: MediaKind,
  /** image/video: storage key or URL · vector: key of a parametric illustration in the renderer registry */
  src: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAlpha: z.boolean().default(false),
  role: MediaRole,
  provenance: MediaProvenance,
  /** a stand-in that must never ship (spec §44) */
  placeholder: z.boolean().default(false),
  /** development benchmark media (spec §74) */
  demoOnly: z.boolean().default(false),
  license: z.string().min(1),
  /** named points in normalised media coordinates — targets for callouts, macro zooms, measurements */
  anchors: z.record(z.string(), Point).default({}),
  /** default parameters of a vector illustration (light on, fill level, …) */
  params: z.record(z.string(), ParamValue).default({}),
  /** the product is recognisably visible in this media (always true for product / product_detail roles) */
  showsProduct: z.boolean().default(false),
  description: z.string().default(""),
});
export type MediaRef = z.infer<typeof MediaRef>;

/** Does this media show the product? (product shots, details, or scenes flagged `showsProduct`) */
export function mediaShowsProduct(m: Pick<MediaRef, "role" | "showsProduct">): boolean {
  return m.role === "product" || m.role === "product_detail" || m.showsProduct;
}

/** Keyframed numeric parameter (vector media params, e.g. a light fading on). */
export const Keyframes = z.array(z.object({ atMs: z.number().min(0), value: z.number() })).min(1);
export type Keyframes = z.infer<typeof Keyframes>;

export const MediaSlot = z.enum([
  "primary",
  "secondary",
  "background",
  "before",
  "after",
  "left",
  "right",
  "inset",
]);
export type MediaSlot = z.infer<typeof MediaSlot>;

export const BeatMedia = z.object({
  assetId: z.string(),
  slot: MediaSlot,
  /** frame of the media on the canvas (px) */
  box: Rect,
  crop: CropStrategy.default("contain"),
  /** anchor to centre on (focus / macro crops) */
  focus: z.string().optional(),
  /** scale over the beat: [from, to] */
  zoom: z.tuple([z.number().positive(), z.number().positive()]).default([1, 1]),
  motion: MotionPreset.default("none"),
  shadow: z.boolean().default(false),
  /** soft light behind the media (product hero) */
  backlight: z.boolean().default(false),
  rotate: z.number().default(0),
  params: z.record(z.string(), ParamValue).default({}),
  /** keyframed numeric params (relative to beat start) */
  animate: z.record(z.string(), Keyframes).default({}),
  /** delay before the media appears (ms from beat start) */
  enterMs: z.number().int().min(0).default(0),
  opacity: z.number().min(0).max(1).default(1),
});
export type BeatMedia = z.infer<typeof BeatMedia>;

/* ------------------------------------------------------------------ overlays -------------------- */

const base = { id: z.string(), delayMs: z.number().int().min(0).default(0) };

/** pictograms drawn by the renderer (no icon font, no external assets) */
export const IconKind = z.enum([
  "crystal",
  "layers",
  "sun",
  "drop",
  "leaf",
  "shield",
  "sparkle",
  "feather",
  "bag",
  "clock",
  "bolt",
  "check",
]);
export type IconKind = z.infer<typeof IconKind>;

export const Overlay = z.discriminatedUnion("kind", [
  /** pointer line from a point on the product to a label */
  z.object({
    ...base,
    kind: z.literal("callout"),
    target: Point,
    label: Rect,
    textSlot: z.string(),
    side: z.enum(["left", "right"]),
  }),
  /** dimension line with end ticks and a value label */
  z.object({
    ...base,
    kind: z.literal("measure"),
    from: Point,
    to: Point,
    label: Rect,
    textSlot: z.string(),
  }),
  z.object({ ...base, kind: z.literal("arrow"), from: Point, to: Point, curve: z.number().default(0) }),
  z.object({ ...base, kind: z.literal("highlight"), shape: z.enum(["ring", "box"]), rect: Rect }),
  /** animated number (counter) with optional gauge / bar */
  z.object({
    ...base,
    kind: z.literal("counter"),
    box: Rect,
    from: z.number(),
    to: z.number(),
    decimals: z.number().int().min(0).max(3).default(0),
    /** numeric value is formatted by the renderer with the locale's Intl rules */
    unitSlot: z.string().optional(),
    labelSlot: z.string().optional(),
    durationMs: z.number().int().min(200).max(4000).default(900),
    style: z.enum(["plain", "gauge", "bar"]).default("plain"),
    max: z.number().positive().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("spec_list"),
    box: Rect,
    items: z
      .array(z.object({ labelSlot: z.string(), valueSlot: z.string() }))
      .min(1)
      .max(5),
    staggerMs: z.number().int().min(0).default(160),
  }),
  z.object({
    ...base,
    kind: z.literal("checklist"),
    box: Rect,
    itemSlots: z.array(z.string()).min(1).max(5),
    staggerMs: z.number().int().min(0).default(180),
  }),
  z.object({
    ...base,
    kind: z.literal("steps"),
    box: Rect,
    itemSlots: z.array(z.string()).min(2).max(4),
    staggerMs: z.number().int().min(0).default(320),
  }),
  /** before/after reveal: the "after" media is uncovered from `fromPct` to `toPct` of the box width */
  z.object({
    ...base,
    kind: z.literal("slider"),
    box: Rect,
    fromPct: z.number().min(0).max(1),
    toPct: z.number().min(0).max(1),
    durationMs: z.number().int().min(200).default(1400),
    beforeSlot: z.string().optional(),
    afterSlot: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("badge"),
    box: Rect,
    textSlot: z.string(),
    tone: z.enum(["accent", "surface", "outline", "dark"]).default("accent"),
  }),
  z.object({
    ...base,
    kind: z.literal("particles"),
    box: Rect,
    variant: z.enum(["dust", "crumbs", "sparkle", "fur", "bubbles", "light"]),
    direction: z.enum(["up", "down", "left", "right", "in", "out"]).default("out"),
    density: z.number().min(0).max(1).default(0.5),
    /** point the particles flow into (direction "in") */
    sink: Point.optional(),
    seed: z.number().int().default(1),
    durationMs: z.number().int().optional(),
  }),
  z.object({ ...base, kind: z.literal("light_sweep"), box: Rect, angle: z.number().default(18) }),
  /** card / glass panel / scrim behind grouped content */
  z.object({
    ...base,
    kind: z.literal("panel"),
    box: Rect,
    tone: z.enum(["surface", "glass", "dark", "accent", "outline", "scrim"]),
    shadow: z.boolean().default(true),
  }),
  z.object({
    ...base,
    kind: z.literal("cursor"),
    path: z.array(Point).min(2),
    clickAtMs: z.array(z.number().int().min(0)).default([]),
  }),
  /** short label with a pictogram — benefits shown as visual callouts instead of a bullet list */
  z.object({
    ...base,
    kind: z.literal("icon_chip"),
    box: Rect,
    icon: IconKind,
    textSlot: z.string(),
    tone: z.enum(["light", "dark", "accent"]).default("light"),
  }),
  z.object({
    ...base,
    kind: z.literal("timer"),
    box: Rect,
    seconds: z.number().positive(),
    labelSlot: z.string().optional(),
  }),
]);
export type Overlay = z.infer<typeof Overlay>;
export type OverlayKind = Overlay["kind"];

/* ------------------------------------------------------------------ text ------------------------ */

export const TextAnimation = z.enum([
  "none",
  "rise",
  "word_stagger",
  "mask_up",
  "slide_left",
  "slide_right",
  "pop",
  "scale_in",
  "typewriter",
]);
export type TextAnimation = z.infer<typeof TextAnimation>;

export const TextSurface = z.enum(["none", "scrim", "chip", "card", "marker"]);
export type TextSurface = z.infer<typeof TextSurface>;

/** onMedia: white, for text set over photography / scenes (with a dark scrim) — readable in every kit */
export const TextColor = z.enum(["ink", "inkMuted", "accent", "surfaceInk", "accentInk", "onMedia"]);
export type TextColor = z.infer<typeof TextColor>;

export const TextElement = z.object({
  id: z.string(),
  /** key into the LocalePack — never a literal string */
  slot: z.string(),
  role: TextRole,
  box: Rect,
  align: z.enum(["left", "center", "right"]).default("left"),
  vAlign: z.enum(["top", "middle", "bottom"]).default("top"),
  maxLines: z.number().int().min(1).max(4),
  animation: TextAnimation.default("rise"),
  delayMs: z.number().int().min(0).default(0),
  surface: TextSurface.default("none"),
  color: TextColor.default("ink"),
  /** hide this many ms before the beat ends (0 = visible until the beat ends) */
  exitBeforeEndMs: z.number().int().min(0).default(0),
});
export type TextElement = z.infer<typeof TextElement>;

/* ------------------------------------------------------------------ style ----------------------- */

export const FontSpec = z.object({
  family: z.string(),
  weight: z.number().int().min(100).max(900),
  style: z.enum(["normal", "italic"]).default("normal"),
  /** em */
  letterSpacing: z.number().default(0),
  transform: z.enum(["none", "uppercase"]).default("none"),
  lineHeight: z.number().min(0.8).max(1.8).default(1.06),
});
export type FontSpec = z.infer<typeof FontSpec>;

export const SizeRange = z.object({ min: z.number().positive(), max: z.number().positive() });

const roleRecord = <T extends z.ZodType>(schema: T) =>
  z.object({
    DISPLAY: schema,
    HEADLINE: schema,
    BODY: schema,
    CAPTION: schema,
    SUBTITLE: schema,
    STAT: schema,
    SPEC: schema,
    CTA: schema,
  });

export const Palette = z.object({
  bg: HexColor,
  bg2: HexColor,
  surface: HexColor,
  surfaceInk: HexColor,
  ink: HexColor,
  inkMuted: HexColor,
  accent: HexColor,
  accentInk: HexColor,
  accent2: HexColor,
  line: HexColor,
  /** colour of light effects (LED glow, screen light) — may be too light for text */
  glow: HexColor,
});
export type Palette = z.infer<typeof Palette>;

export const BackgroundKind = z.enum([
  "workshop",
  "tech_grid",
  "clean_home",
  "asphalt",
  "studio_soft",
  "warm_home",
  "plain",
]);
export type BackgroundKind = z.infer<typeof BackgroundKind>;

export const StyleTokens = z.object({
  kit: z.string(),
  palette: Palette,
  fonts: roleRecord(FontSpec),
  sizes: roleRecord(SizeRange),
  radius: z.number().min(0),
  background: z.object({ kind: BackgroundKind, intensity: z.number().min(0).max(1).default(1) }),
  motion: z.object({
    /** 0 calm … 1 energetic — scales travel distances and overshoot */
    energy: z.number().min(0).max(1),
    ease: z.enum(["snappy", "smooth", "springy"]),
    transitionMs: z.number().int().min(0).max(800),
  }),
  /** overlay drawing language */
  overlayStyle: z.enum(["industrial", "tech", "soft", "racing", "hairline", "rounded"]),
  textAlign: z.enum(["left", "center"]),
  /** italic-like slant for display roles (degrees, renderer-only: does not change measured width) */
  displaySkew: z.number().min(-15).max(0).default(0),
  grain: z.number().min(0).max(1).default(0.035),
  vignette: z.number().min(0).max(1).default(0.25),
});
export type StyleTokens = z.infer<typeof StyleTokens>;

/* ------------------------------------------------------------------ audio ----------------------- */

export const SfxKind = z.enum(["whoosh", "tick", "pop", "impact", "riser", "click", "shimmer", "swipe"]);
export type SfxKind = z.infer<typeof SfxKind>;

export const MusicMood = z.enum(["upbeat", "chill", "tech", "warm", "elegant", "drive"]);
export type MusicMood = z.infer<typeof MusicMood>;

export const AudioPlan = z.object({
  music: z.object({
    mood: MusicMood,
    bpm: z.number().int().min(60).max(180),
    gainDb: z.number().max(0).default(-15),
  }),
  sfx: z.array(
    z.object({ atMs: z.number().int().min(0), kind: SfxKind, gainDb: z.number().max(6).default(-10) }),
  ),
  /** voice-over is generated after master approval only (spec §56) */
  voice: z.object({ enabled: z.boolean(), profileId: z.string().optional() }).default({ enabled: false }),
});
export type AudioPlan = z.infer<typeof AudioPlan>;

/* ------------------------------------------------------------------ beats ----------------------- */

export const Transition = z.object({
  type: TransitionType,
  durationMs: z.number().int().min(0).max(900),
});
export type Transition = z.infer<typeof Transition>;

export const VisualBeat = z.object({
  id: z.string().regex(/^s\d{2}$/, "beat ids are s01, s02, …"),
  type: VisualBeatType,
  purpose: BeatPurpose,
  durationMs: z.number().int().min(500).max(8000),
  layout: LayoutId,
  media: z.array(BeatMedia).max(5),
  text: z.array(TextElement).max(4),
  overlays: z.array(Overlay).max(10),
  transitionIn: Transition,
  /** background treatment behind the media */
  background: z.enum(["kit", "alt", "accent", "dark", "media"]).default("kit"),
  /** whole-frame camera move over the beat */
  camera: z
    .object({
      zoom: z.tuple([z.number().positive(), z.number().positive()]).default([1, 1]),
      x: z.tuple([z.number(), z.number()]).default([0, 0]),
      y: z.tuple([z.number(), z.number()]).default([0, 0]),
      /** zoom origin (px); defaults to the frame centre */
      origin: Point.optional(),
    })
    .default({ zoom: [1, 1], x: [0, 0], y: [0, 0] }),
  /** director's reasoning — kept for debugging and QA explanations */
  note: z.string().default(""),
});
export type VisualBeat = z.infer<typeof VisualBeat>;

/** Localization constraints of one text slot (spec §49). */
export const TextSlotSpec = z.object({
  role: TextRole,
  maxWords: z.number().int().positive(),
  maxChars: z.number().int().positive(),
  maxLines: z.number().int().positive(),
  minFontSize: z.number().positive(),
  maxFontSize: z.number().positive(),
  /** time the text is on screen */
  visibleMs: z.number().int().positive(),
  /** reading-time budget: visible time a viewer needs at ~3.5 words/s plus a minimum */
  maxReadingMs: z.number().int().positive(),
  box: z.object({ w: z.number().positive(), h: z.number().positive() }),
  /** numbers / units / names that must survive localization unchanged */
  locked: z.array(z.string()).default([]),
});
export type TextSlotSpec = z.infer<typeof TextSlotSpec>;

export const PlatformKey = z.enum(["TIKTOK", "INSTAGRAM", "FACEBOOK", "YOUTUBE_SHORTS"]);
export type PlatformKey = z.infer<typeof PlatformKey>;

export const CreativeStoryboard = z.object({
  version: z.literal(CREATIVE_MODEL_VERSION),
  id: z.string(),
  title: z.string(),
  category: z.string(),
  structure: CreativeStructure,
  sourceLocale: z.string().default("en-US"),
  format: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
  }),
  style: StyleTokens,
  media: z.array(MediaRef).min(1),
  beats: z.array(VisualBeat).min(3).max(14),
  textSlots: z.record(z.string(), TextSlotSpec),
  global: z.object({
    progressBar: z.boolean().default(true),
    /** on-screen advertising / affiliate disclosure (from brand rules) */
    disclosureSlot: z.string().optional(),
    handle: z.string().optional(),
  }),
  audio: AudioPlan,
  platforms: z.array(PlatformKey).min(1),
  flags: z.object({
    /** any placeholder media → never production ready */
    placeholderMedia: z.boolean(),
    /** benchmark / development content — never publishable */
    demoOnly: z.boolean(),
  }),
  director: z.object({
    version: z.string(),
    concept: z.string(),
    hookStrategy: z.string(),
    visualStyle: z.string(),
    pacing: z.enum(["fast", "medium", "calm"]),
    musicMood: MusicMood,
    reasons: z.array(z.string()),
  }),
});
export type CreativeStoryboard = z.infer<typeof CreativeStoryboard>;
export type CreativeStoryboardInput = z.input<typeof CreativeStoryboard>;

/** Locale content for one market (spec §9): slot → string. `*word*` marks semantic emphasis. */
export const LocalePack = z.object({
  locale: z.string(),
  market: z.string().optional(),
  strings: z.record(z.string(), z.string()),
});
export type LocalePack = z.infer<typeof LocalePack>;

/* ------------------------------------------------------------------ resolved plan --------------- */

export const TextSpan = z.object({ text: z.string(), emphasis: z.boolean() });
export type TextSpan = z.infer<typeof TextSpan>;

/** A text element after measurement: final font size and explicit lines (the renderer never wraps). */
export const ResolvedText = z.object({
  id: z.string(),
  slot: z.string(),
  role: TextRole,
  box: Rect,
  align: z.enum(["left", "center", "right"]),
  vAlign: z.enum(["top", "middle", "bottom"]),
  animation: TextAnimation,
  delayMs: z.number(),
  surface: TextSurface,
  color: TextColor,
  exitBeforeEndMs: z.number(),
  font: FontSpec,
  fontSize: z.number().positive(),
  lineHeightPx: z.number().positive(),
  lines: z.array(z.array(TextSpan)),
  /** measured width of the widest line / total height (px) */
  width: z.number(),
  height: z.number(),
  fits: z.boolean(),
});
export type ResolvedText = z.infer<typeof ResolvedText>;

export const ResolvedBeat = VisualBeat.extend({
  startMs: z.number().int().min(0),
  texts: z.array(ResolvedText),
  /** strings used by overlays (labels, units), already localised */
  strings: z.record(z.string(), z.string()),
  /** measured overlay texts keyed by `${overlayId}:${slot}` */
  overlayTexts: z.record(z.string(), ResolvedText),
});
export type ResolvedBeat = z.infer<typeof ResolvedBeat>;

export const FontAsset = z.object({
  family: z.string(),
  weight: z.number(),
  style: z.enum(["normal", "italic"]),
  /** subset files (latin, latin-ext, …) — relative names the renderer serves */
  files: z.array(z.object({ file: z.string(), unicodeRange: z.string() })),
});
export type FontAsset = z.infer<typeof FontAsset>;

export const RenderPlan = z.object({
  version: z.literal(CREATIVE_MODEL_VERSION),
  storyboardId: z.string(),
  storyboardHash: z.string(),
  locale: z.string(),
  format: z.object({ width: z.number(), height: z.number(), fps: z.number() }),
  durationMs: z.number().int().positive(),
  durationInFrames: z.number().int().positive(),
  style: StyleTokens,
  media: z.record(z.string(), MediaRef.extend({ url: z.string().optional() })),
  beats: z.array(ResolvedBeat),
  global: z.object({
    progressBar: z.boolean(),
    disclosure: ResolvedText.optional(),
    handle: z.string().optional(),
    /** "DEMO MEDIA · NOT PRODUCTION" label for placeholder/demo content */
    demoLabel: z.string().optional(),
  }),
  audio: AudioPlan,
  flags: z.object({ placeholderMedia: z.boolean(), demoOnly: z.boolean() }),
  fonts: z.array(FontAsset),
});
export type RenderPlan = z.infer<typeof RenderPlan>;
