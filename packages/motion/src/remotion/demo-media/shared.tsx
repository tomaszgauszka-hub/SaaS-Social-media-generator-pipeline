import type { Palette, ParamValue } from "@cre/creative";
import type React from "react";
import { useId } from "react";

/** Props every parametric illustration receives (drawn inside an <svg viewBox="0 0 width height">). */
export interface VectorProps {
  params: Record<string, ParamValue>;
  /** beat-local time */
  ms: number;
  beatMs: number;
  palette: Palette;
}

export interface VectorDef {
  Component: React.FC<VectorProps>;
}

/**
 * Instance-unique ids for gradients / masks / patterns — the same illustration can be on screen twice (before /
 * after, transitions), and SVG ids are document-global.
 */
export function useIds(): { id: (name: string) => string; url: (name: string) => string } {
  const raw = useId().replace(/[^a-zA-Z0-9]/g, "");
  return { id: (name) => `v${raw}${name}`, url: (name) => `url(#v${raw}${name})` };
}

type Stop = [offset: number, color: string, opacity?: number];

export const Lin: React.FC<{
  id: string;
  stops: Stop[];
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  units?: "objectBoundingBox" | "userSpaceOnUse";
}> = ({ id, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1, units = "objectBoundingBox" }) => (
  <linearGradient id={id} x1={x1} y1={y1} x2={x2} y2={y2} gradientUnits={units}>
    {stops.map(([o, c, a], i) => (
      <stop key={i} offset={o} stopColor={c} stopOpacity={a ?? 1} />
    ))}
  </linearGradient>
);

export const Rad: React.FC<{
  id: string;
  stops: Stop[];
  cx?: number | string;
  cy?: number | string;
  r?: number | string;
  fx?: number | string;
  fy?: number | string;
  units?: "objectBoundingBox" | "userSpaceOnUse";
}> = ({ id, stops, cx = 0.5, cy = 0.5, r = 0.5, fx, fy, units = "objectBoundingBox" }) => (
  <radialGradient id={id} cx={cx} cy={cy} r={r} fx={fx ?? cx} fy={fy ?? cy} gradientUnits={units}>
    {stops.map(([o, c, a], i) => (
      <stop key={i} offset={o} stopColor={c} stopOpacity={a ?? 1} />
    ))}
  </radialGradient>
);

/** Cylinder shading across the short axis (dark rim → highlight → dark rim). */
export function cylStops(base: string, light: string, dark: string): Stop[] {
  return [
    [0, dark],
    [0.18, base],
    [0.36, light],
    [0.52, base],
    [0.86, dark],
    [1, dark],
  ];
}

export const FONT = "cre-Inter, sans-serif";

/** deterministic scatter in a rect (golden-ratio sequence + hashing) */
export function scatter(
  n: number,
  x: number,
  y: number,
  w: number,
  h: number,
  seed = 1,
): { x: number; y: number; k: number }[] {
  const out: { x: number; y: number; k: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = fract(Math.sin((i + 1) * 12.9898 * seed + 78.233) * 43758.5453);
    const b = fract((i + 1) * 0.6180339887 + seed * 0.137);
    const k = fract(Math.sin((i + 3) * 39.3468 * seed) * 12345.678);
    out.push({ x: x + b * w, y: y + a * h, k });
  }
  return out;
}

const fract = (v: number) => v - Math.floor(v);

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
