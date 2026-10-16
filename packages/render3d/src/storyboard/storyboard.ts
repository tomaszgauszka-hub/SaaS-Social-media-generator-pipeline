import {
  CreativeStoryboard,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  type MediaRef,
  type Overlay,
  type VisualBeat,
  type VisualBeatType,
} from "@cre/creative";
import type { Asset3D } from "../contracts/asset.ts";
import { defaultRecipe, type MaterialType3D, type Recipe3DInput } from "../contracts/recipe.ts";

/*
 * Storyboard ⇄ 3D clips.
 *
 *   plan3dRequests: which beats get a 3D clip, of which material type and recipe (beat-type defaults, or the
 *                   beat's explicit `asset3d` request) — framed so the beat's text slots stay clear;
 *   apply3dClips:   swaps each beat's primary media for its clip (full frame, the clip carries its own camera
 *                   move) and registers the clip as a MediaRef with provenance, licence and anchors.
 *
 * Text slots, LocalePacks, overlays, audio and the CTA are untouched: the same 3D clips serve every locale.
 */

const BEAT_MATERIAL: Partial<Record<VisualBeatType, MaterialType3D>> = {
  HOOK_VISUAL: "3D_PRODUCT_HERO",
  PRODUCT_HERO: "3D_PRODUCT_HERO",
  PRODUCT_MACRO: "3D_MACRO",
  FEATURE_CALLOUT: "3D_MACRO",
  SPEC_CALLOUT: "3D_EXPLODED_VIEW",
  PRODUCT_IN_USE: "3D_LIFESTYLE",
  PROCESS_STEP: "3D_ASSEMBLY",
  SOLUTION_VISUAL: "3D_TECHNICAL",
  CTA_CARD: "3D_TURNTABLE",
};

const STRUCTURAL: readonly MaterialType3D[] = ["3D_EXPLODED_VIEW", "3D_ASSEMBLY", "3D_TECHNICAL"];

export interface ClipRequest {
  beatId: string;
  materialType: MaterialType3D;
  recipe: Recipe3DInput;
}

export interface PlanOptions {
  /** environment of lifestyle beats (e.g. "workshop" for tools, "bathroom" for beauty) */
  environment?: "kitchen" | "bathroom" | "workshop" | "living_room" | "desk" | "garage";
  quality?: "preview" | "production";
  /** clip resolution (default: the storyboard format) */
  resolution?: [number, number];
  /** only these beat types get 3D (default: every mapped type) */
  only?: VisualBeatType[];
}

/** Overlays drawn in their own boxes (panels, lists, counters): the product must stay clear of them too. */
const BOXED_OVERLAYS = new Set(["panel", "spec_list", "counter", "badge", "checklist", "steps", "timer"]);
/** Overlays tied to the geometry of the media they were drawn for (their points are not the 3D clip's). */
const GEOMETRY_OVERLAYS = new Set(["highlight", "particles", "light_sweep", "measure", "arrow", "slider"]);

/** Text boxes + boxed overlays of a beat (frame px). */
export function occupiedBoxes(beat: VisualBeat): { y: number; h: number }[] {
  const boxes: { y: number; h: number }[] = beat.text.map((t) => t.box);
  for (const o of beat.overlays)
    if (BOXED_OVERLAYS.has(o.kind) && "box" in o && o.box) boxes.push(o.box);
  return boxes;
}

/**
 * Where the product sits so the beat's text and panels stay clear: the centre of the largest free vertical band
 * (centerY) and how much of the frame height it may fill.
 */
export function textAwareFraming(beat: VisualBeat, defaultFill: number): { centerY: number; fill?: number } {
  const boxes = occupiedBoxes(beat);
  if (!boxes.length) return { centerY: 0.5 };
  const top = boxes
    .filter((b) => b.y + b.h / 2 < FRAME_HEIGHT / 2)
    .reduce((m, b) => Math.max(m, b.y + b.h), 0);
  const bottom = boxes
    .filter((b) => b.y + b.h / 2 >= FRAME_HEIGHT / 2)
    .reduce((m, b) => Math.min(m, b.y), FRAME_HEIGHT);
  const centerY = Math.min(0.66, Math.max(0.36, (top + bottom) / 2 / FRAME_HEIGHT));
  const room = (0.86 * Math.max(0, bottom - top)) / FRAME_HEIGHT;
  const fill = Math.max(0.25, Math.min(defaultFill, room));
  return fill < defaultFill ? { centerY, fill: Math.round(fill * 100) / 100 } : { centerY };
}

