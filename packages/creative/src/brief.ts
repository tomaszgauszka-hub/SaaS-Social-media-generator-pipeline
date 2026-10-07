import { z } from "zod";
import {
  CreativeStructure,
  IconKind,
  Keyframes,
  MediaRef,
  ParamValue,
  PlatformKey,
  Point,
  Rect,
} from "./model.ts";

/**
 * CreativeBrief — the director's input: product facts and approved copy (in production produced by ONE batched,
 * cached LLM call; in the benchmark a curated fixture) plus the media library with anchors.
 * Everything visual is decided deterministically from here on.
 */
const Params = z.record(z.string(), ParamValue).default({});
const Animate = z.record(z.string(), Keyframes).default({});

export const SceneUse = z.object({
  media: z.string(),
  text: z.string(),
  params: Params,
  animate: Animate,
  textPosition: z.enum(["top", "bottom"]).default("top"),
  particles: z
    .object({
      variant: z.enum(["dust", "crumbs", "sparkle", "fur", "bubbles", "light"]),
      direction: z.enum(["up", "down", "left", "right", "in", "out"]).default("out"),
      box: Rect,
      sink: Point.optional(),
      density: z.number().min(0).max(1).default(0.6),
      delayMs: z.number().int().min(0).default(300),
    })
    .optional(),
  timer: z.object({ seconds: z.number().positive(), label: z.string().optional() }).optional(),
  /** show the product (hero media) in a corner of the scene */
  productInset: z.boolean().default(false),
  /** light scene → dark ink on a light scrim; dark scene (default) → white on a dark scrim */
  textTone: z.enum(["light", "dark"]).default("light"),
  /** text role for the scene line (hooks use DISPLAY) */
  textRole: z.enum(["HEADLINE", "BODY"]).default("HEADLINE"),
});
export type SceneUse = z.infer<typeof SceneUse>;

export const BriefStat = z.object({
  value: z.number(),
  from: z.number().default(0),
  decimals: z.number().int().min(0).max(3).default(0),
  unit: z.string(),
  label: z.string(),
  style: z.enum(["plain", "gauge", "bar"]).default("plain"),
  max: z.number().positive().optional(),
  /** media shown with the number (defaults to the hero product) */
  media: z.string().optional(),
  params: Params,
  animate: Animate,
});

export const BriefFeature = z.object({
  id: z.string(),
  title: z.string(),
  /** short label for callouts (defaults to title) */
  callout: z.string().optional(),
  /** anchor on the hero media */
  anchor: z.string().optional(),
  /** dedicated detail media and its anchor */
  media: z.string().optional(),
  mediaAnchor: z.string().optional(),
  zoom: z.number().positive().optional(),
  params: Params,
  animate: Animate,
  stat: BriefStat.optional(),
  /** short animated labels shown with the detail shot (e.g. "SPF 50", "Mineral filter") */
  chips: z
    .array(z.object({ icon: IconKind, label: z.string() }))
    .max(3)
    .default([]),
});
export type BriefFeature = z.infer<typeof BriefFeature>;

/** one quick shot of a benefit montage: its own image, one short label */
export const MontageShot = z.object({
  media: z.string(),
  label: z.string(),
  icon: IconKind.default("check"),
  params: Params,
  animate: Animate,
  /** anchor to frame on (cover crop) and a zoom for variety */
  focus: z.string().optional(),
  zoom: z.number().positive().default(1.08),
});
export type MontageShot = z.infer<typeof MontageShot>;

export const CreativeBrief = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  sourceLocale: z.string().default("en-US"),
  structure: CreativeStructure,
  demoOnly: z.boolean().default(false),
  product: z.object({
    name: z.string(),
    shortName: z.string(),
    eyebrow: z.string().optional(),
    tagline: z.string().optional(),
  }),
  heroMedia: z.string(),
  heroParams: Params,
  media: z.array(MediaRef).min(1),
  hook: z.object({ text: z.string(), strategy: z.string(), scene: SceneUse.optional() }),
  problem: SceneUse.optional(),
  solution: SceneUse.optional(),
  features: z.array(BriefFeature).default([]),
  calloutsTitle: z.string().optional(),
  inUse: SceneUse.optional(),
  specs: z
    .object({
      title: z.string(),
      items: z
        .array(z.object({ label: z.string(), value: z.string() }))
        .min(1)
        .max(5),
    })
    .optional(),
  checklist: z.object({ title: z.string(), items: z.array(z.string()).min(1).max(5) }).optional(),
  steps: z
    .object({
      title: z.string(),
      items: z.array(z.string()).min(2).max(4),
      media: z.string().optional(),
      /** numeric media parameter stepped 0 → n with the steps */
      param: z.string().optional(),
      params: Params,
    })
    .optional(),
  beforeAfter: z
    .object({
      headline: z.string(),
      before: z.string(),
      after: z.string(),
      beforeLabel: z.string(),
      afterLabel: z.string(),
      beforeParams: Params,
      afterParams: Params,
    })
    .optional(),
  sideBySide: z
    .object({
      headline: z.string(),
      left: z.string(),
      right: z.string(),
      leftLabel: z.string(),
      rightLabel: z.string(),
      leftParams: Params,
      rightParams: Params,
    })
    .optional(),
  screen: z
    .object({
      headline: z.string(),
      caption: z.string().optional(),
      media: z.string(),
      params: Params,
      animate: Animate,
      /** cursor path in normalised media coordinates */
      cursor: z.array(Point).optional(),
      clickAtMs: z.array(z.number().int().min(0)).default([]),
    })
    .optional(),
  recap: z.object({ title: z.string(), items: z.array(z.string()).min(2).max(5) }).optional(),
  /** product in its everyday environment (vanity, workshop, desk …) */
  lifestyle: SceneUse.optional(),
  /** how it works / what is inside — an explanatory visual with pictogram labels */
  ingredient: z
    .object({
      media: z.string(),
      title: z.string().optional(),
      chips: z
        .array(z.object({ icon: IconKind, label: z.string(), at: Point }))
        .min(1)
        .max(3),
      params: Params,
      animate: Animate,
    })
    .optional(),
  /** benefits as rapid cuts over changing imagery (never a static bullet slide) */
  montage: z.object({ shots: z.array(MontageShot).min(2).max(4) }).optional(),
  /** closing hero shot in a new setting */
  heroReturn: z
    .object({
      media: z.string(),
      title: z.string().optional(),
      tagline: z.string().optional(),
      params: Params,
      animate: Animate,
    })
    .optional(),
  cta: z.object({
    headline: z.string(),
    button: z.string(),
    sub: z.string().optional(),
    /** full-bleed scene behind the CTA instead of the kit background */
    scene: z
      .object({
        media: z.string(),
        focus: z.string().optional(),
        zoom: z.number().positive().default(1.15),
        params: Params,
      })
      .optional(),
  }),
  /** on-screen disclosure from the brand's rules (affiliate content) */
  disclosure: z.string().optional(),
  /** labels used by numbered structures ("Feature", "Things to know") */
  labels: z
    .object({
      feature: z.string().default("Feature"),
      before: z.string().optional(),
      after: z.string().optional(),
    })
    .default({ feature: "Feature" }),
  targetDurationMs: z.number().int().min(12_000).max(40_000).default(24_000),
  platforms: z.array(PlatformKey).min(1).default(["TIKTOK", "INSTAGRAM", "FACEBOOK"]),
});
export type CreativeBrief = z.infer<typeof CreativeBrief>;
export type CreativeBriefInput = z.input<typeof CreativeBrief>;
