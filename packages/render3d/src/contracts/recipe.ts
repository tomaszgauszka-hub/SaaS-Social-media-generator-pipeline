import { SafeId } from "@cre/reel/contracts";
import { z } from "zod";

/*
 * Render recipe: what one 3D clip shows, as closed sets and bounded numbers only. A recipe never carries text,
 * prices, CTAs, captions or a locale — those stay in the 2D layer (Remotion / FFmpeg) — so one rendered clip
 * serves every language and a locale change never re-renders 3D.
 *
 * The Blender tables mirror tools/blender/scenes/scene_spec.py (a test compares both).
 */

export const ENGINE_MODES = ["AUTO", "BLENDER", "UNREAL", "2D_ONLY", "EXISTING_ASSET"] as const;
export const EngineMode = z.enum(ENGINE_MODES);
export type EngineMode = z.infer<typeof EngineMode>;

export const BLENDER_TEMPLATES = [
  "PRODUCT_HERO",
  "TURNTABLE_360",
  "MACRO_DETAIL",
  "EXPLODED_VIEW",
  "PRODUCT_ASSEMBLY",
  "LIFESTYLE",
  "TECHNICAL",
  "BRAND_ENVIRONMENT",
] as const;
export const UNREAL_TEMPLATES = [
  "UE_LUXURY_STUDIO",
  "UE_AUTOMOTIVE_CINEMATIC",
  "UE_MODERN_INTERIOR",
  "UE_INDUSTRIAL_WORKSHOP",
  "UE_TECHNOLOGY_SHOWCASE",
  "UE_ARCHITECTURAL_DEMO",
] as const;
export const SceneTemplate = z.enum([...BLENDER_TEMPLATES, ...UNREAL_TEMPLATES]);
export type SceneTemplate = z.infer<typeof SceneTemplate>;
export type BlenderTemplate = (typeof BLENDER_TEMPLATES)[number];
export type UnrealTemplate = (typeof UNREAL_TEMPLATES)[number];
export const isUnrealTemplate = (t: SceneTemplate): t is UnrealTemplate =>
  (UNREAL_TEMPLATES as readonly string[]).includes(t);

/** Templates that show the product's construction: only for models with a verified part structure. */
export const STRUCTURAL_TEMPLATES: readonly SceneTemplate[] = [
  "EXPLODED_VIEW",
  "PRODUCT_ASSEMBLY",
  "TECHNICAL",
];

/** Storyboard material types (packages/creative MediaRef.render3d.materialType). */
export const MATERIAL_TYPES_3D = [
  "3D_PRODUCT_HERO",
  "3D_TURNTABLE",
  "3D_MACRO",
  "3D_EXPLODED_VIEW",
  "3D_ASSEMBLY",
  "3D_LIFESTYLE",
  "3D_TECHNICAL",
  "3D_CINEMATIC",
] as const;
export const MaterialType3D = z.enum(MATERIAL_TYPES_3D);
export type MaterialType3D = z.infer<typeof MaterialType3D>;

export const TEMPLATE_MATERIAL: Record<SceneTemplate, MaterialType3D> = {
  PRODUCT_HERO: "3D_PRODUCT_HERO",
  TURNTABLE_360: "3D_TURNTABLE",
  MACRO_DETAIL: "3D_MACRO",
  EXPLODED_VIEW: "3D_EXPLODED_VIEW",
  PRODUCT_ASSEMBLY: "3D_ASSEMBLY",
  LIFESTYLE: "3D_LIFESTYLE",
  TECHNICAL: "3D_TECHNICAL",
  BRAND_ENVIRONMENT: "3D_PRODUCT_HERO",
  UE_LUXURY_STUDIO: "3D_CINEMATIC",
  UE_AUTOMOTIVE_CINEMATIC: "3D_CINEMATIC",
  UE_MODERN_INTERIOR: "3D_CINEMATIC",
  UE_INDUSTRIAL_WORKSHOP: "3D_CINEMATIC",
  UE_TECHNOLOGY_SHOWCASE: "3D_CINEMATIC",
  UE_ARCHITECTURAL_DEMO: "3D_CINEMATIC",
};