/** Legacy helper: centre height only. */
export function textAwareCenterY(beat: VisualBeat): number {
  return textAwareFraming(beat, 1).centerY;
}

/** 2D demo-illustration anchor names → parts of the 3D models (same product, other drawing). */
export const ANCHOR_ALIASES: Record<string, string> = {
  gear: "gear_selector",
  gauge: "charge_gauge",
  handle: "housing",
  vents: "housing",
  base: "battery",
  spf: "label",
  tube: "body",
};

const DEFAULT_FILL: Partial<Record<MaterialType3D, number>> = {
  "3D_PRODUCT_HERO": 0.6,
  "3D_TURNTABLE": 0.58,
  "3D_EXPLODED_VIEW": 0.66,
  "3D_ASSEMBLY": 0.42,
  "3D_LIFESTYLE": 0.46,
  "3D_TECHNICAL": 0.74,
};

export function plan3dRequests(
  sb: CreativeStoryboard,
  product: Asset3D,
  opts: PlanOptions = {},
): ClipRequest[] {
  const out: ClipRequest[] = [];
  let macroIndex = 0;
  const partNames = new Set(product.parts.map((p) => p.name));
  const focusParts = product.parts.filter(
    (p) => !p.internal && (p.role === "detail" || p.role === "control"),
  );
  for (const beat of sb.beats) {
    if (opts.only && !opts.only.includes(beat.type)) continue;
    let mt = beat.asset3d?.materialType ?? BEAT_MATERIAL[beat.type];
    if (!mt) continue;
    if (STRUCTURAL.includes(mt) && !product.structureVerified) mt = "3D_TURNTABLE"; // never invent a construction
    const base = defaultRecipe(mt, product.assetId);
    const durationSec = Math.min(
      20,
      Math.max(1, Math.round(((beat.asset3d?.durationMs ?? beat.durationMs) + 300) / 100) / 10),
    );
    // macro focus: the beat's own focus anchor (mapped onto the model's parts), else the next detail part
    const primaryFocus = beat.media.find((m) => m.slot === "primary")?.focus;
    const mapped = primaryFocus
      ? partNames.has(primaryFocus)
        ? primaryFocus
        : ANCHOR_ALIASES[primaryFocus]
      : undefined;
    let focus = beat.asset3d?.focus ?? (mapped && partNames.has(mapped) ? mapped : undefined);
    if (!focus && mt === "3D_MACRO" && focusParts.length)
      focus = focusParts[macroIndex++ % focusParts.length]!.name;
    const recipe: Recipe3DInput = {
      ...base,
      durationSec,
      fps: sb.format.fps,
      resolution: opts.resolution ?? [sb.format.width, sb.format.height],
      quality: opts.quality ?? "preview",
      framing: textAwareFraming(beat, DEFAULT_FILL[mt] ?? 0.6),
      ...(focus && mt === "3D_MACRO" ? { focus } : {}),
      ...(mt === "3D_LIFESTYLE" && opts.environment
        ? { environment: { preset: opts.environment }, background: { preset: "environment" } }
        : {}),
    };
    out.push({ beatId: beat.id, materialType: mt, recipe });
  }
  return out;
}

export interface PlacedClip {
  beatId: string;
  asset: Asset3D;
  /** URL / storage key the renderer loads the clip from */
  src: string;
  /** anchors at the clip's middle frame (normalised) */
  anchors?: Record<string, { x: number; y: number }>;
}

export function clipMediaRef(c: PlacedClip): MediaRef {
  const a = c.asset;
  const [w, h] = a.resolution ?? [FRAME_WIDTH, FRAME_HEIGHT];
  const provenance: MediaRef["provenance"] = a.isDemoOnly
    ? "demo"
    : a.isProductVerified
      ? "owned"
      : "generated";
  return {
    id: `${a.assetId}`,
    kind: "video",
    src: c.src,
    width: w,
    height: h,
    hasAlpha: false,
    role:
      a.materialType === "3D_LIFESTYLE"
        ? "scene"
        : a.materialType === "3D_MACRO"
          ? "product_detail"
          : "product",
    provenance,
    placeholder: false,
    demoOnly: a.isDemoOnly,
    license: `${a.license} (rendered ${a.engine} ${a.engineVersion ?? ""})`.trim(),
    anchors: c.anchors ?? {},
    params: {},
    showsProduct: true,
    description: `3D ${a.materialType ?? "clip"} · ${a.fidelity}${a.isDemoOnly ? " · DEMO_ONLY" : ""}`,
    render3d: {
      assetId: a.assetId,
      materialType: a.materialType ?? "3D_PRODUCT_HERO",
      recipeHash: a.recipeHash ?? "",
      engine: a.engine === "unreal" ? "unreal" : "blender",
      fidelity: a.fidelity,
      illustrative: a.materialType === "3D_TECHNICAL",
    },
  };
}

