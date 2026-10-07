import type { BriefFeature, CreativeBrief, SceneUse } from "./brief.ts";
import { G, anchorOnScreen, containRect, lowerZone, rect, stackLabels, topZone } from "./layouts.ts";
import { checklistItemBox, listRows, specRowBoxes, stepRows } from "./overlay-geometry.ts";
import {
  CREATIVE_MODEL_VERSION,
  FRAME_FPS,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  type BeatMedia,
  type BeatPurpose,
  type CreativeStoryboard,
  type LayoutId,
  type LocalePack,
  type MediaRef,
  type MotionPreset,
  type Overlay,
  type Point,
  type Rect,
  type SfxKind,
  type TextElement,
  type TextRole,
  type TextSlotSpec,
  type TransitionType,
  type VisualBeat,
  type VisualBeatType,
  mediaShowsProduct,
} from "./model.ts";
import { FILLER_STEPS, MAX_BEATS, MIN_BEATS, STRUCTURES, type RecipeStep } from "./structures.ts";
import { STYLE_KITS, kitForCategory, type KitId, type StyleKit } from "./style-kits.ts";
import { readingTimeMs } from "./subtitles.ts";
import { estimateCapacity, stripEmphasis } from "./text-fit.ts";

/**
 * CreativeDirector (spec §20) — deterministic: brief + style kit + structure recipe → storyboard + locale pack.
 * No LLM, no randomness: the same brief always yields the same storyboard (hash-stable), which is what makes
 * renders reproducible and lets localization reuse every visual decision.
 */
export const DIRECTOR_VERSION = "director-v1";

export interface DirectorOptions {
  kit?: KitId;
}

export interface DirectorResult {
  storyboard: CreativeStoryboard;
  localePack: LocalePack;
}

interface SfxCue {
  atMs: number;
  kind: SfxKind;
  gainDb?: number;
}

interface Draft {
  type: VisualBeatType;
  purpose: BeatPurpose;
  layout: LayoutId;
  media: BeatMedia[];
  text: TextElement[];
  overlays: Overlay[];
  baseMs: number;
  maxExtraMs?: number;
  background?: VisualBeat["background"];
  camera?: VisualBeat["camera"];
  transition?: TransitionType;
  showsProduct: boolean;
  sfx: SfxCue[];
  note: string;
}

interface SlotMeta {
  role: TextRole;
  box: Rect;
  maxLines: number;
  delayMs: number;
  beatId: string;
  exitBeforeEndMs: number;
}

const FULL: Rect = rect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
const ROLE_MAX_WORDS: Record<TextRole, number> = {
  DISPLAY: 7,
  HEADLINE: 9,
  BODY: 16,
  CAPTION: 6,
  SUBTITLE: 7,
  STAT: 2,
  SPEC: 6,
  CTA: 4,
};

/** FNV-1a — tiny deterministic hash (browser-safe) */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function media(partial: Partial<BeatMedia> & Pick<BeatMedia, "assetId" | "slot" | "box">): BeatMedia {
  return {
    crop: "contain",
    zoom: [1, 1],
    motion: "none",
    shadow: false,
    backlight: false,
    rotate: 0,
    params: {},
    animate: {},
    enterMs: 0,
    opacity: 1,
    ...partial,
  };
}

class Ctx {
  readonly strings: Record<string, string> = {};
  readonly slotMeta: Record<string, SlotMeta> = {};
  readonly media: Map<string, MediaRef>;
  readonly usedMacro = new Set<string>();
  readonly usedStat = new Set<string>();
  readonly usedCallout = new Set<string>();
  featureNo = 0;
  calloutBeats = 0;
  readonly reasons: string[] = [];

  constructor(
    readonly brief: CreativeBrief,
    readonly kit: StyleKit,
  ) {
    this.media = new Map(brief.media.map((m) => [m.id, m]));
  }

  get align(): "left" | "center" {
    return this.kit.tokens.textAlign;
  }

  /** text zone across the top in the kit's alignment */
  top(y: number, h: number): Rect {
    return topZone(y, h, this.align);
  }

  /** text zone in the lower frame (left of the action rail) in the kit's alignment */
  low(y: number, h: number): Rect {
    return lowerZone(y, h, this.align);
  }

  m(id: string): MediaRef {
    const ref = this.media.get(id);
    if (!ref) throw new Error(`Brief ${this.brief.id} references unknown media "${id}"`);
    return ref;
  }

  isProduct(id: string): boolean {
    return mediaShowsProduct(this.m(id));
  }

  /** register a localizable string for a text element */
  text(
    beatId: string,
    name: string,
    value: string,
    role: TextRole,
    box: Rect,
    opts: Partial<Omit<TextElement, "id" | "slot" | "role" | "box">> & { maxLines: number },
  ): TextElement {
    const slot = `${beatId}.${name}`;
    this.strings[slot] = value;
    const el: TextElement = {
      id: slot,
      slot,
      role,
      box,
      align: opts.align ?? this.align,
      vAlign: opts.vAlign ?? "top",
      maxLines: opts.maxLines,
      animation:
        opts.animation ??
        (role === "DISPLAY"
          ? this.kit.direction.textAnimation.display
          : this.kit.direction.textAnimation.body),
      delayMs: opts.delayMs ?? 0,
      surface: opts.surface ?? "none",
      color: opts.color ?? "ink",
      exitBeforeEndMs: opts.exitBeforeEndMs ?? 0,
    };
    this.slotMeta[slot] = {
      role,
      box,
      maxLines: opts.maxLines,
      delayMs: el.delayMs,
      beatId,
      exitBeforeEndMs: el.exitBeforeEndMs,
    };
    return el;
  }

