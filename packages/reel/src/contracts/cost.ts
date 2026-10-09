import { z } from "zod";
import { Capability } from "./ids.ts";

/** Cost categories reported per reel (API spend in micro-USD). */
export const COST_CATEGORIES = [
  "llm",
  "image",
  "music",
  "tts",
  "sfx",
  "transcription",
  "embedding",
  "generative_video",
  "visual_qa",
] as const;
export const CostCategory = z.enum(COST_CATEGORIES);
export type CostCategory = z.infer<typeof CostCategory>;

/** One provider call (or one cache hit, cost 0) recorded by the CostTracker. */
export const CostEntry = z.object({
  capability: Capability,
  category: CostCategory.optional(),
  provider: z.string(),
  model: z.string(),
  /** micro-USD actually charged (estimate when the API does not report it) */
  costMicros: z.number().int().min(0),
  estimated: z.boolean(),
  cached: z.boolean().default(false),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  units: z.record(z.string(), z.number()).default({}),
  latencyMs: z.number().int().min(0).default(0),
  /** which variant (locale / A/B key) the call served; "master" for shared work */
  scope: z.string().default("master"),
  note: z.string().max(300).optional(),
});
export type CostEntry = z.infer<typeof CostEntry>;
export type CostEntryInput = z.input<typeof CostEntry>;

/** Local compute — free in API terms but the real bottleneck. */
export const ComputeEntry = z.object({
  stage: z.enum(["blender", "ffmpeg", "audio_synth", "tts_local", "qa", "other"]),
  label: z.string().max(120),
  wallMs: z.number().int().min(0),
  cpuMs: z.number().int().min(0).optional(),
  frames: z.number().int().min(0).optional(),
  cached: z.boolean().default(false),
  scope: z.string().default("master"),
});
export type ComputeEntry = z.infer<typeof ComputeEntry>;
export type ComputeEntryInput = z.input<typeof ComputeEntry>;

export const CostBreakdown = z.object({
  byCategory: z.record(CostCategory, z.number().int().min(0)),
  totalApiMicros: z.number().int().min(0),
  tokens: z.object({ input: z.number().int(), output: z.number().int() }),
  compute: z.object({
    blenderMs: z.number().int(),
    ffmpegMs: z.number().int(),
    audioMs: z.number().int(),
    otherMs: z.number().int(),
  }),
  entries: z.array(CostEntry),
  computeEntries: z.array(ComputeEntry),
});
export type CostBreakdown = z.infer<typeof CostBreakdown>;
