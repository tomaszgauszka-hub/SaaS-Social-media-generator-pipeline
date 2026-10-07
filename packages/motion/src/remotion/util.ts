import type { Keyframes, Palette, ParamValue, TextColor } from "@cre/creative";

/** Pure helpers for the compositions (deterministic: no Math.random, no Date). */
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inCubic: (t: number) => t ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  outQuint: (t: number) => 1 - (1 - t) ** 5,
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number, s = 1.6) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
  inOutQuart: (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
};

/** 0→1 progress of a window [start, start+dur] at time `ms`, eased */
export function prog(
  ms: number,
  start: number,
  dur: number,
  fn: (t: number) => number = ease.outCubic,
): number {
  if (dur <= 0) return ms >= start ? 1 : 0;
  return fn(clamp01((ms - start) / dur));
}

/** damped spring 0→1 (approximation, deterministic) */
export function spring(
  ms: number,
  start: number,
  opts: { stiffness?: number; damping?: number } = {},
): number {
  const t = Math.max(0, (ms - start) / 1000);
  const k = opts.stiffness ?? 170;
  const d = opts.damping ?? 16;
  const w = Math.sqrt(k);
  const zeta = d / (2 * w);
  if (t === 0) return 0;
  if (zeta < 1) {
    const wd = w * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w * t) * (1 + w * t);
}

/** value of keyframed parameter at beat-local time (smoothstep between keys) */
export function keyframeAt(kfs: Keyframes, ms: number): number {
  if (ms <= kfs[0]!.atMs) return kfs[0]!.value;
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1]!;
    const b = kfs[i]!;
    if (ms <= b.atMs) {
      const t = (ms - a.atMs) / Math.max(1, b.atMs - a.atMs);
      return lerp(a.value, b.value, t * t * (3 - 2 * t));
    }
  }
  return kfs[kfs.length - 1]!.value;
}

export function resolveParams(
  base: Record<string, ParamValue>,
  over: Record<string, ParamValue>,
  animate: Record<string, Keyframes>,
  ms: number,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = { ...base, ...over };
  for (const [k, kfs] of Object.entries(animate)) out[k] = keyframeAt(kfs, ms);
  return out;
}

export function num(params: Record<string, ParamValue>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : fallback;
}

export function str(params: Record<string, ParamValue>, key: string, fallback: string): string {
  const v = params[key];
  return typeof v === "string" ? v : fallback;
}

/** mulberry32 — seeded PRNG */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const c = x.map((v, i) => Math.round(lerp(v, y[i]!, t)));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** relative luminance (WCAG) */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export const isDark = (hex: string) => luminance(hex) < 0.22;

export function textColor(p: Palette, c: TextColor): string {
  switch (c) {
    case "ink":
      return p.ink;
    case "inkMuted":
      return p.inkMuted;
    case "accent":
      return p.accent;
    case "surfaceInk":
      return p.surfaceInk;
    case "accentInk":
      return p.accentInk;
    case "onMedia":
      return "#FFFFFF";
  }
}

/** private font-family alias — system fonts with the same name can never shadow the measured files */
export const fontAlias = (family: string) => `cre-${family.replace(/\s+/g, "-")}`;
