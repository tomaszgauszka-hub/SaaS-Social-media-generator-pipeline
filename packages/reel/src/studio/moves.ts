import type { ShotPreset, ShotTechnique } from "../contracts/ids.ts";
import type { NormRect } from "../contracts/media.ts";
import type { ShotParams } from "../contracts/plan.ts";
import type { Rect } from "../contracts/profiles.ts";

/*
 * 2-D camera moves on a Blender plate (pure math, shared by the FFmpeg argument builder and the product track).
 *
 * The studio renders a plate `overscan` × larger than the composed frame, with the composed frame exactly in its
 * centre. A move is a crop WINDOW over the plate as a function of t ∈ [0, 1]:
 *
 *   zoom z(t)   window size relative to the composed frame (1 = composed, 1.1 = 10 % wider)
 *   dx, dy(t)   window centre offset in composed-frame units (+x right, +y down)
 *
 * so in plate-normalised coordinates the window is  size s = z / overscan,  centre (0.5 + dx/o, 0.5 + dy/o).
 * The same functions exist as FFmpeg expressions (exprs) — the unit tests check both agree.
 */

export type Easing = "linear" | "inOut" | "out" | "punch";

export interface PlateMove {
  kind: "push" | "pull" | "slide" | "rise" | "punch" | "drift" | "hold";
  /** start → end zoom (composed frame = 1) */
  zoom: [number, number];
  /** start → end window centre offset (composed-frame units) */
  dx: [number, number];
  dy: [number, number];
  easing: Easing;
}