  /** register a localizable string used inside an overlay (label, unit, list item) */
  slot(
    beatId: string,
    name: string,
    value: string,
    role: TextRole,
    box: Rect,
    maxLines: number,
    delayMs: number,
  ): string {
    const slot = `${beatId}.${name}`;
    this.strings[slot] = value;
    this.slotMeta[slot] = { role, box, maxLines, delayMs, beatId, exitBeforeEndMs: 0 };
    return slot;
  }
}

/* ------------------------------------------------------------------ beat builders ---------------- */

function sceneMedia(c: Ctx, scene: SceneUse, motion: MotionPreset, zoom: [number, number]): BeatMedia[] {
  const out: BeatMedia[] = [
    media({
      assetId: scene.media,
      slot: "primary",
      box: FULL,
      crop: "cover",
      motion,
      zoom,
      params: scene.params,
      animate: scene.animate,
    }),
  ];
  if (scene.productInset) {
    out.push(
      media({
        assetId: c.brief.heroMedia,
        slot: "inset",
        box: rect(470, 1000, 560, 520),
        motion: "slide_in_right",
        shadow: true,
        enterMs: 700,
        params: c.brief.heroParams,
      }),
    );
  }
  return out;
}

function sceneOverlays(beatId: string, c: Ctx, scene: SceneUse): Overlay[] {
  const out: Overlay[] = [];
  if (scene.particles) {
    const p = scene.particles;
    out.push({
      id: `${beatId}.particles`,
      kind: "particles",
      delayMs: p.delayMs,
      box: p.box,
      variant: p.variant,
      direction: p.direction,
      density: p.density,
      ...(p.sink ? { sink: p.sink } : {}),
      seed: Number.parseInt(fnv1a(beatId + p.variant).slice(0, 6), 16),
    });
  }
  if (scene.timer) {
    const labelSlot = scene.timer.label
      ? c.slot(beatId, "timer", scene.timer.label, "CAPTION", rect(G.L, 560, 420, 60), 1, 200)
      : undefined;
    out.push({
      id: `${beatId}.timer`,
      kind: "timer",
      delayMs: 200,
      box: rect(G.L, 590, 360, 120),
      seconds: scene.timer.seconds,
      ...(labelSlot ? { labelSlot } : {}),
    });
  }
  return out;
}

function sceneText(
  c: Ctx,
  beatId: string,
  name: string,
  scene: SceneUse,
  value: string,
  role: TextRole,
): TextElement {
  const box =
    scene.textPosition === "top"
      ? c.top(G.TOP, role === "DISPLAY" ? 470 : 340)
      : c.low(G.CONTENT_BOTTOM - 364, 364);
  return c.text(beatId, name, value, role, box, {
    maxLines: role === "DISPLAY" ? 3 : 3,
    vAlign: scene.textPosition === "top" ? "top" : "bottom",
    delayMs: 90,
    surface: "scrim",
  });
}

function hookBeat(c: Ctx, id: string): Draft {
  const { brief, kit } = c;
  const energy = kit.tokens.motion.energy;
  const scene = brief.hook.scene;
  if (scene) {
    const problemFirst = ["PROBLEM_SOLUTION", "BEFORE_AFTER", "MYTH_VS_FACT"].includes(brief.structure);
    return {
      type: problemFirst ? "PROBLEM_VISUAL" : "HOOK_VISUAL",
      purpose: "HOOK",
      layout: "full_bleed",
      media: sceneMedia(c, scene, "cinematic_push", [1, 1 + 0.05 + energy * 0.05]),
      text: [sceneText(c, id, "hook", scene, brief.hook.text, "DISPLAY")],
      overlays: sceneOverlays(id, c, scene),
      baseMs: 2000,
      background: "media",
      showsProduct: scene.productInset || c.isProduct(scene.media),
      sfx: energy >= 0.8 ? [{ atMs: 40, kind: "impact" }] : [{ atMs: 60, kind: "swipe", gainDb: -14 }],
      note: `Scene hook (${brief.hook.strategy}) over ${scene.media}`,
    };
  }
  return {
    type: "HOOK_VISUAL",
    purpose: "HOOK",
    layout: "hero_low",
    media: [
      media({
        assetId: brief.heroMedia,
        slot: "primary",
        box: rect(40, 640, 1000, 820),
        motion: kit.direction.motion.hero,
        shadow: true,
        backlight: true,
        params: brief.heroParams,
      }),
    ],
    text: [c.text(id, "hook", brief.hook.text, "DISPLAY", c.top(G.TOP, 430), { maxLines: 3, delayMs: 60 })],
    overlays: [],
    baseMs: 2000,
    showsProduct: true,
    sfx: [{ atMs: 30, kind: energy >= 0.7 ? "impact" : "pop" }],
    note: `Product hook (${brief.hook.strategy}) — product visible from frame 0`,
  };
}

function sceneBeat(c: Ctx, id: string, kind: "PROBLEM" | "SOLUTION", isFirst: boolean): Draft | null {
  const scene = kind === "PROBLEM" ? c.brief.problem : c.brief.solution;
  if (!scene) return null;
  const value = kind === "PROBLEM" && isFirst ? c.brief.hook.text : scene.text;
  const role: TextRole = isFirst ? "DISPLAY" : "HEADLINE";
  return {
    type: kind === "PROBLEM" ? "PROBLEM_VISUAL" : "SOLUTION_VISUAL",
    purpose: isFirst ? "HOOK" : kind,
    layout: "full_bleed",
    media: sceneMedia(
      c,
      scene,
      kind === "PROBLEM" ? "cinematic_push" : "slow_zoom",
      kind === "PROBLEM" ? [1, 1.08] : [1.04, 1],
    ),
    text: [sceneText(c, id, kind === "PROBLEM" ? "problem" : "solution", scene, value, role)],
    overlays: sceneOverlays(id, c, scene),
    baseMs: kind === "PROBLEM" ? 2200 : 2600,
    background: "media",
    showsProduct: scene.productInset || c.isProduct(scene.media),
    sfx:
      kind === "SOLUTION"
        ? [{ atMs: 250, kind: "shimmer" }]
        : isFirst
          ? [{ atMs: 40, kind: "swipe", gainDb: -14 }]
          : [],
    note: `${kind.toLowerCase()} scene ${scene.media}`,
  };
}