export const CAMERA_PRESETS = [
  "orbit_closeup",
  "orbit_wide",
  "turntable",
  "push_in",
  "crane_up",
  "dolly_side",
  "macro_slide",
  "top_down",
  "hero_low",
] as const;
export const CameraPreset = z.enum(CAMERA_PRESETS);
export const MOVEMENTS = ["static", "slow", "medium", "fast"] as const;
export const Movement = z.enum(MOVEMENTS);
export const LIGHTING_PRESETS = [
  "premium_studio",
  "soft_daylight",
  "dramatic_rim",
  "warm_home",
  "cool_tech",
  "workshop_practical",
  "high_key",
] as const;
export const LightingPreset = z.enum(LIGHTING_PRESETS);
export const BACKGROUND_PRESETS = [
  "dark_gradient",
  "light_gradient",
  "seamless_white",
  "soft_pastel",
  "brand_color",
  "transparent",
  "environment",
] as const;
export const BackgroundPreset = z.enum(BACKGROUND_PRESETS);
export const ENVIRONMENT_PRESETS = [
  "kitchen",
  "bathroom",
  "workshop",
  "living_room",
  "desk",
  "garage",
] as const;
export const EnvironmentPreset = z.enum(ENVIRONMENT_PRESETS);
export const PRODUCT_ACTIONS = [
  "TRIGGER_PRESS",
  "CHUCK_SPIN",
  "LED_ON",
  "CLUTCH_TURN",
  "GEAR_SHIFT",
  "CAP_OPEN",
  "LIGHT_ON",
] as const;
export const ProductAction = z.enum(PRODUCT_ACTIONS);
export type ProductAction = z.infer<typeof ProductAction>;
export const RenderQuality = z.enum(["preview", "production"]);
export type RenderQuality = z.infer<typeof RenderQuality>;
export const OUTPUT_KINDS = [
  "video",
  "thumbnail",
  "metadata",
  "alpha",
  "control_views",
  "blend",
  "export_glb",
  "export_fbx",
] as const;
export const OutputKind = z.enum(OUTPUT_KINDS);
export type OutputKind = z.infer<typeof OutputKind>;

export const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "expected #RRGGBB");
export const PartName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "a part name");

export const ActionStep = z
  .object({
    kind: ProductAction,
    startSec: z.number().min(0).max(20),
    endSec: z.number().min(0).max(20),
  })
  .strict()
  .refine((a) => a.endSec >= a.startSec, "endSec before startSec");
export type ActionStep = z.infer<typeof ActionStep>;

export const FPS_VALUES = [24, 25, 30, 50, 60] as const;

export const Recipe3D = z
  .object({
    engine: EngineMode.default("AUTO"),
    template: SceneTemplate,
    productAssetId: SafeId,
    durationSec: z.number().min(0.5).max(20),
    fps: z
      .number()
      .int()
      .refine((f) => (FPS_VALUES as readonly number[]).includes(f), "fps must be 24, 25, 30, 50 or 60")
      .default(30),
    resolution: z
      .tuple([z.number().int().min(128).max(4096), z.number().int().min(128).max(4096)])
      .refine(([w, h]) => w % 2 === 0 && h % 2 === 0, "even width and height")
      .default([1080, 1920]),
    camera: z
      .object({ preset: CameraPreset, movement: Movement.default("slow") })
      .strict()
      .default({ preset: "orbit_closeup", movement: "slow" }),
    lighting: z.object({ preset: LightingPreset }).strict().default({ preset: "premium_studio" }),
    background: z
      .object({ preset: BackgroundPreset, color: HexColor.optional(), accent: HexColor.optional() })
      .strict()
      .default({ preset: "dark_gradient" }),
    environment: z.object({ preset: EnvironmentPreset }).strict().optional(),
    /** a part of the product (macro / technical focus) — validated against the model's parts */
    focus: PartName.optional(),
    actions: z.array(ActionStep).max(8).default([]),
    /** where the product sits in the frame (leave room for the 2D layer's text): box centre height, size */
    framing: z
      .object({
        centerY: z.number().min(0.3).max(0.7).default(0.5),
        fill: z.number().min(0.25).max(0.9).optional(),
      })
      .strict()
      .default({ centerY: 0.5 }),
    /** turntable revolutions over the clip (speed) */
    turns: z.number().min(0.1).max(4).default(1),
    seed: z.number().int().min(0).max(2_147_483_647).default(1),
    quality: RenderQuality.default("preview"),
    outputs: z.array(OutputKind).min(1).default(["video", "thumbnail", "metadata"]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.template === "LIFESTYLE" && !r.environment)
      ctx.addIssue({ code: "custom", message: "a LIFESTYLE recipe needs environment.preset" });
    if (r.background.preset === "environment" && !r.environment)
      ctx.addIssue({ code: "custom", message: "background 'environment' needs environment.preset" });
    if (r.engine === "BLENDER" && isUnrealTemplate(r.template))
      ctx.addIssue({ code: "custom", message: `${r.template} is an Unreal Engine template` });
    for (const a of r.actions)
      if (a.endSec > r.durationSec)
        ctx.addIssue({ code: "custom", message: `action ${a.kind} ends after the clip` });
  });
export type Recipe3D = z.infer<typeof Recipe3D>;
export type Recipe3DInput = z.input<typeof Recipe3D>;