/** Normalised crop window on the plate: left/top corner and size (share of the plate width / height). */
export interface CropWindow {
  x: number;
  y: number;
  s: number;
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** ease_out_back of tools/blender/studio/shotlib.py (overshoot 1.4) */
function easeOutBack(t: number, k = 1.4): number {
  const u = clamp01(t) - 1;
  return 1 + u * u * ((k + 1) * u + k);
}

/** Progress 0 → 1 of a move (punch overshoots slightly past 1 and settles back). */
export function ease(easing: Easing, t: number): number {
  const x = clamp01(t);
  switch (easing) {
    case "linear":
      return x;
    case "inOut":
      return 0.5 - 0.5 * Math.cos(Math.PI * x);
    case "out":
      return 1 - (1 - x) ** 3;
    case "punch":
      // fast punch-in over the first 28 % (ease-out-back), then a slow 2 % creep
      return x < 0.28 ? easeOutBack(x / 0.28) : 1 + (0.02 * (x - 0.28)) / 0.72;
  }
}

/** The same easing as an FFmpeg expression of `t` (an expression string already clamped to [0, 1]). */
export function easeExpr(easing: Easing, t: string): string {
  switch (easing) {
    case "linear":
      return `(${t})`;
    case "inOut":
      return `(0.5-0.5*cos(PI*(${t})))`;
    case "out":
      return `(1-pow(1-(${t}),3))`;
    case "punch": {
      const u = `(min(${t}/0.28,1)-1)`;
      return `if(lt(${t},0.28),1+${u}*${u}*(2.4*${u}+1.4),1+0.02*(${t}-0.28)/0.72)`;
    }
  }
}

/** Presets whose move is a push-in, with the push amount at intensity 0 and 1 (zoom ratio − 1). */
const PUSH: Partial<Record<ShotPreset, { at0: number; at1: number; easing: Easing }>> = {
  hero_reveal: { at0: 0.08, at1: 0.18, easing: "out" },
  macro_push: { at0: 0.08, at1: 0.18, easing: "inOut" },
  feature_highlight: { at0: 0.06, at1: 0.16, easing: "inOut" },
  silhouette_reveal: { at0: 0.05, at1: 0.13, easing: "out" },
  top_down: { at0: 0.04, at1: 0.1, easing: "inOut" },
  technical_cutaway: { at0: 0.08, at1: 0.16, easing: "inOut" },
  exploded_view: { at0: 0.04, at1: 0.08, easing: "inOut" },
  parts_reveal: { at0: 0.04, at1: 0.08, easing: "inOut" },
  assembly: { at0: 0.06, at1: 0.12, easing: "out" },
  cta_hero: { at0: 0.03, at1: 0.07, easing: "inOut" },
};

/**
 * The FFmpeg move of a plate (or relight) shot, from its preset and bounded params. Every amplitude is a fixed
 * function of `intensity` and stays within the plate's default overscan (1.18). Relight shots get a subtle push
 * only — the light switching on is the event.
 */
export function plateMove(
  preset: ShotPreset,
  params: Pick<ShotParams, "intensity" | "angleDeg">,
  technique: ShotTechnique = "plate",
): PlateMove {
  const i = clamp01(params.intensity);
  const still = { dx: [0, 0] as [number, number], dy: [0, 0] as [number, number] };
  if (technique === "relight")
    return { kind: "drift", zoom: [1.03 + 0.04 * i, 1], ...still, easing: "inOut" };
  const push = PUSH[preset];
  if (push)
    return { kind: "push", zoom: [1 + lerp(push.at0, push.at1, i), 1], ...still, easing: push.easing };
  switch (preset) {
    case "macro_pull":
      return { kind: "pull", zoom: [1, 1 + lerp(0.08, 0.18, i)], ...still, easing: "inOut" };
    case "camera_slide":
    case "detail_closeup": {
      // camera trucks across the set; direction as in shotlib (towards the side the product faces)
      const side = params.angleDeg <= 0 ? 1 : -1;
      const d = preset === "camera_slide" ? lerp(0.035, 0.075, i) : lerp(0.02, 0.045, i);
      return { kind: "slide", zoom: [1, 1], dx: [-side * d, side * d], dy: [0, 0], easing: "inOut" };
    }
    case "low_angle": {
      // the camera rises a little while easing in: the product grows into the frame
      const d = lerp(0.02, 0.045, i);
      return { kind: "rise", zoom: [1.04, 1], dx: [0, 0], dy: [d, -d], easing: "inOut" };
    }
    case "impact":
      return { kind: "punch", zoom: [1 + lerp(0.1, 0.17, i), 1], ...still, easing: "punch" };
    case "assembly":
    case "cta_hero":
    case "exploded_view":
    case "feature_highlight":
    case "floating_product":
    case "hero_reveal":
    case "light_sweep":
    case "macro_push":
    case "orbit":
    case "parts_reveal":
    case "product_drop":
    case "silhouette_reveal":
    case "slow_turntable":
    case "technical_cutaway":
    case "top_down":
    case "turntable":
      // presets that normally render real frames (turntable, orbit, drop …) but were planned as a plate
      return { kind: "drift", zoom: [1 + lerp(0.02, 0.05, i), 1], ...still, easing: "inOut" };
  }
}

/** Smallest overscan that keeps the window inside the plate during the whole move. */
export function requiredOverscan(move: PlateMove): number {
  let need = 1;
  for (let k = 0; k <= 64; k++) {
    const st = moveState(move, k / 64);
    need = Math.max(need, st.z + 2 * Math.abs(st.dx), st.z + 2 * Math.abs(st.dy));
  }
  return Math.round(need * 1e4) / 1e4;
}

/** Largest sideways shift of the window during the move (composed-frame widths) — the margin the framing keeps. */
export function windowTravelX(move: PlateMove): number {
  let travel = 0;
  for (let k = 0; k <= 64; k++) travel = Math.max(travel, Math.abs(moveState(move, k / 64).dx));
  // rounded up: never less margin than the move needs
  return Math.max(0, Math.ceil(travel * 1e4 - 1e-6) / 1e4);
}

function moveState(move: PlateMove, t: number): { z: number; dx: number; dy: number } {
  const e = ease(move.easing, t);
  return {
    z: lerp(move.zoom[0], move.zoom[1], e),
    dx: lerp(move.dx[0], move.dx[1], e),
    dy: lerp(move.dy[0], move.dy[1], e),
  };
}

/** Crop window on the plate at t (plate-normalised). */
export function windowAt(move: PlateMove, overscan: number, t: number): CropWindow {
  const { z, dx, dy } = moveState(move, t);
  const s = z / overscan;
  return { x: 0.5 + dx / overscan - s / 2, y: 0.5 + dy / overscan - s / 2, s };
}

const num = (v: number) => {
  const r = Math.round(v * 1e7) / 1e7;
  return Object.is(r, -0) ? "0" : String(r);
};

/**
 * FFmpeg expressions of the window's left / top / right / bottom edges (plate-normalised) as functions of the
 * progress expression `t`. Constant parts are folded so the per-frame cost stays tiny.
 */
export function windowExprs(
  move: PlateMove,
  overscan: number,
  t: string,
): { left: string; top: string; right: string; bottom: string } {
  const e = easeExpr(move.easing, t);
  const term = (a: number, b: number, scale: number) =>
    a === b ? num(a * scale) : `(${num(a * scale)}+${num((b - a) * scale)}*${e})`;
  const half = term(move.zoom[0], move.zoom[1], 0.5 / overscan);
  const cx = `(0.5+${term(move.dx[0], move.dx[1], 1 / overscan)})`;
  const cy = `(0.5+${term(move.dy[0], move.dy[1], 1 / overscan)})`;
  return {
    left: `(${cx}-${half})`,
    right: `(${cx}+${half})`,
    top: `(${cy}-${half})`,
    bottom: `(${cy}+${half})`,
  };
}

/** A box on the plate (normalised) → pixels on the output frame for a crop window. */
export function boxThroughWindow(box: NormRect, win: CropWindow, width: number, height: number): Rect {
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    x: r(((box.x - win.x) / win.s) * width),
    y: r(((box.y - win.y) / win.s) * height),
    w: Math.max(0.1, r((box.w / win.s) * width)),
    h: Math.max(0.1, r((box.h / win.s) * height)),
  };
}

/** Sample times (ms, clip-local) of a product track: every `stepMs` and the last frame. */
export function trackTimes(durationMs: number, fps: number, stepMs = 100): number[] {
  const last = Math.max(0, Math.round(((Math.round((durationMs * fps) / 1000) - 1) * 1000) / fps));
  const out: number[] = [];
  for (let t = 0; t < last; t += stepMs) out.push(t);
  out.push(last);
  return out;
}