function heroBeat(c: Ctx, id: string, prev: Draft | undefined): Draft {
  const { brief, kit } = c;
  const continuing = prev?.layout === "hero_low";
  const text: TextElement[] = [];
  if (brief.product.eyebrow)
    text.push(
      c.text(id, "eyebrow", brief.product.eyebrow, "CAPTION", c.top(G.TOP, 54), {
        maxLines: 1,
        delayMs: 120,
        color: "accent",
      }),
    );
  text.push(
    c.text(id, "name", brief.product.shortName, "HEADLINE", c.top(G.TOP + 66, 282), {
      maxLines: 2,
      delayMs: 200,
    }),
  );
  if (brief.product.tagline)
    text.push(
      c.text(id, "tagline", brief.product.tagline, "BODY", c.low(G.CONTENT_BOTTOM - 136, 136), {
        maxLines: 2,
        delayMs: 520,
        color: "inkMuted",
      }),
    );
  return {
    type: "PRODUCT_HERO",
    purpose: "PRODUCT",
    layout: "hero_center",
    media: [
      media({
        assetId: brief.heroMedia,
        slot: "primary",
        box: rect(70, 540, 940, 760),
        motion: continuing ? "product_float" : kit.direction.motion.hero,
        shadow: true,
        backlight: true,
        params: brief.heroParams,
      }),
    ],
    text,
    overlays: [
      { id: `${id}.sweep`, kind: "light_sweep", delayMs: 500, box: rect(70, 540, 940, 760), angle: 18 },
    ],
    baseMs: 2600,
    showsProduct: true,
    sfx: continuing ? [] : [{ atMs: 80, kind: kit.tokens.motion.energy > 0.6 ? "whoosh" : "shimmer" }],
    note: continuing ? "Hero continues the product hook (match framing)" : "Product hero reveal",
  };
}

function nextFeature(
  c: Ctx,
  pred: (f: BriefFeature) => boolean,
  used: Set<string>,
): BriefFeature | undefined {
  return c.brief.features.find((f) => pred(f) && !used.has(f.id)) ?? undefined;
}

function macroBeat(c: Ctx, id: string): Draft | null {
  const f = nextFeature(c, (x) => Boolean(x.anchor || (x.media && x.mediaAnchor)), c.usedMacro);
  if (!f) return null;
  c.usedMacro.add(f.id);
  c.featureNo++;
  const assetId = f.media ?? c.brief.heroMedia;
  const focus = f.media ? f.mediaAnchor : f.anchor;
  const z = f.zoom ?? 2.3;
  const at: Point = { x: G.W / 2, y: 800 };
  const numbered = ["TOP_3_FEATURES", "THREE_THINGS_TO_KNOW"].includes(c.brief.structure);
  const text: TextElement[] = [];
  if (numbered)
    text.push(
      c.text(
        id,
        "eyebrow",
        `${c.brief.labels.feature} ${String(c.featureNo).padStart(2, "0")}`,
        "CAPTION",
        c.low(G.CONTENT_BOTTOM - 300, 52),
        {
          maxLines: 1,
          delayMs: 160,
          color: "accent",
        },
      ),
    );
  text.push(
    c.text(id, "title", f.title, "HEADLINE", c.low(G.CONTENT_BOTTOM - 236, 236), {
      maxLines: 2,
      delayMs: 260,
      surface: "scrim",
    }),
  );
  return {
    type: "PRODUCT_MACRO",
    purpose: "FEATURE",
    layout: "macro_focus",
    media: [
      media({
        assetId,
        slot: "primary",
        box: FULL,
        crop: "macro",
        ...(focus ? { focus } : {}),
        zoom: [z, z * 1.1],
        motion: c.kit.direction.motion.macro,
        params: { ...c.brief.heroParams, ...f.params },
        animate: f.animate,
      }),
    ],
    text,
    overlays: [
      {
        id: `${id}.ring`,
        kind: "highlight",
        delayMs: 380,
        shape: "ring",
        rect: rect(at.x - 170, at.y - 170, 340, 340),
      },
    ],
    baseMs: 2400,
    background: "dark",
    showsProduct: c.isProduct(assetId),
    sfx: [{ atMs: 380, kind: "tick" }],
    note: `Macro on "${focus ?? "centre"}" for feature ${f.id}`,
  };
}

