import type { Rect } from "../contracts/profiles.ts";
import { decodeRaw } from "../util/raw.ts";

/**
 * Product accuracy on the delivered video: the rendered product region must keep the colours of the real product
 * (catalog palette). Lighting shifts colours, so the test is tolerant (CIE76 ΔE ≤ 30 for at least half of the
 * catalog colours) — it catches a wrong material / texture / colour variant, not grading.
 */

type RGB = [number, number, number];

function toLab([r, g, b]: RGB): RGB {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE(a: RGB, b: RGB): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

export const hexToRgb = (hex: string): RGB => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

/** deterministic k-means (k clusters, luminance-rank init) → cluster centres with their share */
export function dominantColors(px: Buffer, k = 5): { rgb: RGB; share: number }[] {
  const pts: RGB[] = [];
  for (let i = 0; i + 2 < px.length; i += 3) pts.push([px[i]!, px[i + 1]!, px[i + 2]!]);
  if (!pts.length) return [];
  const sorted = [...pts].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  let centers: RGB[] = Array.from(
    { length: k },
    (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)]!,
  );
  let counts = new Array<number>(k).fill(0);
  for (let it = 0; it < 10; it++) {
    const sums = centers.map(() => [0, 0, 0]);
    counts = new Array<number>(k).fill(0);
    for (const p of pts) {
      let best = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const c = centers[j]!;
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      sums[best]![0]! += p[0];
      sums[best]![1]! += p[1];
      sums[best]![2]! += p[2];
      counts[best]!++;
    }
    centers = centers.map((c, j) =>
      counts[j] ? (sums[j]!.map((s) => Math.round(s / counts[j]!)) as RGB) : c,
    );
  }
  return centers.map((rgb, j) => ({ rgb, share: counts[j]! / pts.length })).sort((a, b) => b.share - a.share);
}

export interface ColorCheck {
  passed: boolean;
  note: string;
  rendered: string[];
  matches: { expected: string; nearest: string; deltaE: number }[];
}

export function compareToPalette(
  rendered: { rgb: RGB; share: number }[],
  expected: readonly string[],
  maxDeltaE = 30,
): ColorCheck {
  const hex = (c: RGB) =>
    `#${c
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  const usable = rendered.filter((r) => r.share >= 0.03);
  const matches = expected.map((e) => {
    const target = hexToRgb(e);
    const best = usable.reduce(
      (acc, r) => {
        const d = deltaE(target, r.rgb);
        return d < acc.d ? { d, c: r.rgb } : acc;
      },
      { d: Infinity, c: [0, 0, 0] as RGB },
    );
    return { expected: e, nearest: hex(best.c), deltaE: Math.round(best.d * 10) / 10 };
  });
  const ok = matches.filter((m) => m.deltaE <= maxDeltaE).length;
  const passed = expected.length === 0 || ok >= Math.ceil(expected.length / 2);
  return {
    passed,
    rendered: usable.map((r) => hex(r.rgb)),
    matches,
    note: `${ok}/${expected.length} catalog colours found in the rendered product (ΔE ≤ ${maxDeltaE})`,
  };
}

export async function checkRenderedColors(opts: {
  videoPath: string;
  atMs: number;
  rect: Rect;
  expectedPalette: readonly string[];
  workDir?: string;
  frame?: { width: number; height: number };
}): Promise<ColorCheck> {
  const W = opts.frame?.width ?? 1080;
  const H = opts.frame?.height ?? 1920;
  const r = opts.rect;
  const x = Math.max(0, Math.min(W - 4, Math.round(r.x)));
  const y = Math.max(0, Math.min(H - 4, Math.round(r.y)));
  const w = Math.max(4, Math.min(W - x, Math.round(r.w)));
  const h = Math.max(4, Math.min(H - y, Math.round(r.h)));
  const px = await decodeRaw(opts.videoPath, `crop=${w}:${h}:${x}:${y},scale=48:48:flags=area,format=rgb24`, {
    seekMs: opts.atMs,
  });
  return compareToPalette(dominantColors(px), opts.expectedPalette);
}