/** Default recipe per storyboard material type (the router fills what a request leaves out). */
export function defaultRecipe(materialType: MaterialType3D, productAssetId: string): Recipe3DInput {
  const base = { productAssetId, durationSec: 4 };
  switch (materialType) {
    case "3D_PRODUCT_HERO":
      return {
        ...base,
        template: "PRODUCT_HERO",
        camera: { preset: "orbit_closeup", movement: "slow" },
        lighting: { preset: "premium_studio" },
        background: { preset: "dark_gradient" },
      };
    case "3D_TURNTABLE":
      return {
        ...base,
        durationSec: 5,
        template: "TURNTABLE_360",
        camera: { preset: "turntable", movement: "static" },
        lighting: { preset: "high_key" },
        background: { preset: "light_gradient" },
      };
    case "3D_MACRO":
      return {
        ...base,
        durationSec: 3,
        template: "MACRO_DETAIL",
        camera: { preset: "macro_slide", movement: "slow" },
        lighting: { preset: "dramatic_rim" },
        background: { preset: "dark_gradient" },
      };
    case "3D_EXPLODED_VIEW":
      return {
        ...base,
        durationSec: 5,
        template: "EXPLODED_VIEW",
        camera: { preset: "orbit_wide", movement: "slow" },
        framing: { centerY: 0.5, fill: 0.66 },
        lighting: { preset: "premium_studio" },
        background: { preset: "light_gradient" },
      };
    case "3D_ASSEMBLY":
      return {
        ...base,
        durationSec: 5,
        template: "PRODUCT_ASSEMBLY",
        camera: { preset: "orbit_wide", movement: "slow" },
        lighting: { preset: "premium_studio" },
        background: { preset: "light_gradient" },
      };
    case "3D_LIFESTYLE":
      return {
        ...base,
        template: "LIFESTYLE",
        camera: { preset: "push_in", movement: "slow" },
        lighting: { preset: "soft_daylight" },
        background: { preset: "environment" },
        environment: { preset: "living_room" },
      };
    case "3D_TECHNICAL":
      return {
        ...base,
        template: "TECHNICAL",
        camera: { preset: "dolly_side", movement: "slow" },
        lighting: { preset: "cool_tech" },
        background: { preset: "dark_gradient" },
      };
    case "3D_CINEMATIC":
      return {
        ...base,
        durationSec: 5,
        template: "UE_LUXURY_STUDIO",
        camera: { preset: "hero_low", movement: "slow" },
        lighting: { preset: "dramatic_rim" },
        background: { preset: "dark_gradient" },
      };
  }
}

/**
 * Nearest Blender recipe for an Unreal template (AUTO mode without a reachable Unreal Engine): the same story beat
 * with a set the Blender generators have.
 */
export function blenderEquivalent(r: Recipe3D): Recipe3D {
  if (!isUnrealTemplate(r.template)) return r;
  const map: Record<UnrealTemplate, Partial<Recipe3D>> = {
    UE_LUXURY_STUDIO: { template: "PRODUCT_HERO", background: { preset: "dark_gradient" } },
    UE_AUTOMOTIVE_CINEMATIC: {
      template: "PRODUCT_HERO",
      camera: { preset: "hero_low", movement: "slow" },
      background: { preset: "dark_gradient" },
    },
    UE_MODERN_INTERIOR: {
      template: "LIFESTYLE",
      background: { preset: "environment" },
      environment: { preset: "living_room" },
    },
    UE_INDUSTRIAL_WORKSHOP: {
      template: "LIFESTYLE",
      background: { preset: "environment" },
      environment: { preset: "workshop" },
    },
    UE_TECHNOLOGY_SHOWCASE: {
      template: "BRAND_ENVIRONMENT",
      lighting: { preset: "cool_tech" },
      background: { preset: "brand_color" },
    },
    UE_ARCHITECTURAL_DEMO: {
      template: "LIFESTYLE",
      background: { preset: "environment" },
      environment: { preset: "living_room" },
    },
  };
  return Recipe3D.parse({ ...r, ...map[r.template], engine: "BLENDER" });
}

/** Nearest Unreal template for a Blender recipe (mode UNREAL forced on a Blender template). */
export function unrealEquivalent(r: Recipe3D): Recipe3D {
  if (isUnrealTemplate(r.template)) return r;
  const env = r.environment?.preset;
  const template: UnrealTemplate =
    r.template === "LIFESTYLE"
      ? env === "workshop" || env === "garage"
        ? "UE_INDUSTRIAL_WORKSHOP"
        : "UE_MODERN_INTERIOR"
      : r.template === "TECHNICAL" || r.template === "BRAND_ENVIRONMENT"
        ? "UE_TECHNOLOGY_SHOWCASE"
        : "UE_LUXURY_STUDIO";
  return Recipe3D.parse({ ...r, template, engine: "UNREAL" });
}