function calloutsBeat(c: Ctx, id: string): Draft | null {
  const hero = c.m(c.brief.heroMedia);
  const features = c.brief.features.filter((f) => f.anchor && hero.anchors[f.anchor]).slice(0, 3);
  if (features.length < 2) return null;
  features.forEach((f) => c.usedCallout.add(f.id));
  const avgX = features.reduce((s, f) => s + hero.anchors[f.anchor!]!.x, 0) / features.length;
  const side: "left" | "right" = avgX >= 0.5 ? "right" : "left";
  const productBox = side === "right" ? rect(-30, 560, 720, 860) : rect(390, 560, 720, 860);
  const col = side === "right" ? { x: 650, w: G.R_LOW - 650 } : { x: G.L, w: 290 };
  const targets = features.map((f) => anchorOnScreen(hero, productBox, f.anchor!));
  const labelH = 132;
  const ys = stackLabels(
    targets.map((t) => t.y),
    { top: 640, bottom: G.CONTENT_BOTTOM, height: labelH, gap: 28 },
  );
  const overlays: Overlay[] = features.map((f, i) => {
    const delay = 420 + i * 560;
    const label = rect(col.x, ys[i]!, col.w, labelH);
    return {
      id: `${id}.callout${i + 1}`,
      kind: "callout",
      delayMs: delay,
      target: targets[i]!,
      label,
      textSlot: c.slot(id, `callout${i + 1}`, f.callout ?? f.title, "SPEC", label, 2, delay),
      side,
    };
  });
  c.calloutBeats++;
  return {
    type: "FEATURE_CALLOUT",
    purpose: "FEATURE",
    layout: side === "right" ? "callout_right" : "callout_left",
    media: [
      media({
        assetId: c.brief.heroMedia,
        slot: "primary",
        box: productBox,
        motion: "none",
        shadow: true,
        params: c.brief.heroParams,
      }),
    ],
    text: [
      c.text(id, "title", c.brief.calloutsTitle ?? c.brief.product.shortName, "HEADLINE", c.top(G.TOP, 230), {
        maxLines: 2,
        delayMs: 100,
      }),
    ],
    overlays,
    baseMs: 2000 + features.length * 600,
    maxExtraMs: 1400,
    showsProduct: true,
    sfx: overlays.map((o) => ({ atMs: o.delayMs, kind: "tick" as const })),
    note: `${features.length} callouts on the ${side}, targets from media anchors`,
  };
}

function statBeat(c: Ctx, id: string): Draft | null {
  const f = nextFeature(c, (x) => Boolean(x.stat), c.usedStat);
  if (!f?.stat) return null;
  c.usedStat.add(f.id);
  const s = f.stat;
  const mediaId = s.media ?? c.brief.heroMedia;
  const unitSlot = c.slot(id, "unit", s.unit, "STAT", rect(G.L, 300, 400, 120), 1, 250);
  if (s.style === "gauge") {
    const box = rect(190, 280, 700, 700);
    return {
      type: "NUMBER_STAT",
      purpose: "SPEC",
      layout: "stat_big",
      media: [
        media({
          assetId: mediaId,
          slot: "background",
          box: c.isProduct(mediaId) ? rect(150, 1110, 780, 560) : rect(0, 1090, FRAME_WIDTH, 830),
          crop: c.isProduct(mediaId) ? "contain" : "cover",
          motion: "slow_zoom",
          zoom: [1, 1.05],
          shadow: c.isProduct(mediaId),
          opacity: c.isProduct(mediaId) ? 1 : 0.9,
          params: { ...c.brief.heroParams, ...s.params },
          animate: s.animate,
        }),
      ],
      text: [
        c.text(id, "label", s.label, "HEADLINE", lowerZone(976, 120, "center"), {
          maxLines: 1,
          delayMs: 300,
          align: "center",
        }),
      ],
      overlays: [
        {
          id: `${id}.counter`,
          kind: "counter",
          delayMs: 250,
          box,
          from: s.from,
          to: s.value,
          decimals: s.decimals,
          unitSlot,
          durationMs: 1100,
          style: "gauge",
          ...(s.max ? { max: s.max } : {}),
        },
      ],
      baseMs: 2700,
      background: "alt",
      showsProduct: c.isProduct(mediaId),
      sfx: [
        { atMs: 250, kind: "riser", gainDb: -16 },
        { atMs: 1350, kind: "pop" },
      ],
      note: `Gauge counter ${s.from}→${s.value} ${s.unit}`,
    };
  }
  return {
    type: "NUMBER_STAT",
    purpose: "SPEC",
    layout: "stat_big",
    media: [
      media({
        assetId: mediaId,
        slot: "primary",
        box: rect(60, 720, 960, 760),
        crop: c.isProduct(mediaId) ? "contain" : "cover",
        motion: "slow_zoom",
        zoom: [1, 1.06],
        shadow: c.isProduct(mediaId),
        params: { ...c.brief.heroParams, ...s.params },
        animate: s.animate,
      }),
    ],
    text: [
      c.text(id, "label", s.label, "CAPTION", c.top(G.TOP + 6, 56), {
        maxLines: 1,
        delayMs: 120,
        color: "accent",
      }),
    ],
    overlays: [
      {
        id: `${id}.counter`,
        kind: "counter",
        delayMs: 250,
        box: c.top(260, 400),
        from: s.from,
        to: s.value,
        decimals: s.decimals,
        unitSlot,
        durationMs: 1000,
        style: s.style,
        ...(s.max ? { max: s.max } : {}),
      },
    ],
    baseMs: 2500,
    showsProduct: c.isProduct(mediaId),
    sfx: [
      { atMs: 250, kind: "riser", gainDb: -16 },
      { atMs: 1250, kind: "pop" },
    ],
    note: `Counter ${s.from}→${s.value} ${s.unit}`,
  };
}

