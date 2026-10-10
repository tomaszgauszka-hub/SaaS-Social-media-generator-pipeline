import { z } from "zod";
import {
  BlenderProfile,
  LightingPreset,
  ProductAnimation,
  ShotPreset,
  ShotTechnique,
  type SfxKind,
  StudioEnvironment,
} from "./ids.ts";
import { ShotParams } from "./plan.ts";
import type { Rect } from "./profiles.ts";

/* ================================================================== Blender studio job =========== */
/*
 * The JSON contract between the TypeScript bridge and tools/blender/studio (bpy). It is built by code from a
 * ReelPlan (never by a model), validated here, written to a file and passed to Blender by path. Python computes
 * every keyframe from these ids and bounded numbers.
 */

export const STUDIO_JOB_VERSION = "studio-job/1";

export const StudioShotSpec = z.object({
  id: z.string().regex(/^sh\d{2}$/),
  preset: ShotPreset,
  technique: ShotTechnique,
  durationMs: z.number().int().min(300).max(10_000),
  params: ShotParams,
  productAnimation: ProductAnimation,
  lighting: LightingPreset,
  /** sequence: frames rendered per second (interpolated to the reel fps afterwards) */
  renderFps: z.number().int().min(6).max(60),
  /** plate: extra canvas around the frame so FFmpeg can push / slide (1.0 = none) */
  overscan: z.number().min(1).max(1.6),
  /** plate: largest sideways shift of the FFmpeg move's window (composed-frame widths) — the studio frames the
   *  product that much narrower on each side so the slide never cuts it */
  travelX: z.number().min(0).max(0.5).optional(),
});
export type StudioShotSpec = z.infer<typeof StudioShotSpec>;

/**
 * A relight shot's product light switches on over this share of the shot (shotlib.light_switch =
 * smoothstep(0.3, 0.42)). The shot clip cross-fades off → on from the frame lightSwitchFrame() returns, and the
 * director puts the light-switch click on that same frame.
 */
export const LIGHT_SWITCH = { start: 0.3, end: 0.42 } as const;

/** Index of the frame (of a shot's `frames`) on which the light starts to switch on. */
export const lightSwitchFrame = (frames: number): number => Math.round(LIGHT_SWITCH.start * frames);

export const StudioJob = z.object({
  version: z.literal(STUDIO_JOB_VERSION),
  jobKey: z.string(),
  product: z.object({
    modelPath: z.string(),
    modelSha: z.string(),
    format: z.enum(["glb", "gltf", "obj", "fbx", "usd", "blend"]),
    /** real height of the product (m) when known — scales the scene so lenses / DOF behave physically */
    realHeightM: z.number().positive().optional(),
    emitsLight: z.boolean(),
    /** case-insensitive material/object name fragments that should glow when the light is on */
    emissiveHints: z.array(z.string().max(40)).max(12).default([]),
  }),
  environment: StudioEnvironment,
  profile: BlenderProfile,
  output: z.object({
    dir: z.string(),
    width: z.number().int().min(270).max(2160),
    height: z.number().int().min(480).max(3840),
  }),
  camera: z.object({
    lensMm: z.number().min(18).max(200),
    dof: z.object({ enabled: z.boolean(), fStop: z.number().min(0.95).max(22) }),
    motionBlur: z.boolean(),
  }),
  shots: z.array(StudioShotSpec).min(1).max(8),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1),
});
export type StudioJob = z.infer<typeof StudioJob>;

/** Normalised rect (0..1 of the output frame). */
export const NormRect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type NormRect = z.infer<typeof NormRect>;

/** What Blender writes back per shot (studio/<jobKey>/<shotId>/result.json). */
export const StudioShotResult = z.object({
  id: z.string(),
  technique: ShotTechnique,
  /** plate: [plate.png] · relight: [off.png, on.png] · sequence: frame files in order */
  files: z.array(z.string()).min(1),
  width: z.number().int(),
  height: z.number().int(),
  renderFps: z.number().int(),
  /** projected product bounding box per file (normalised, before any FFmpeg move) */
  productBoxes: z.array(NormRect),
  samples: z.number().int(),
  renderMs: z.number().int(),
  engine: z.string(),
  blenderVersion: z.string(),
});
export type StudioShotResult = z.infer<typeof StudioShotResult>;

export const StudioResult = z.object({
  version: z.literal(STUDIO_JOB_VERSION),
  jobKey: z.string(),
  shots: z.array(StudioShotResult),
  sceneMs: z.number().int(),
  totalMs: z.number().int(),
});
export type StudioResult = z.infer<typeof StudioResult>;

/* ================================================================== Shot clips =================== */

/** A finished, timed video clip for one shot (1080×1920, reel fps, no audio). */
export interface ShotClip {
  shotId: string;
  path: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  /** product box over time after the FFmpeg move (QA: visible, not cut, big enough) */
  productTrack: { tMs: number; rect: Rect }[];
  cacheHit: boolean;
  renderMs: number;
  encodeMs: number;
}

/* ================================================================== Audio artifacts ============== */

export interface WordTime {
  text: string;
  startMs: number;
  endMs: number;
}

/** Voice-over for one locale, placed on the reel timeline. */
export interface VoiceTrack {
  path: string;
  durationMs: number;
  /** words on the reel timeline (absolute ms) */
  words: WordTime[];
  timingsSource: "provider" | "transcription" | "alignment" | "estimate";
  segments: { slot: string; startMs: number; endMs: number }[];
  provider: string;
  model: string;
  voice: string;
}

export interface MusicTrack {
  path: string;
  durationMs: number;
  bpm: number;
  provider: string;
  model: string;
  license: string;
  cached: boolean;
}

export interface SfxCueFile {
  atMs: number;
  kind: SfxKind;
  gainDb: number;
  path: string;
  provider: string;
  cached: boolean;
}

/* ================================================================== Composer inputs ============== */

/** A text element the composer burns in (overlay, CTA, button, disclosure), resolved for one locale. */
export interface TextElement {
  id: string;
  kind: "overlay" | "cta" | "button" | "disclosure" | "hook";
  text: string;
  startMs: number;
  endMs: number;
  /** box on the 1080×1920 frame (safe-zone checked) */
  box: Rect;
  align: "left" | "center" | "right";
  fontSizePx: number;
  font: { family: string; file: string };
  color: string;
  /** optional rounded panel behind the text */
  panel?: { color: string; opacity: number; radius: number; padding: number };
}

export interface CaptionPhrase {
  startMs: number;
  endMs: number;
  words: WordTime[];
}

export interface CaptionTrack {
  style: "word_highlight" | "phrase_pop" | "karaoke_fill" | "minimal_lower";
  phrases: CaptionPhrase[];
  font: { family: string; file: string };
  fontSizePx: number;
  color: string;
  highlightColor: string;
  outlineColor: string;
  /** caption band on the frame */
  box: Rect;
  uppercase: boolean;
}

export const StudioProfileDefaults: Record<
  BlenderProfile,
  { scale: number; samples: number; sequenceFps: number; overscan: number }
> = {
  FAST: { scale: 0.5, samples: 12, sequenceFps: 15, overscan: 1.18 },
  QUALITY: { scale: 1, samples: 64, sequenceFps: 30, overscan: 1.18 },
};
