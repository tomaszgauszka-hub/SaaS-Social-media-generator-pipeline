import type { Overlay, Rect } from "./model.ts";

/**
 * Geometry of composite overlays, shared by the resolver (which measures their text) and the renderer (which
 * draws them) so both always agree on every text box.
 */
export function listRows(box: Rect, n: number): Rect[] {
  const rowH = Math.min(100, box.h / Math.max(1, n));
  return Array.from({ length: n }, (_, i) => ({ x: box.x, y: box.y + i * rowH, w: box.w, h: rowH }));
}

/** checklist row: check icon on the left, text box to its right */
export function checklistItemBox(row: Rect): { icon: Rect; text: Rect } {
  const icon = Math.min(56, row.h * 0.66);
  return {
    icon: { x: row.x, y: row.y + (row.h - icon) / 2, w: icon, h: icon },
    text: { x: row.x + icon + 26, y: row.y, w: row.w - icon - 26, h: row.h },
  };
}

/** spec list row: label left half, value right half (value right-aligned) */
export function specRowBoxes(row: Rect): { label: Rect; value: Rect } {
  const split = row.w * 0.52;
  return {
    label: { x: row.x, y: row.y, w: split - 12, h: row.h },
    value: { x: row.x + split, y: row.y, w: row.w - split, h: row.h },
  };
}

export function stepRows(box: Rect, n: number): { badge: Rect; text: Rect; row: Rect }[] {
  const rowH = box.h / Math.max(1, n);
  return Array.from({ length: n }, (_, i) => {
    const row = { x: box.x, y: box.y + i * rowH, w: box.w, h: rowH };
    const badge = Math.min(76, rowH * 0.6);
    return {
      row,
      badge: { x: row.x, y: row.y + 8, w: badge, h: badge },
      text: { x: row.x + badge + 22, y: row.y + 4, w: row.w - badge - 22, h: rowH - 16 },
    };
  });
}

/** counter: number box, unit box and (gauge) dial geometry */
export function counterLayout(o: Extract<Overlay, { kind: "counter" }>): {
  number: Rect;
  unit: Rect;
  dial?: { cx: number; cy: number; r: number };
} {
  const b = o.box;
  if (o.style === "gauge") {
    const r = Math.min(b.w, b.h) / 2;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return {
      dial: { cx, cy, r },
      number: { x: cx - r * 0.72, y: cy - r * 0.42, w: r * 1.44, h: r * 0.62 },
      unit: { x: cx - r * 0.6, y: cy + r * 0.24, w: r * 1.2, h: r * 0.24 },
    };
  }
  const numberH = o.style === "bar" ? b.h * 0.72 : b.h;
  return {
    number: { x: b.x, y: b.y, w: b.w * 0.74, h: numberH },
    unit: { x: b.x, y: b.y + numberH - b.h * 0.2, w: b.w * 0.4, h: b.h * 0.2 },
  };
}

export function timerLayout(o: Extract<Overlay, { kind: "timer" }>): { digits: Rect; label: Rect } {
  return {
    digits: { x: o.box.x + o.box.h + 18, y: o.box.y, w: o.box.w - o.box.h - 18, h: o.box.h },
    label: { x: o.box.x, y: o.box.y - 64, w: Math.max(o.box.w, 420), h: 56 },
  };
}