function listBeat(c: Ctx, id: string, kind: "SPECS" | "CHECKLIST" | "RECAP"): Draft | null {
  const data = kind === "SPECS" ? c.brief.specs : kind === "CHECKLIST" ? c.brief.checklist : c.brief.recap;
  if (!data) return null;
  const n = "items" in data ? data.items.length : 0;
  const panel = c.low(G.CONTENT_BOTTOM - 500, 500);
  const inner = rect(panel.x + 36, panel.y + 34, panel.w - 72, panel.h - 68);
  const rows = listRows(inner, n);
  const overlays: Overlay[] = [
    { id: `${id}.panel`, kind: "panel", delayMs: 120, box: panel, tone: "surface", shadow: true },
  ];
  if (kind === "SPECS" && c.brief.specs) {
    overlays.push({
      id: `${id}.list`,
      kind: "spec_list",
      delayMs: 300,
      box: inner,
      staggerMs: 170,
      items: c.brief.specs.items.map((it, i) => {
        const b = specRowBoxes(rows[i]!);
        return {
          labelSlot: c.slot(id, `label${i + 1}`, it.label, "SPEC", b.label, 1, 300 + i * 170),
          valueSlot: c.slot(id, `value${i + 1}`, it.value, "SPEC", b.value, 1, 300 + i * 170),
        };
      }),
    });
  } else {
    const items = kind === "CHECKLIST" ? c.brief.checklist!.items : c.brief.recap!.items;
    overlays.push({
      id: `${id}.list`,
      kind: "checklist",
      delayMs: 300,
      box: inner,
      staggerMs: 220,
      itemSlots: items.map((it, i) =>
        c.slot(id, `item${i + 1}`, it, "BODY", checklistItemBox(rows[i]!).text, 1, 300 + i * 220),
      ),
    });
  }
  return {
    type: kind === "SPECS" ? "SPEC_CALLOUT" : "SOCIAL_PROOF",
    purpose: kind === "SPECS" ? "SPEC" : kind === "CHECKLIST" ? "PROOF" : "RECAP",
    layout: "list_card",
    media: [
      media({
        assetId: c.brief.heroMedia,
        slot: "primary",
        box: rect(150, 400, 780, 440),
        motion: "product_float",
        shadow: true,
        params: c.brief.heroParams,
      }),
    ],
    text: [c.text(id, "title", data.title, "HEADLINE", c.top(G.TOP, 200), { maxLines: 2, delayMs: 80 })],
    overlays,
    baseMs: 2000 + n * 420,
    maxExtraMs: 1200,
    showsProduct: true,
    sfx: Array.from({ length: n }, (_, i) => ({
      atMs: 300 + i * (kind === "SPECS" ? 170 : 220),
      kind: "click" as const,
      gainDb: -16,
    })),
    note: `${kind.toLowerCase()} card with ${n} items`,
  };
}

function inUseBeat(c: Ctx, id: string): Draft | null {
  const s = c.brief.inUse;
  if (!s) return null;
  return {
    type: "PRODUCT_IN_USE",
    purpose: "DEMO",
    layout: "full_bleed",
    media: sceneMedia(c, s, c.kit.direction.motion.inUse, [1.02, 1.1]),
    text: [sceneText(c, id, "text", s, s.text, "HEADLINE")],
    overlays: sceneOverlays(id, c, s),
    baseMs: 2900,
    background: "media",
    showsProduct: s.productInset || c.isProduct(s.media),
    sfx: s.particles ? [{ atMs: s.particles.delayMs, kind: "swipe", gainDb: -15 }] : [],
    note: `In-use demonstration on ${s.media}`,
  };
}

function beforeAfterBeat(c: Ctx, id: string): Draft | null {
  const ba = c.brief.beforeAfter;
  if (!ba) return null;
  const beforeLabel = rect(G.L, 214, 300, 78);
  const afterLabel = rect(G.R_TOP - 300, 214, 300, 78);
  return {
    type: "BEFORE_AFTER",
    purpose: "COMPARISON",
    layout: "split_vertical",
    media: [
      media({ assetId: ba.before, slot: "before", box: FULL, crop: "cover", params: ba.beforeParams }),
      media({ assetId: ba.after, slot: "after", box: FULL, crop: "cover", params: ba.afterParams }),
    ],
    text: [
      c.text(id, "headline", ba.headline, "HEADLINE", c.low(G.CONTENT_BOTTOM - 250, 250), {
        maxLines: 2,
        delayMs: 1500,
        surface: "scrim",
      }),
    ],
    overlays: [
      {
        id: `${id}.slider`,
        kind: "slider",
        delayMs: 350,
        box: FULL,
        fromPct: 0.02,
        toPct: 0.98,
        durationMs: 1500,
      },
      {
        id: `${id}.before`,
        kind: "badge",
        delayMs: 100,
        box: beforeLabel,
        textSlot: c.slot(id, "before", ba.beforeLabel, "CAPTION", beforeLabel, 1, 100),
        tone: "dark",
      },
      {
        id: `${id}.after`,
        kind: "badge",
        delayMs: 1000,
        box: afterLabel,
        textSlot: c.slot(id, "after", ba.afterLabel, "CAPTION", afterLabel, 1, 1000),
        tone: "accent",
      },
    ],
    baseMs: 3200,
    background: "media",
    showsProduct: c.isProduct(ba.after),
    sfx: [{ atMs: 350, kind: "swipe" }],
    note: "Before/after slider reveal",
  };
}

function sideBySideBeat(c: Ctx, id: string): Draft | null {
  const s = c.brief.sideBySide;
  if (!s) return null;
  const leftLabel = rect(G.L, 230, 400, 78);
  const rightLabel = rect(G.W / 2 + 36, 230, G.R_TOP - G.W / 2 - 36, 78);
  return {
    type: "SIDE_BY_SIDE",
    purpose: "COMPARISON",
    layout: "split_horizontal",
    media: [
      media({
        assetId: s.left,
        slot: "left",
        box: rect(0, 0, G.W / 2, G.H),
        crop: "cover",
        motion: "pan_up",
        zoom: [1.05, 1.05],
        params: s.leftParams,
      }),
      media({
        assetId: s.right,
        slot: "right",
        box: rect(G.W / 2, 0, G.W / 2, G.H),
        crop: "cover",
        motion: "pan_down",
        zoom: [1.05, 1.05],
        params: s.rightParams,
        enterMs: 250,
      }),
    ],
    text: [
      c.text(id, "headline", s.headline, "HEADLINE", c.low(G.CONTENT_BOTTOM - 250, 250), {
        maxLines: 2,
        delayMs: 700,
        surface: "scrim",
      }),
    ],
    overlays: [
      {
        id: `${id}.left`,
        kind: "badge",
        delayMs: 150,
        box: leftLabel,
        textSlot: c.slot(id, "left", s.leftLabel, "CAPTION", leftLabel, 1, 150),
        tone: "dark",
      },
      {
        id: `${id}.right`,
        kind: "badge",
        delayMs: 450,
        box: rightLabel,
        textSlot: c.slot(id, "right", s.rightLabel, "CAPTION", rightLabel, 1, 450),
        tone: "accent",
      },
    ],
    baseMs: 3000,
    background: "media",
    showsProduct: c.isProduct(s.right) || c.isProduct(s.left),
    sfx: [{ atMs: 250, kind: "swipe" }],
    note: "Side-by-side comparison",
  };
}

