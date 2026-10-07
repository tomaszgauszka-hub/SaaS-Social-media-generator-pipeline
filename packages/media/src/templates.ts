import type { MotionType, TextAnimation, TransitionType } from "./schema.ts";

/**
 * Branded render templates. Brand colours/fonts come from the Brand; templates define layout, typography
 * scale, motion and transition style. Sizes are ratios of the frame width so layouts scale to any resolution.
 */
export interface TemplatePreset {
  key: string;
  name: string;
  headline: {
    sizeRatio: number;
    minRatio: number;
    maxLines: number;
    uppercase: boolean;
    outlineRatio: number;
    shadow: number;
    animation: TextAnimation;
  };
  body: {
    sizeRatio: number;
    minRatio: number;
    maxLines: number;
    animation: TextAnimation;
    outlineRatio: number;
  };
  list: { sizeRatio: number; animation: TextAnimation; staggerMs: number; bullet: string };
  cta: { sizeRatio: number; buttonTextRatio: number; animation: TextAnimation };
  badge: { sizeRatio: number };
  subtitles: { sizeRatio: number; maxWords: number; maxChars: number; style: "word_pop" | "line" };
  disclosure: { sizeRatio: number };
  motion: { image: MotionType; intensity: number; productFloat: boolean };
  transition: { type: TransitionType; durationMs: number; ctaType: TransitionType };
  darkenImages: number;
  vignette: boolean;
}

export const TEMPLATES: Record<string, TemplatePreset> = {
  "vertical-bold": {
    key: "vertical-bold",
    name: "Vertical Bold",
    headline: {
      sizeRatio: 0.084,
      minRatio: 0.054,
      maxLines: 4,
      uppercase: true,
      outlineRatio: 0.0065,
      shadow: 0,
      animation: "pop",
    },
    body: { sizeRatio: 0.054, minRatio: 0.04, maxLines: 4, animation: "slide_up", outlineRatio: 0.0045 },
    list: { sizeRatio: 0.05, animation: "slide_up", staggerMs: 380, bullet: "✓" },
    cta: { sizeRatio: 0.078, buttonTextRatio: 0.05, animation: "pop" },
    badge: { sizeRatio: 0.046 },
    subtitles: { sizeRatio: 0.062, maxWords: 3, maxChars: 20, style: "word_pop" },
    disclosure: { sizeRatio: 0.031 },
    motion: { image: "kenburns", intensity: 0.14, productFloat: true },
    transition: { type: "slideleft", durationMs: 280, ctaType: "fadeblack" },
    darkenImages: 0.38,
    vignette: true,
  },
  "vertical-clean": {
    key: "vertical-clean",
    name: "Vertical Clean",
    headline: {
      sizeRatio: 0.074,
      minRatio: 0.05,
      maxLines: 4,
      uppercase: false,
      outlineRatio: 0.0035,
      shadow: 2,
      animation: "slide_up",
    },
    body: { sizeRatio: 0.05, minRatio: 0.038, maxLines: 4, animation: "fade", outlineRatio: 0.003 },
    list: { sizeRatio: 0.047, animation: "fade", staggerMs: 420, bullet: "•" },
    cta: { sizeRatio: 0.07, buttonTextRatio: 0.046, animation: "slide_up" },
    badge: { sizeRatio: 0.042 },
    subtitles: { sizeRatio: 0.056, maxWords: 4, maxChars: 24, style: "word_pop" },
    disclosure: { sizeRatio: 0.03 },
    motion: { image: "zoom_in", intensity: 0.1, productFloat: true },
    transition: { type: "fade", durationMs: 380, ctaType: "fade" },
    darkenImages: 0.3,
    vignette: false,
  },
};

export const DEFAULT_TEMPLATE_KEY = "vertical-bold";

export function getTemplate(key: string | undefined | null): TemplatePreset {
  return (key ? TEMPLATES[key] : undefined) ?? TEMPLATES[DEFAULT_TEMPLATE_KEY]!;
}

/* ---------------------------------------------------------------- colour helpers ------------------ */

function parseHex(hex: string): [number, number, number] {
  const c = hex.replace(/^#/, "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

/** Linear mix of two colours (t = 0 → a, t = 1 → b). */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Readable text colour (white or near-black) on a given background. */
export function readableOn(bg: string): string {
  return contrastRatio("#FFFFFF", bg) >= contrastRatio("#111111", bg) ? "#FFFFFF" : "#111111";
}
