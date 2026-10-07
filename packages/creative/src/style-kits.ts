import type {
  FontSpec,
  MotionPreset,
  MusicMood,
  StyleTokens,
  TextAnimation,
  TextRole,
  TransitionType,
} from "./model.ts";

/**
 * Category visual languages (spec §37). A kit is a starting point the director applies deterministically — not a
 * hard-coded theme: brands can override tokens, and the director varies layouts per beat.
 */
export type KitId = "tools" | "gadgets" | "home" | "automotive" | "beauty" | "pet" | "general";

export interface KitDirection {
  pacing: "fast" | "medium" | "calm";
  /** typical beat duration bounds (ms) */
  beatMs: { min: number; max: number };
  /** transitions used between beats, rotated in order */
  transitions: TransitionType[];
  transitionMs: number;
  motion: { hero: MotionPreset; macro: MotionPreset; inUse: MotionPreset; background: MotionPreset };
  textAnimation: { display: TextAnimation; body: TextAnimation };
  music: { mood: MusicMood; bpm: number };
  /** 0–1: how many SFX accents to place */
  sfxDensity: number;
  visualStyle: string;
}

export interface StyleKit {
  id: KitId;
  label: string;
  tokens: StyleTokens;
  direction: KitDirection;
}

type Roles<T> = Record<TextRole, T>;

const font = (family: string, weight: number, extra: Partial<FontSpec> = {}): FontSpec => ({
  family,
  weight,
  style: "normal",
  letterSpacing: 0,
  transform: "none",
  lineHeight: 1.06,
  ...extra,
});

const sizes = (s: Partial<Roles<[number, number]>>): Roles<{ min: number; max: number }> => {
  const d: Roles<[number, number]> = {
    DISPLAY: [84, 140],
    HEADLINE: [56, 96],
    BODY: [38, 52],
    CAPTION: [30, 38],
    SUBTITLE: [44, 60],
    STAT: [120, 260],
    SPEC: [30, 44],
    CTA: [42, 60],
    ...s,
  };
  return Object.fromEntries(Object.entries(d).map(([k, [min, max]]) => [k, { min, max }])) as Roles<{
    min: number;
    max: number;
  }>;
};