function screenBeat(c: Ctx, id: string): Draft | null {
  const s = c.brief.screen;
  if (!s) return null;
  const box = rect(30, 400, 1020, 860);
  const ref = c.m(s.media);
  const fitted = containRect(ref, box);
  const overlays: Overlay[] = [];
  if (s.cursor && s.cursor.length >= 2) {
    overlays.push({
      id: `${id}.cursor`,
      kind: "cursor",
      delayMs: 300,
      path: s.cursor.map((p) => ({ x: fitted.x + p.x * fitted.w, y: fitted.y + p.y * fitted.h })),
      clickAtMs: s.clickAtMs,
    });
  }
  const text = [
    c.text(id, "headline", s.headline, "HEADLINE", c.top(G.TOP, 200), { maxLines: 2, delayMs: 80 }),
  ];
  if (s.caption)
    text.push(
      c.text(id, "caption", s.caption, "BODY", c.low(G.CONTENT_BOTTOM - 136, 136), {
        maxLines: 2,
        delayMs: 600,
        color: "inkMuted",
      }),
    );
  return {
    type: "SCREEN_DEMO",
    purpose: "DEMO",
    layout: "screen_demo",
    media: [
      media({
        assetId: s.media,
        slot: "primary",
        box,
        motion: "cinematic_push",
        zoom: [1, 1.04],
        params: s.params,
        animate: s.animate,
      }),
    ],
    text,
    overlays,
    baseMs: 3200,
    showsProduct: c.isProduct(s.media),
    sfx: s.clickAtMs.map((t) => ({ atMs: t + 300, kind: "click" as const })),
    note: "Screen / device demonstration",
  };
}

function stepsBeat(c: Ctx, id: string): Draft | null {
  const s = c.brief.steps;
  if (!s) return null;
  const n = s.items.length;
  const box = rect(G.L, 470, 520, 900);
  const stagger = 650;
  const mediaId = s.media ?? c.brief.heroMedia;
  const animate = s.param
    ? { [s.param]: s.items.map((_, i) => ({ atMs: 300 + i * stagger, value: i + 1 })) }
    : {};
  return {
    type: "PROCESS_STEP",
    purpose: "STEP",
    layout: "steps_row",
    media: [
      media({
        assetId: mediaId,
        slot: "primary",
        box: rect(470, 520, 610, 860),
        crop: c.isProduct(mediaId) ? "contain" : "cover",
        motion: "none",
        params: s.params,
        animate,
      }),
    ],
    text: [c.text(id, "title", s.title, "HEADLINE", c.top(G.TOP, 220), { maxLines: 2, delayMs: 80 })],
    overlays: [
      {
        id: `${id}.steps`,
        kind: "steps",
        delayMs: 300,
        box,
        staggerMs: stagger,
        itemSlots: s.items.map((it, i) =>
          c.slot(id, `step${i + 1}`, it, "BODY", stepRows(box, n)[i]!.text, 2, 300 + i * stagger),
        ),
      },
    ],
    baseMs: 1800 + n * 700,
    maxExtraMs: 1400,
    showsProduct: c.isProduct(mediaId),
    sfx: s.items.map((_, i) => ({ atMs: 300 + i * stagger, kind: "pop" as const, gainDb: -14 })),
    note: `${n} numbered steps synced with media parameter ${s.param ?? "—"}`,
  };
}

function ctaBeat(c: Ctx, id: string): Draft {
  const { brief } = c;
  const panel = c.low(G.CONTENT_BOTTOM - 496, 496);
  const inner = rect(panel.x + 40, panel.y + 40, panel.w - 80, panel.h - 80);
  const buttonBox = rect(inner.x + (c.align === "center" ? (inner.w - 560) / 2 : 0), panel.y + 252, 560, 112);
  const text: TextElement[] = [
    c.text(id, "headline", brief.cta.headline, "HEADLINE", rect(inner.x, inner.y, inner.w, 200), {
      maxLines: 2,
      delayMs: 220,
      color: "surfaceInk",
    }),
  ];
  if (brief.cta.sub)
    text.push(
      c.text(id, "sub", brief.cta.sub, "CAPTION", rect(inner.x, panel.y + panel.h - 96, inner.w, 56), {
        maxLines: 1,
        delayMs: 700,
        color: "surfaceInk",
      }),
    );
  return {
    type: "CTA_CARD",
    purpose: "CTA",
    layout: "cta_card",
    media: [
      media({
        assetId: brief.heroMedia,
        slot: "primary",
        box: rect(150, 236, 780, 600),
        motion: "product_float",
        shadow: true,
        backlight: true,
        params: brief.heroParams,
      }),
    ],
    text,
    overlays: [
      { id: `${id}.panel`, kind: "panel", delayMs: 80, box: panel, tone: "surface", shadow: true },
      {
        id: `${id}.button`,
        kind: "badge",
        delayMs: 480,
        box: buttonBox,
        textSlot: c.slot(id, "button", brief.cta.button, "CTA", buttonBox, 1, 480),
        tone: "accent",
      },
    ],
    baseMs: 2900,
    showsProduct: true,
    transition: "scale_in",
    sfx: [{ atMs: 480, kind: "pop" }],
    note: "CTA card with product",
  };
}

/* ------------------------------------------------------------------ orchestration ---------------- */

