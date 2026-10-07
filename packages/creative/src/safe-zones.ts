import { FRAME_HEIGHT, FRAME_WIDTH, type PlatformKey, type Rect } from "./model.ts";

/**
 * Platform safe zones (spec §34) at 1080×1920: the areas covered by each app's own UI — header/tabs, the action
 * rail on the right, the caption/description block at the bottom. Text, CTAs and critical product details must
 * stay out of them; imagery may extend underneath.
 *
 * Values are conservative approximations of the 2025–2026 app layouts. Verify against current screenshots before
 * relying on them for a new platform version.
 */
export interface UnsafeRect extends Rect {
  label: string;
}

export interface SafeZoneSpec {
  platform: PlatformKey;
  unsafe: UnsafeRect[];
  /** minimum distance of any text from the frame edges */
  edgeMargin: number;
}

const r = (label: string, x: number, y: number, w: number, h: number): UnsafeRect => ({ label, x, y, w, h });

export const SAFE_ZONES: Record<PlatformKey, SafeZoneSpec> = {
  TIKTOK: {
    platform: "TIKTOK",
    edgeMargin: 64,
    unsafe: [
      r("header (Following / For You)", 0, 0, 1080, 150),
      r("action rail (like, comment, share)", 940, 700, 140, 950),
      r("caption, sound and profile", 0, 1460, 1080, 460),
    ],
  },
  INSTAGRAM: {
    platform: "INSTAGRAM",
    edgeMargin: 64,
    unsafe: [
      r("header (Reels / camera)", 0, 0, 1080, 140),
      r("action rail", 950, 880, 130, 820),
      r("caption and audio", 0, 1530, 1080, 390),
    ],
  },
  FACEBOOK: {
    platform: "FACEBOOK",
    edgeMargin: 64,
    unsafe: [
      r("header", 0, 0, 1080, 150),
      r("action rail", 940, 860, 140, 840),
      r("caption and page name", 0, 1490, 1080, 430),
    ],
  },
  YOUTUBE_SHORTS: {
    platform: "YOUTUBE_SHORTS",
    edgeMargin: 64,
    unsafe: [
      r("header / search", 0, 0, 1080, 140),
      r("action rail", 930, 880, 150, 820),
      r("title and channel", 0, 1500, 1080, 420),
    ],
  },
};

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export interface SafeZoneViolation {
  platform: PlatformKey;
  zone: string;
  element: string;
  /** overlapping area in px² */
  overlap: number;
}

/** Check rectangles (text boxes as actually measured, CTA, labels) against the zones of every target platform. */
export function checkSafeZones(
  elements: { id: string; rect: Rect }[],
  platforms: readonly PlatformKey[],
  frame = { width: FRAME_WIDTH, height: FRAME_HEIGHT },
): SafeZoneViolation[] {
  const out: SafeZoneViolation[] = [];
  for (const p of platforms) {
    const spec = SAFE_ZONES[p];
    const sx = frame.width / FRAME_WIDTH;
    const sy = frame.height / FRAME_HEIGHT;
    const m = spec.edgeMargin * sx;
    const inner: Rect = { x: m, y: m, w: frame.width - 2 * m, h: frame.height - 2 * m };
    for (const el of elements) {
      for (const z of spec.unsafe) {
        const zone = { x: z.x * sx, y: z.y * sy, w: z.w * sx, h: z.h * sy };
        const hit = intersection(el.rect, zone);
        if (hit) out.push({ platform: p, zone: z.label, element: el.id, overlap: Math.round(hit.w * hit.h) });
      }
      if (!contains(inner, el.rect))
        out.push({ platform: p, zone: "frame edge margin", element: el.id, overlap: 0 });
    }
  }
  return out;
}

/**
 * The area that is safe on every listed platform, as horizontal bands (the right rail only covers the lower
 * part of the frame, so text near the top may use the full width).
 */
export function safeBands(platforms: readonly PlatformKey[]): {
  top: number;
  bottom: number;
  left: number;
  right: number;
  railTop: number;
  rightBelowRail: number;
} {
  const specs = platforms.map((p) => SAFE_ZONES[p]);
  const top = Math.max(
    ...specs.map((s) => Math.max(s.edgeMargin, ...s.unsafe.filter((u) => u.y === 0).map((u) => u.h))),
  );
  const bottom = Math.min(
    ...specs.map((s) =>
      Math.min(
        FRAME_HEIGHT - s.edgeMargin,
        ...s.unsafe.filter((u) => u.y + u.h >= FRAME_HEIGHT && u.y > 0).map((u) => u.y),
      ),
    ),
  );
  const rails = specs.flatMap((s) =>
    s.unsafe.filter((u) => u.x > 0 && u.x + u.w >= FRAME_WIDTH && u.y > 0 && u.y + u.h < FRAME_HEIGHT),
  );
  const left = Math.max(...specs.map((s) => s.edgeMargin));
  const right = FRAME_WIDTH - left;
  return {
    top,
    bottom,
    left,
    right,
    railTop: rails.length ? Math.min(...rails.map((u) => u.y)) : FRAME_HEIGHT,
    rightBelowRail: rails.length ? Math.min(...rails.map((u) => u.x)) : right,
  };
}
