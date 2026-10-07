import { FRAME_HEIGHT, FRAME_WIDTH, type MediaRef, type Point, type Rect } from "./model.ts";

/**
 * Layout geometry for the 1080×1920 master frame. All text zones sit inside the area that is safe on TikTok,
 * Instagram Reels and Facebook Reels at once (see safe-zones.ts): below 150 px, above 1460 px, ≥ 64 px from the
 * edges, and left of the action rail (x ≤ 940) from y = 700 down.
 */
export const G = {
  W: FRAME_WIDTH,
  H: FRAME_HEIGHT,
  /** left text edge */
  L: 72,
  /** right text edge above the action rail */
  R_TOP: 1008,
  /** right text edge alongside the action rail */
  R_LOW: 924,
  /** y where the action rail starts */
  RAIL_Y: 700,
  /** first text pixel */
  TOP: 184,
  /** last text pixel */
  BOTTOM: 1436,
  /** last pixel of beat content — the band below is reserved for the disclosure line */
  CONTENT_BOTTOM: 1364,
  /** disclosure band (always readable, never covered by beat content) */
  DISCLOSURE_Y: 1388,
  DISCLOSURE_H: 48,
} as const;

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** Text zone across the top (full width is safe above the rail). */
export function topZone(y: number, h: number, align: "left" | "center"): Rect {
  return align === "center" ? rect(G.L, y, G.R_TOP - G.L, h) : rect(G.L, y, G.R_TOP - G.L, h);
}

/** Text zone in the lower part of the frame (must stay left of the rail; centred kits stay symmetric). */
export function lowerZone(y: number, h: number, align: "left" | "center"): Rect {
  if (align === "center") {
    const half = Math.min(G.W / 2 - G.L, G.R_LOW - G.W / 2);
    return rect(G.W / 2 - half, y, half * 2, h);
  }
  return rect(G.L, y, G.R_LOW - G.L, h);
}

/** Where media of the given aspect lands inside `box` with `contain` fitting. */
export function containRect(media: Pick<MediaRef, "width" | "height">, box: Rect): Rect {
  const s = Math.min(box.w / media.width, box.h / media.height);
  const w = media.width * s;
  const h = media.height * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Where media lands with `cover` fitting (may exceed the box; the renderer clips). */
export function coverRect(media: Pick<MediaRef, "width" | "height">, box: Rect, focus?: Point): Rect {
  const s = Math.max(box.w / media.width, box.h / media.height);
  const w = media.width * s;
  const h = media.height * s;
  const fx = focus?.x ?? 0.5;
  const fy = focus?.y ?? 0.5;
  const x = clamp(box.x + box.w / 2 - fx * w, box.x + box.w - w, box.x);
  const y = clamp(box.y + box.h / 2 - fy * h, box.y + box.h - h, box.y);
  return { x, y, w, h };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Screen position of a named media anchor for a contained media frame. */
export function anchorOnScreen(
  media: MediaRef,
  box: Rect,
  anchor: string,
  fit: "contain" | "cover" = "contain",
): Point {
  const a = media.anchors[anchor];
  if (!a) throw new Error(`Media ${media.id} has no anchor "${anchor}"`);
  const r = fit === "contain" ? containRect(media, box) : coverRect(media, box);
  return { x: r.x + a.x * r.w, y: r.y + a.y * r.h };
}

/**
 * Macro framing: the renderer scales the media by `zoom` around the anchor and places the anchor at `at`.
 * Returns the media box (frame-sized) and the anchor's on-screen point — overlays use it.
 */
export function macroFraming(at: Point = { x: G.W / 2, y: 820 }): { box: Rect; anchorAt: Point } {
  return { box: rect(0, 0, G.W, G.H), anchorAt: at };
}

/**
 * Distribute callout label boxes in a column, ordered by target y, at least `gap` apart and inside [top, bottom].
 */
export function stackLabels(
  targetsY: number[],
  opts: { top: number; bottom: number; height: number; gap: number },
): number[] {
  const order = targetsY.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const ys: number[] = new Array<number>(targetsY.length);
  let cursor = opts.top;
  for (const { y, i } of order) {
    const want = Math.max(cursor, y - opts.height / 2);
    ys[i] = want;
    cursor = want + opts.height + opts.gap;
  }
  // shift the column up if it overflows the bottom
  const overflow = Math.max(0, cursor - opts.gap - opts.bottom);
  if (overflow > 0) for (let k = 0; k < ys.length; k++) ys[k] = Math.max(opts.top, ys[k]! - overflow);
  return ys;
}
