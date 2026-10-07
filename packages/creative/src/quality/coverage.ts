import { containRect } from "../layouts.ts";
import type { BeatMedia, CreativeStoryboard, MediaRef, Rect, RenderPlan } from "../model.ts";

/**
 * Visual coverage (deterministic, from the render plan): for every 100 ms of the reel, how much of the frame
 * carries meaningful imagery — product, product detail, demonstration, context scene, diagram, UI or comparison.
 * Kit backgrounds, gradients and text cards do not count.
 */
const DIAGRAM_OVERLAYS = new Set([
  "counter",
  "callout",
  "slider",
  "measure",
  "steps",
  "cursor",
  "icon_chip",
  "highlight",
]);
/** frame share above which a moment counts as image-led */
export const MEANINGFUL_SHARE = 0.15;
/** with an information graphic on screen, a smaller image share is enough */
export const DIAGRAM_SHARE = 0.06;
/** below this share, without an information graphic, the frame is a text card (a thumbnail does not change that) */
export const TEXT_CARD_SHARE = 0.12;

export interface BeatCoverage {
  beatId: string;
  visualShare: number;
  meaningfulMs: number;
  textOnlyMs: number;
  durationMs: number;
}

export interface VisualCoverage {
  meaningfulVisualCoverage: number;
  textOnlyDurationRatio: number;
  beats: BeatCoverage[];
}

function intersectArea(r: Rect, W: number, H: number): number {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(W, r.x + r.w);
  const y1 = Math.min(H, r.y + r.h);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function layerArea(ref: MediaRef, m: BeatMedia, W: number, H: number): number {
  if (m.opacity < 0.3) return 0;
  if (m.crop === "cover" || m.crop === "macro" || m.crop === "focus") return intersectArea(m.box, W, H);
  const r = containRect(ref, m.box);
  const z = m.zoom[0];
  const cx = m.box.x + m.box.w / 2;
  const cy = m.box.y + m.box.h / 2;
  return intersectArea({ x: cx + (r.x - cx) * z, y: cy + (r.y - cy) * z, w: r.w * z, h: r.h * z }, W, H);
}

export function visualCoverage(
  sb: Pick<CreativeStoryboard, "media">,
  plan: RenderPlan,
  stepMs = 100,
): VisualCoverage {
  const W = plan.format.width;
  const H = plan.format.height;
  const refs = new Map(sb.media.map((m) => [m.id, m]));
  const beats: BeatCoverage[] = plan.beats.map((b) => ({
    beatId: b.id,
    visualShare: 0,
    meaningfulMs: 0,
    textOnlyMs: 0,
    durationMs: b.durationMs,
  }));
  let meaningful = 0;
  let textOnly = 0;
  let samples = 0;
  for (let t = 0; t < plan.durationMs; t += stepMs) {
    let bi = 0;
    for (let i = 0; i < plan.beats.length; i++) if (plan.beats[i]!.startMs <= t) bi = i;
    const beat = plan.beats[bi]!;
    const local = t - beat.startMs;
    let area = 0;
    for (const m of beat.media) {
      if (local < m.enterMs) continue;
      const ref = refs.get(m.assetId);
      if (!ref || ref.role === "background") continue;
      area += layerArea(ref, m, W, H);
    }
    const share = Math.min(1, area / (W * H));
    const diagram = beat.overlays.some((o) => DIAGRAM_OVERLAYS.has(o.kind) && local >= o.delayMs);
    const isMeaningful = share >= MEANINGFUL_SHARE || (diagram && share >= DIAGRAM_SHARE);
    const isTextOnly = share < TEXT_CARD_SHARE && !diagram;
    const bc = beats[bi]!;
    bc.visualShare = Math.max(bc.visualShare, share);
    if (isMeaningful) {
      meaningful++;
      bc.meaningfulMs += stepMs;
    }
    if (isTextOnly) {
      textOnly++;
      bc.textOnlyMs += stepMs;
    }
    samples++;
  }
  return {
    meaningfulVisualCoverage: samples ? meaningful / samples : 0,
    textOnlyDurationRatio: samples ? textOnly / samples : 0,
    beats,
  };
}