function build(step: RecipeStep, c: Ctx, id: string, index: number, prev: Draft | undefined): Draft | null {
  switch (step) {
    case "HOOK":
      return hookBeat(c, id);
    case "PROBLEM":
      return sceneBeat(c, id, "PROBLEM", index === 0);
    case "SOLUTION":
      return sceneBeat(c, id, "SOLUTION", index === 0);
    case "HERO":
      return heroBeat(c, id, prev);
    case "MACRO":
      return macroBeat(c, id);
    case "CALLOUTS":
      return calloutsBeat(c, id);
    case "STAT":
      return statBeat(c, id);
    case "SPECS":
      return listBeat(c, id, "SPECS");
    case "CHECKLIST":
      return listBeat(c, id, "CHECKLIST");
    case "RECAP":
      return listBeat(c, id, "RECAP");
    case "IN_USE":
      return inUseBeat(c, id);
    case "BEFORE_AFTER":
      return beforeAfterBeat(c, id);
    case "SIDE_BY_SIDE":
      return sideBySideBeat(c, id);
    case "SCREEN":
      return screenBeat(c, id);
    case "STEPS":
      return stepsBeat(c, id);
    case "CTA":
      return ctaBeat(c, id);
  }
}

const beatId = (n: number) => `s${String(n).padStart(2, "0")}`;

function quantize(ms: number, gridMs: number): number {
  return Math.max(gridMs, Math.round(ms / gridMs) * gridMs);
}