/** Anchors (normalised) at the middle frame of a clip's anchor tracks. */
export function midAnchors(
  tracks: Record<string, ([number, number] | null)[]>,
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const [k, t] of Object.entries(tracks)) {
    const p = t[Math.floor(t.length / 2)];
    if (p && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1) out[k] = { x: p[0], y: p[1] };
  }
  return out;
}

/** Name of the media anchor closest to a canvas point (the anchor a callout was drawn for). */
export function nearestAnchor(
  ref: Pick<MediaRef, "anchors">,
  box: { x: number; y: number; w: number; h: number },
  p: { x: number; y: number },
): string | null {
  let best: string | null = null;
  let dist = Infinity;
  for (const [name, a] of Object.entries(ref.anchors)) {
    const d = Math.hypot(box.x + a.x * box.w - p.x, box.y + a.y * box.h - p.y);
    if (d < dist) {
      dist = d;
      best = name;
    }
  }
  return dist <= 0.12 * Math.max(box.w, box.h) ? best : null;
}

/**
 * The storyboard with each placed beat showing its 3D clip full frame. Text slots, boxed overlays (panels, lists,
 * counters, badges), audio and the CTA are unchanged; overlays bound to the old media's geometry are remapped or
 * dropped.
 */
export function apply3dClips(sb: CreativeStoryboard, clips: readonly PlacedClip[]): CreativeStoryboard {
  const byBeat = new Map(clips.map((c) => [c.beatId, c]));
  const media = [...sb.media];
  const beats = sb.beats.map((beat) => {
    const clip = byBeat.get(beat.id);
    if (!clip) return beat;
    const ref = clipMediaRef(clip);
    if (!media.some((m) => m.id === ref.id)) media.push(ref);
    const others = beat.media.filter((m) => m.slot !== "primary" && m.slot !== "background");
    // overlays drawn for the old media's geometry do not match the clip: callouts are moved to the clip's anchor
    // of the same part (when the clip tracks it), the other geometry-bound overlays are dropped
    const oldPrimary = beat.media.find((m) => m.slot === "primary");
    const oldRef = oldPrimary ? sb.media.find((m) => m.id === oldPrimary.assetId) : undefined;
    const overlays = beat.overlays.flatMap((o): Overlay[] => {
      if (GEOMETRY_OVERLAYS.has(o.kind)) return [];
      if (o.kind !== "callout") return [o];
      const name = oldRef && oldPrimary ? nearestAnchor(oldRef, oldPrimary.box, o.target) : null;
      const part = name ? (ref.anchors[name] ? name : ANCHOR_ALIASES[name]) : null;
      const p = part ? ref.anchors[part] : undefined;
      return p ? [{ ...o, target: { x: p.x * FRAME_WIDTH, y: p.y * FRAME_HEIGHT } }] : [];
    });
    return {
      ...beat,
      background: "media" as const,
      camera: {
        zoom: [1, 1] as [number, number],
        x: [0, 0] as [number, number],
        y: [0, 0] as [number, number],
      },
      media: [
        {
          assetId: ref.id,
          slot: "primary" as const,
          box: { x: 0, y: 0, w: FRAME_WIDTH, h: FRAME_HEIGHT },
          crop: "cover" as const,
          zoom: [1, 1] as [number, number],
          motion: "none" as const,
          shadow: false,
          backlight: false,
          rotate: 0,
          params: {},
          animate: {},
          enterMs: 0,
          opacity: 1,
        },
        ...others,
      ],
      overlays,
      note: `${beat.note} · 3D ${ref.render3d?.materialType} ${ref.id}`.trim(),
    };
  });
  const usedIds = new Set(beats.flatMap((b) => b.media.map((m) => m.assetId)));
  const keptMedia = media.filter((m) => usedIds.has(m.id) || m.kind === "vector");
  const demoOnly = sb.flags.demoOnly || clips.some((c) => c.asset.isDemoOnly);
  return CreativeStoryboard.parse({
    ...sb,
    media: keptMedia.length ? keptMedia : media,
    beats,
    flags: { ...sb.flags, demoOnly },
  });
}