export const STYLE_KITS: Record<KitId, StyleKit> = {
  tools: {
    id: "tools",
    label: "Workshop — contrast, specs, quick cuts",
    tokens: {
      kit: "tools",
      palette: {
        bg: "#15171A",
        bg2: "#24272C",
        surface: "#F2EFE6",
        surfaceInk: "#15171A",
        ink: "#F5F3EE",
        inkMuted: "#AEB2B8",
        accent: "#FFC21A",
        accentInk: "#15171A",
        accent2: "#FF6B1A",
        line: "#3A3E44",
        glow: "#FFE7A3",
      },
      fonts: {
        DISPLAY: font("Barlow Condensed", 800, {
          transform: "uppercase",
          lineHeight: 0.9,
          letterSpacing: 0.004,
        }),
        HEADLINE: font("Barlow Condensed", 700, { transform: "uppercase", lineHeight: 0.94 }),
        BODY: font("Inter", 500, { lineHeight: 1.22 }),
        CAPTION: font("Inter", 700, { transform: "uppercase", letterSpacing: 0.08, lineHeight: 1.15 }),
        SUBTITLE: font("Inter", 700, { lineHeight: 1.15 }),
        STAT: font("Barlow Condensed", 800, { lineHeight: 0.84 }),
        SPEC: font("Barlow Condensed", 700, { transform: "uppercase", letterSpacing: 0.02, lineHeight: 1.0 }),
        CTA: font("Barlow Condensed", 800, { transform: "uppercase", letterSpacing: 0.01, lineHeight: 0.95 }),
      },
      sizes: sizes({
        DISPLAY: [100, 196],
        HEADLINE: [70, 124],
        STAT: [150, 300],
        SPEC: [36, 58],
        CTA: [52, 80],
      }),
      radius: 6,
      background: { kind: "workshop", intensity: 1 },
      motion: { energy: 0.85, ease: "snappy", transitionMs: 220 },
      overlayStyle: "industrial",
      textAlign: "left",
      displaySkew: 0,
      grain: 0.05,
      vignette: 0.45,
    },
    direction: {
      pacing: "fast",
      beatMs: { min: 1700, max: 3200 },
      transitions: ["whip_left", "cut", "whip_up", "cut", "flash", "whip_right"],
      transitionMs: 220,
      motion: { hero: "whip_in", macro: "macro_drift", inUse: "cinematic_push", background: "slow_zoom" },
      textAnimation: { display: "mask_up", body: "slide_left" },
      music: { mood: "drive", bpm: 124 },
      sfxDensity: 0.9,
      visualStyle: "Dark workshop, safety-yellow tags, dimension lines, hard cuts on the beat",
    },
  },
  gadgets: {
    id: "gadgets",
    label: "Tech — clean, fast, UI and spec overlays",
    tokens: {
      kit: "gadgets",
      palette: {
        bg: "#0A0E15",
        bg2: "#121A26",
        surface: "#F4F7FB",
        surfaceInk: "#0A0E15",
        ink: "#F3F6FA",
        inkMuted: "#8E9AAD",
        accent: "#38E0FF",
        accentInk: "#03141B",
        accent2: "#B8F34B",
        line: "#26313F",
        glow: "#9BEFFF",
      },
      fonts: {
        DISPLAY: font("Space Grotesk", 700, { letterSpacing: -0.025, lineHeight: 0.98 }),
        HEADLINE: font("Space Grotesk", 600, { letterSpacing: -0.02, lineHeight: 1.0 }),
        BODY: font("Inter", 500, { lineHeight: 1.25 }),
        CAPTION: font("Space Grotesk", 500, { transform: "uppercase", letterSpacing: 0.14, lineHeight: 1.1 }),
        SUBTITLE: font("Inter", 700, { lineHeight: 1.15 }),
        STAT: font("Space Grotesk", 700, { letterSpacing: -0.04, lineHeight: 0.9 }),
        SPEC: font("Space Grotesk", 500, { letterSpacing: 0.01, lineHeight: 1.05 }),
        CTA: font("Space Grotesk", 700, { letterSpacing: -0.01, lineHeight: 1.0 }),
      },
      sizes: sizes({ DISPLAY: [84, 136], STAT: [130, 250], SPEC: [30, 46] }),
      radius: 22,
      background: { kind: "tech_grid", intensity: 1 },
      motion: { energy: 0.7, ease: "snappy", transitionMs: 240 },
      overlayStyle: "tech",
      textAlign: "left",
      displaySkew: 0,
      grain: 0.03,
      vignette: 0.35,
    },
    direction: {
      pacing: "fast",
      beatMs: { min: 1900, max: 3300 },
      transitions: ["slide_left", "scale_in", "slide_up", "cut", "mask_wipe", "slide_left"],
      transitionMs: 260,
      motion: { hero: "tilt_in", macro: "macro_drift", inUse: "cinematic_push", background: "pan_left" },
      textAnimation: { display: "word_stagger", body: "rise" },
      music: { mood: "tech", bpm: 118 },
      sfxDensity: 0.7,
      visualStyle: "Near-black tech grid, cyan pointer lines, glass cards, precise snappy motion",
    },
  },
  home: {
    id: "home",
    label: "Home — bright interiors, before/after, diagrams",
    tokens: {
      kit: "home",
      palette: {
        bg: "#F4EFE7",
        bg2: "#E6DCCD",
        surface: "#FFFFFF",
        surfaceInk: "#2A2622",
        ink: "#2A2622",
        inkMuted: "#6E665D",
        accent: "#B86E0E",
        accentInk: "#FFFFFF",
        accent2: "#5E8C6A",
        line: "#D6CABA",
        glow: "#FFD28A",
      },
      fonts: {
        DISPLAY: font("Manrope", 800, { letterSpacing: -0.03, lineHeight: 1.0 }),
        HEADLINE: font("Manrope", 800, { letterSpacing: -0.025, lineHeight: 1.02 }),
        BODY: font("Manrope", 500, { lineHeight: 1.3 }),
        CAPTION: font("Manrope", 700, { transform: "uppercase", letterSpacing: 0.12, lineHeight: 1.1 }),
        SUBTITLE: font("Manrope", 700, { lineHeight: 1.2 }),
        STAT: font("Manrope", 800, { letterSpacing: -0.04, lineHeight: 0.92 }),
        SPEC: font("Manrope", 600, { lineHeight: 1.15 }),
        CTA: font("Manrope", 800, { letterSpacing: -0.01, lineHeight: 1.05 }),
      },
      sizes: sizes({ DISPLAY: [80, 128], STAT: [120, 230] }),
      radius: 30,
      background: { kind: "clean_home", intensity: 1 },
      motion: { energy: 0.45, ease: "smooth", transitionMs: 340 },
      overlayStyle: "soft",
      textAlign: "left",
      displaySkew: 0,
      grain: 0.025,
      vignette: 0.15,
    },
    direction: {
      pacing: "medium",
      beatMs: { min: 2200, max: 3600 },
      transitions: ["fade", "slide_up", "mask_wipe", "blur", "slide_left", "fade"],
      transitionMs: 380,
      motion: { hero: "drop_in", macro: "slow_zoom", inUse: "pan_right", background: "none" },
      textAnimation: { display: "rise", body: "rise" },
      music: { mood: "chill", bpm: 96 },
      sfxDensity: 0.45,
      visualStyle: "Warm bright interiors, soft rounded cards, dotted diagram lines, calm reveals",
    },
  },
  automotive: {
    id: "automotive",
    label: "Automotive — dynamic, details, performance",
    tokens: {
      kit: "automotive",
      palette: {
        bg: "#0F1012",
        bg2: "#1C1D21",
        surface: "#ECEDEF",
        surfaceInk: "#0F1012",
        ink: "#F7F7F8",
        inkMuted: "#9EA1A7",
        accent: "#FF3131",
        accentInk: "#FFFFFF",
        accent2: "#FFB000",
        line: "#2F3137",
        glow: "#FF8A80",
      },
      fonts: {
        DISPLAY: font("Saira Condensed", 800, { transform: "uppercase", lineHeight: 0.9 }),
        HEADLINE: font("Saira Condensed", 700, { transform: "uppercase", lineHeight: 0.95 }),
        BODY: font("Inter", 500, { lineHeight: 1.22 }),
        CAPTION: font("Saira Condensed", 600, {
          transform: "uppercase",
          letterSpacing: 0.14,
          lineHeight: 1.05,
        }),
        SUBTITLE: font("Inter", 700, { lineHeight: 1.15 }),
        STAT: font("Saira Condensed", 800, { lineHeight: 0.85 }),
        SPEC: font("Saira Condensed", 600, { transform: "uppercase", letterSpacing: 0.04, lineHeight: 1.0 }),
        CTA: font("Saira Condensed", 800, { transform: "uppercase", letterSpacing: 0.02, lineHeight: 0.95 }),
      },
      sizes: sizes({
        DISPLAY: [100, 190],
        HEADLINE: [70, 120],
        STAT: [150, 300],
        SPEC: [36, 56],
        CTA: [52, 78],
      }),
      radius: 4,
      background: { kind: "asphalt", intensity: 1 },
      motion: { energy: 0.95, ease: "snappy", transitionMs: 200 },
      overlayStyle: "racing",
      textAlign: "left",
      displaySkew: -8,
      grain: 0.045,
      vignette: 0.5,
    },
    direction: {
      pacing: "fast",
      beatMs: { min: 1600, max: 3000 },
      transitions: ["whip_right", "flash", "whip_left", "cut", "whip_up", "cut"],
      transitionMs: 200,
      motion: { hero: "whip_in", macro: "macro_drift", inUse: "pan_left", background: "pan_left" },
      textAnimation: { display: "slide_left", body: "slide_left" },
      music: { mood: "drive", bpm: 132 },
      sfxDensity: 1,
      visualStyle: "Asphalt and carbon, red racing slants, gauges, speed streaks, whip pans",
    },
  },
  beauty: {
    id: "beauty",
    label: "Beauty — clean, premium, soft light",
    tokens: {
      kit: "beauty",
      palette: {
        bg: "#F6ECE7",
        bg2: "#EAD6CE",
        surface: "#FFFFFF",
        surfaceInk: "#3A2626",
        ink: "#3A2626",
        inkMuted: "#8C716B",
        accent: "#A8644A",
        accentInk: "#FFFFFF",
        accent2: "#D7B38E",
        line: "#E0CBC2",
        glow: "#FFF3DF",
      },
      fonts: {
        DISPLAY: font("Playfair Display", 500, { style: "italic", letterSpacing: -0.012, lineHeight: 1.04 }),
        HEADLINE: font("Playfair Display", 500, { letterSpacing: -0.01, lineHeight: 1.06 }),
        BODY: font("Jost", 400, { lineHeight: 1.32 }),
        CAPTION: font("Jost", 500, { transform: "uppercase", letterSpacing: 0.24, lineHeight: 1.1 }),
        SUBTITLE: font("Jost", 500, { lineHeight: 1.2 }),
        STAT: font("Playfair Display", 500, { lineHeight: 0.95 }),
        SPEC: font("Jost", 500, { transform: "uppercase", letterSpacing: 0.18, lineHeight: 1.1 }),
        CTA: font("Jost", 500, { transform: "uppercase", letterSpacing: 0.2, lineHeight: 1.0 }),
      },
      sizes: sizes({
        DISPLAY: [80, 128],
        HEADLINE: [56, 92],
        SPEC: [28, 40],
        CTA: [36, 48],
        CAPTION: [26, 34],
      }),
      radius: 44,
      background: { kind: "studio_soft", intensity: 1 },
      motion: { energy: 0.25, ease: "smooth", transitionMs: 480 },
      overlayStyle: "hairline",
      textAlign: "center",
      displaySkew: 0,
      grain: 0.02,
      vignette: 0.12,
    },
    direction: {
      pacing: "calm",
      beatMs: { min: 2400, max: 3800 },
      transitions: ["blur", "fade", "mask_wipe", "blur", "fade", "scale_in"],
      transitionMs: 520,
      motion: { hero: "slow_zoom", macro: "macro_drift", inUse: "parallax", background: "none" },
      textAnimation: { display: "rise", body: "rise" },
      music: { mood: "elegant", bpm: 84 },
      sfxDensity: 0.35,
      visualStyle: "Blush studio light, serif italics, hairline gold rules, slow luminous motion",
    },
  },
  pet: {
    id: "pet",
    label: "Pet — warm, approachable, practical",
    tokens: {
      kit: "pet",
      palette: {
        bg: "#FFF3E3",
        bg2: "#FFE1BA",
        surface: "#FFFFFF",
        surfaceInk: "#3B2A1E",
        ink: "#3B2A1E",
        inkMuted: "#7B6453",
        accent: "#E2541B",
        accentInk: "#FFFFFF",
        accent2: "#1E9E90",
        line: "#EFCFA6",
        glow: "#FFE7B8",
      },
      fonts: {
        DISPLAY: font("Nunito", 900, { letterSpacing: -0.02, lineHeight: 1.0 }),
        HEADLINE: font("Nunito", 900, { letterSpacing: -0.015, lineHeight: 1.02 }),
        BODY: font("Nunito", 700, { lineHeight: 1.25 }),
        CAPTION: font("Nunito", 800, { transform: "uppercase", letterSpacing: 0.1, lineHeight: 1.1 }),
        SUBTITLE: font("Nunito", 800, { lineHeight: 1.15 }),
        STAT: font("Nunito", 900, { letterSpacing: -0.03, lineHeight: 0.92 }),
        SPEC: font("Nunito", 800, { lineHeight: 1.1 }),
        CTA: font("Nunito", 900, { lineHeight: 1.0 }),
      },
      sizes: sizes({ DISPLAY: [84, 136], STAT: [120, 230] }),
      radius: 38,
      background: { kind: "warm_home", intensity: 1 },
      motion: { energy: 0.6, ease: "springy", transitionMs: 300 },
      overlayStyle: "rounded",
      textAlign: "center",
      displaySkew: 0,
      grain: 0.025,
      vignette: 0.15,
    },
    direction: {
      pacing: "medium",
      beatMs: { min: 2000, max: 3400 },
      transitions: ["scale_in", "slide_left", "fade", "slide_up", "scale_in", "mask_wipe"],
      transitionMs: 320,
      motion: { hero: "drop_in", macro: "slow_zoom", inUse: "cinematic_push", background: "none" },
      textAnimation: { display: "pop", body: "rise" },
      music: { mood: "warm", bpm: 104 },
      sfxDensity: 0.6,
      visualStyle: "Warm cream and orange, rounded bubbles, friendly springy motion, clear before/after",
    },
  },
  general: {
    id: "general",
    label: "General — neutral product video",
    tokens: {
      kit: "general",
      palette: {
        bg: "#111317",
        bg2: "#1D2027",
        surface: "#F6F6F4",
        surfaceInk: "#111317",
        ink: "#F6F6F4",
        inkMuted: "#A3A7AE",
        accent: "#F5D547",
        accentInk: "#111317",
        accent2: "#5AD1A0",
        line: "#30343C",
        glow: "#FFF1B0",
      },
      fonts: {
        DISPLAY: font("Inter", 800, { letterSpacing: -0.03, lineHeight: 1.0 }),
        HEADLINE: font("Inter", 700, { letterSpacing: -0.02, lineHeight: 1.04 }),
        BODY: font("Inter", 500, { lineHeight: 1.25 }),
        CAPTION: font("Inter", 700, { transform: "uppercase", letterSpacing: 0.1, lineHeight: 1.1 }),
        SUBTITLE: font("Inter", 700, { lineHeight: 1.15 }),
        STAT: font("Inter", 800, { letterSpacing: -0.04, lineHeight: 0.9 }),
        SPEC: font("Inter", 600, { lineHeight: 1.1 }),
        CTA: font("Inter", 800, { lineHeight: 1.0 }),
      },
      sizes: sizes({}),
      radius: 20,
      background: { kind: "plain", intensity: 1 },
      motion: { energy: 0.6, ease: "smooth", transitionMs: 280 },
      overlayStyle: "tech",
      textAlign: "left",
      displaySkew: 0,
      grain: 0.03,
      vignette: 0.3,
    },
    direction: {
      pacing: "medium",
      beatMs: { min: 2000, max: 3400 },
      transitions: ["slide_left", "fade", "scale_in", "slide_up"],
      transitionMs: 300,
      motion: { hero: "cinematic_push", macro: "slow_zoom", inUse: "pan_right", background: "none" },
      textAnimation: { display: "rise", body: "rise" },
      music: { mood: "upbeat", bpm: 110 },
      sfxDensity: 0.5,
      visualStyle: "Neutral dark product video",
    },
  },
};

const CATEGORY_TO_KIT: Record<string, KitId> = {
  tools: "tools",
  diy: "tools",
  hardware: "tools",
  gadgets: "gadgets",
  electronics: "gadgets",
  tech: "gadgets",
  home: "home",
  kitchen: "home",
  automotive: "automotive",
  car: "automotive",
  beauty: "beauty",
  cosmetics: "beauty",
  pet: "pet",
  pets: "pet",
};

/** Deterministic kit selection from a product category. */
export function kitForCategory(category: string | null | undefined): StyleKit {
  const key = (category ?? "").toLowerCase().trim();
  const direct = CATEGORY_TO_KIT[key];
  if (direct) return STYLE_KITS[direct];
  const partial = Object.entries(CATEGORY_TO_KIT).find(([k]) => key.includes(k));
  return STYLE_KITS[partial?.[1] ?? "general"];
}

/** Every font face the kits use (for font registration and the renderer). */
export function kitFontFaces(tokens: StyleTokens): FontSpec[] {
  const seen = new Map<string, FontSpec>();
  for (const f of Object.values(tokens.fonts)) seen.set(`${f.family}|${f.weight}|${f.style}`, f);
  return [...seen.values()];
}