export function directCreative(brief: CreativeBrief, opts: DirectorOptions = {}): DirectorResult {
  const kit = opts.kit ? STYLE_KITS[opts.kit] : kitForCategory(brief.category);
  const c = new Ctx(brief, kit);
  const recipe = STRUCTURES[brief.structure];
  c.reasons.push(`Kit "${kit.id}" for category "${brief.category}" — ${kit.direction.visualStyle}`);
  c.reasons.push(`Structure ${brief.structure}: ${recipe.description}`);

  // 1. walk the recipe (CTA is always last); top up with fillers if the brief lacked material
  const body = recipe.steps.filter((s) => s !== "CTA");
  const drafts: { step: RecipeStep; draft: Draft }[] = [];
  const tryStep = (step: RecipeStep) => {
    const id = beatId(drafts.length + 1);
    const d = build(step, c, id, drafts.length, drafts[drafts.length - 1]?.draft);
    if (d) drafts.push({ step, draft: d });
    else c.reasons.push(`Skipped ${step}: no material in the brief`);
  };
  for (const step of body) if (drafts.length < MAX_BEATS - 1) tryStep(step);
  for (const step of FILLER_STEPS) {
    if (drafts.length >= MIN_BEATS - 1) break;
    tryStep(step);
  }
  tryStep("CTA");
  if (drafts.length < MIN_BEATS) c.reasons.push(`Only ${drafts.length} beats — brief is thin`);

  // 2. durations: base × pacing, at least the reading time, within kit bounds, on the music grid
  const dir = kit.direction;
  const pace = { fast: 0.92, medium: 1, calm: 1.1 }[dir.pacing];
  const gridMs = Math.round(60_000 / dir.music.bpm / 2);
  const durations = drafts.map(({ draft }) => {
    const reading = Math.max(
      0,
      ...draft.text.map((t) => t.delayMs + readingTimeMs(c.strings[t.slot] ?? "") + 450),
    );
    const raw = Math.max(draft.baseMs * pace, reading);
    const max = dir.beatMs.max + (draft.maxExtraMs ?? 0);
    return Math.min(max, Math.max(dir.beatMs.min, raw));
  });
  const target = Math.min(30_000, Math.max(15_000, brief.targetDurationMs));
  const total = durations.reduce((s, d) => s + d, 0);
  const scale = total > 0 ? target / total : 1;
  const scaled = durations.map((d, i) => {
    const draft = drafts[i]!.draft;
    const max = dir.beatMs.max + (draft.maxExtraMs ?? 0);
    const reading = Math.max(
      0,
      ...draft.text.map((t) => t.delayMs + readingTimeMs(c.strings[t.slot] ?? "") + 300),
    );
    return quantize(
      Math.min(
        max * 1.15,
        Math.max(dir.beatMs.min * 0.85, reading, d * Math.min(1.25, Math.max(0.8, scale))),
      ),
      gridMs,
    );
  });

  // 3. transitions: cut into the hook, then the kit's rotation without immediate repeats
  let rot = 0;
  const transitions: TransitionType[] = drafts.map(({ draft }, i) => {
    if (i === 0) return "cut";
    if (draft.transition && dir.transitions.includes(draft.transition)) return draft.transition;
    let t = dir.transitions[rot % dir.transitions.length]!;
    rot++;
    if (i > 0 && draft.layout === drafts[i - 1]!.draft.layout && t === "cut")
      t = dir.transitions[rot++ % dir.transitions.length]!;
    return t;
  });

  // 4. beats with absolute timing
  let t = 0;
  const beats: VisualBeat[] = drafts.map(({ draft }, i) => {
    const id = beatId(i + 1);
    const transition = transitions[i]!;
    const beat: VisualBeat = {
      id,
      type: draft.type,
      purpose: draft.purpose,
      durationMs: scaled[i]!,
      layout: draft.layout,
      media: draft.media,
      text: draft.text,
      overlays: draft.overlays,
      transitionIn: {
        type: transition,
        durationMs:
          transition === "cut" || transition === "match_cut"
            ? 0
            : transition === "flash"
              ? 160
              : dir.transitionMs,
      },
      background: draft.background ?? "kit",
      camera: draft.camera ?? { zoom: [1, 1], x: [0, 0], y: [0, 0] },
      note: draft.note,
    };
    t += beat.durationMs;
    return beat;
  });
  const durationMs = t;

  // 5. product visibility and hook timing
  const productAt = firstProductMs(beats, c.media);
  c.reasons.push(
    productAt === null
      ? "WARNING: product never shown"
      : `Product first visible at ${(productAt / 1000).toFixed(1)} s`,
  );
  c.reasons.push(
    `${beats.length} beats, ${(durationMs / 1000).toFixed(1)} s, beat grid ${gridMs} ms at ${dir.music.bpm} BPM`,
  );

  // 6. sound design cues (deterministic density thinning)
  const sfx: { atMs: number; kind: SfxKind; gainDb: number }[] = [];
  let start = 0;
  beats.forEach((b, i) => {
    const tr = b.transitionIn.type;
    if (i > 0) {
      if (tr.startsWith("whip")) sfx.push({ atMs: Math.max(0, start - 140), kind: "whoosh", gainDb: -9 });
      else if (tr === "flash") sfx.push({ atMs: start, kind: "impact", gainDb: -10 });
      else if (tr.startsWith("slide") || tr === "mask_wipe")
        sfx.push({ atMs: Math.max(0, start - 60), kind: "swipe", gainDb: -15 });
      else if (tr === "blur" || tr === "fade") sfx.push({ atMs: start, kind: "shimmer", gainDb: -18 });
    }
    for (const cue of drafts[i]!.draft.sfx) {
      if (cue.atMs >= b.durationMs) continue;
      const keep =
        Number.parseInt(fnv1a(`${b.id}:${cue.kind}:${cue.atMs}`).slice(0, 4), 16) / 0xffff < dir.sfxDensity;
      if (keep || cue.kind === "pop")
        sfx.push({ atMs: start + cue.atMs, kind: cue.kind, gainDb: cue.gainDb ?? -11 });
    }
    start += b.durationMs;
  });
  sfx.sort((a, b) => a.atMs - b.atMs);

  // 7. text slot constraints for localization
  const textSlots: Record<string, TextSlotSpec> = {};
  for (const [slot, meta] of Object.entries(c.slotMeta)) {
    const beat = beats.find((b) => b.id === meta.beatId)!;
    const font = kit.tokens.fonts[meta.role];
    const size = kit.tokens.sizes[meta.role];
    const visibleMs = Math.max(400, beat.durationMs - meta.delayMs - meta.exitBeforeEndMs);
    const cap = estimateCapacity(font, meta.box, meta.maxLines, size.min);
    const value = stripEmphasis(c.strings[slot] ?? "");
    textSlots[slot] = {
      role: meta.role,
      maxWords: Math.min(ROLE_MAX_WORDS[meta.role], cap.maxWords + 2),
      maxChars: cap.maxChars,
      maxLines: meta.maxLines,
      minFontSize: size.min,
      maxFontSize: size.max,
      visibleMs,
      maxReadingMs: visibleMs,
      box: { w: meta.box.w, h: meta.box.h },
      locked: value.match(/[0-9][0-9.,:/+×x%-]*\s?[A-Za-z°″"]*/g)?.map((s) => s.trim()) ?? [],
    };
  }
  if (brief.disclosure) {
    c.strings["global.disclosure"] = brief.disclosure;
    textSlots["global.disclosure"] = {
      role: "CAPTION",
      maxWords: 8,
      maxChars: 48,
      maxLines: 1,
      minFontSize: kit.tokens.sizes.CAPTION.min,
      maxFontSize: kit.tokens.sizes.CAPTION.min + 4,
      visibleMs: durationMs,
      maxReadingMs: durationMs,
      box: { w: 600, h: 48 },
      locked: [],
    };
  }

  const placeholderMedia = brief.media.some((m) => m.placeholder || m.demoOnly || m.provenance === "demo");
  const demoOnly = brief.demoOnly || brief.media.some((m) => m.demoOnly);
  if (placeholderMedia) c.reasons.push("Contains placeholder/demo media → never production ready");

  const storyboard: CreativeStoryboard = {
    version: CREATIVE_MODEL_VERSION,
    id: brief.id,
    title: brief.title,
    category: brief.category,
    structure: brief.structure,
    sourceLocale: brief.sourceLocale,
    format: { width: FRAME_WIDTH, height: FRAME_HEIGHT, fps: FRAME_FPS },
    style: kit.tokens,
    media: brief.media,
    beats,
    textSlots,
    global: {
      progressBar: true,
      ...(brief.disclosure ? { disclosureSlot: "global.disclosure" } : {}),
    },
    audio: {
      music: { mood: dir.music.mood, bpm: dir.music.bpm, gainDb: -15 },
      sfx,
      voice: { enabled: false },
    },
    platforms: brief.platforms,
    flags: { placeholderMedia, demoOnly },
    director: {
      version: DIRECTOR_VERSION,
      concept: `${brief.structure.replace(/_/g, " ").toLowerCase()} — ${recipe.description}`,
      hookStrategy: brief.hook.strategy,
      visualStyle: kit.direction.visualStyle,
      pacing: dir.pacing,
      musicMood: dir.music.mood,
      reasons: c.reasons,
    },
  };
  return { storyboard, localePack: { locale: brief.sourceLocale, strings: c.strings } };
}

function firstProductMs(beats: VisualBeat[], mediaById: Map<string, MediaRef>): number | null {
  let start = 0;
  for (const b of beats) {
    const hits = b.media.filter((m) => {
      const ref = mediaById.get(m.assetId);
      return ref ? mediaShowsProduct(ref) : false;
    });
    if (hits.length) return start + Math.min(...hits.map((m) => m.enterMs));
    start += b.durationMs;
  }
  return null;
}

/** When the product first appears (ms) — null when never. Used by QA and the hook check. */
export function productFirstVisibleMs(sb: Pick<CreativeStoryboard, "beats" | "media">): number | null {
  return firstProductMs(sb.beats, new Map(sb.media.map((m) => [m.id, m])));
}
