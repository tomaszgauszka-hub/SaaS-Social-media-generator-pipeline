import { SafeId } from "@cre/reel/contracts";
import { z } from "zod";
import { MaterialType3D, PartName, ProductAction, RenderQuality, SceneTemplate } from "./recipe.ts";

/*
 * 3D asset library metadata. Large binaries live in the Storage provider (local disk / S3 / R2); a library
 * record keeps only storage keys, hashes and provenance. Field names map 1:1 onto the metadata list of the
 * spec (asset_id → assetId, license_evidence → licenseEvidence, render_cost_estimate → renderCostEstimateUsd …).
 */

export const ASSET_TYPES_3D = [
  "PRODUCT_MODEL",
  "PROP_MODEL",
  "SCENE",
  "ENVIRONMENT",
  "PBR_MATERIAL",
  "HDRI",
  "LIGHT_RIG",
  "ANIMATION",
  "CAMERA_MOVE",
  "RENDER_CLIP",
  "RENDER_STILL_ALPHA",
  "RENDER_PRESET",
] as const;
export const AssetType3D = z.enum(ASSET_TYPES_3D);
export type AssetType3D = z.infer<typeof AssetType3D>;

/**
 * How faithfully a model represents the real product (spec §13):
 *  VERIFIED_MANUFACTURER     model delivered by the manufacturer / brand (with evidence)
 *  TECHNICAL_RECONSTRUCTION  built from sufficient technical data (catalog 3D model, drawings, measurements)
 *  APPROXIMATE_VISUALIZATION illustrative only — must not suggest unconfirmed properties, parts or features
 *  FICTIONAL_DEMO            fully fictional demo product — DEMO_ONLY, never published
 */
export const FIDELITY_LEVELS = [
  "VERIFIED_MANUFACTURER",
  "TECHNICAL_RECONSTRUCTION",
  "APPROXIMATE_VISUALIZATION",
  "FICTIONAL_DEMO",
] as const;
export const Fidelity = z.enum(FIDELITY_LEVELS);
export type Fidelity = z.infer<typeof Fidelity>;

export const Engine3D = z.enum(["blender", "unreal", "none", "external"]);
export type Engine3D = z.infer<typeof Engine3D>;

export const OutputRole = z.enum([
  "video",
  "thumbnail",
  "metadata",
  "alpha_video",
  "control_sheet",
  "blend",
  "glb",
  "fbx",
  "source_model",
  "ue_level",
]);
export type OutputRole = z.infer<typeof OutputRole>;

export const OutputFile = z
  .object({
    role: OutputRole,
    /** storage key (never an absolute path) */
    key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/),
    sizeBytes: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    contentType: z.string(),
  })
  .strict();
export type OutputFile = z.infer<typeof OutputFile>;

export const ApprovalStatus = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const RenderTelemetry = z
  .object({
    engine: Engine3D,
    template: z.string(),
    modelSource: z.string(),
    renderDurationMs: z.number().int().min(0),
    peakRamMb: z.number().min(0).nullable(),
    peakVramMb: z.number().min(0).nullable(),
    cpuUsagePct: z.number().min(0).nullable(),
    gpuUsagePct: z.number().min(0).nullable(),
    outputSizeBytes: z.number().int().min(0),
    framesRendered: z.number().int().min(0),
    cacheHit: z.boolean(),
    failureReason: z.string().nullable(),
    device: z.string().default("CPU"),
    host: z.string().default(""),
    perFrameMsMedian: z.number().min(0).nullable().default(null),
  })
  .strict();
export type RenderTelemetry = z.infer<typeof RenderTelemetry>;

export const QaCheck = z
  .object({
    id: z.string(),
    ok: z.boolean(),
    severity: z.enum(["blocker", "warning", "info"]),
    value: z.union([z.number(), z.string(), z.null()]).default(null),
    message: z.string(),
  })
  .strict();
export type QaCheck = z.infer<typeof QaCheck>;

export const ClipQaReport = z
  .object({
    passed: z.boolean(),
    score: z.number().min(0).max(100),
    checks: z.array(QaCheck),
    /** technical checks only — never an aesthetic verdict; owner approval stays required */
    note: z.string().default("automatic technical checks; aesthetics need owner review"),
  })
  .strict();
export type ClipQaReport = z.infer<typeof ClipQaReport>;

export const PartInfo = z
  .object({
    name: PartName,
    role: z.string(),
    verified: z.boolean(),
    internal: z.boolean().default(false),
  })
  .strict();

export const Asset3D = z
  .object({
    assetId: SafeId,
    assetType: AssetType3D,
    productId: z.string().max(120).nullable().default(null),
    brandId: z.string().max(120).nullable().default(null),
    category: z.string().max(60),
    /** provenance: "procedural:<generator>@<v>", "abo:<item id>", "manufacturer:<ref>", "render:<recipe hash>" */
    source: z.string().max(300),
    license: z.string().min(1).max(200),
    /** URL, file reference or written statement proving the licence / right of use */
    licenseEvidence: z.string().min(1).max(1000),
    isSynthetic: z.boolean(),
    isDemoOnly: z.boolean(),
    isProductVerified: z.boolean(),
    fidelity: Fidelity,
    /** the part structure is real / verified (exploded, assembly and technical templates need it) */
    structureVerified: z.boolean().default(false),
    engine: Engine3D,
    engineVersion: z.string().max(200).nullable().default(null),
    /** storage key of the source model / scene file */
    sourceFile: z.string().nullable().default(null),
    /** generator name + params of a procedural model (deterministic rebuild) */
    generator: z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
        version: z.number().int().min(1),
        params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
      })
      .strict()
      .nullable()
      .default(null),
    version: z.number().int().min(1),
    geometryHash: z.string().nullable().default(null),
    materialHash: z.string().nullable().default(null),
    sceneHash: z.string().nullable().default(null),
    renderSettingsHash: z.string().nullable().default(null),
    /** clips: hash of the complete render recipe (+ engine identity) — the cache key */
    recipeHash: z.string().nullable().default(null),
    /** clips: recipe + product identity without the engine version (reuse across renderer upgrades) */
    visualKey: z.string().nullable().default(null),
    outputFiles: z.array(OutputFile).default([]),
    durationMs: z.number().int().min(0).nullable().default(null),
    resolution: z.tuple([z.number().int(), z.number().int()]).nullable().default(null),
    fps: z.number().int().nullable().default(null),
    renderTimeMs: z.number().int().min(0).nullable().default(null),
    renderCostEstimateUsd: z.number().min(0).nullable().default(null),
    createdAt: z.string(),
    /** model metadata */
    parts: z.array(PartInfo).default([]),
    actions: z.array(ProductAction).default([]),
    /** expected real dimensions (m): QA compares the model against them */
    dimensionsM: z.tuple([z.number(), z.number(), z.number()]).nullable().default(null),
    /** clip metadata */
    materialType: MaterialType3D.nullable().default(null),
    template: SceneTemplate.nullable().default(null),
    quality: RenderQuality.nullable().default(null),
    parentAssetIds: z.array(SafeId).default([]),
    telemetry: RenderTelemetry.nullable().default(null),
    qa: ClipQaReport.nullable().default(null),
    approval: z
      .object({
        status: ApprovalStatus,
        by: z.string().max(200).nullable().default(null),
        at: z.string().nullable().default(null),
        note: z.string().max(1000).nullable().default(null),
      })
      .strict()
      .default({ status: "PENDING", by: null, at: null, note: null }),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.fidelity === "FICTIONAL_DEMO" && !a.isDemoOnly)
      ctx.addIssue({ code: "custom", message: "a fictional demo model is DEMO_ONLY" });
    if (a.fidelity === "FICTIONAL_DEMO" && a.isProductVerified)
      ctx.addIssue({ code: "custom", message: "a fictional demo model cannot be product-verified" });
    if (a.fidelity === "APPROXIMATE_VISUALIZATION" && a.isProductVerified)
      ctx.addIssue({
        code: "custom",
        message: "an approximate visualisation is not a verified product model",
      });
    if (
      a.isProductVerified &&
      a.fidelity !== "VERIFIED_MANUFACTURER" &&
      a.fidelity !== "TECHNICAL_RECONSTRUCTION"
    )
      ctx.addIssue({ code: "custom", message: "isProductVerified needs a verified / reconstructed model" });
  });
export type Asset3D = z.infer<typeof Asset3D>;
export type Asset3DInput = z.input<typeof Asset3D>;

/** Clips inherit the most restrictive provenance of the model they show. */
export function inheritProvenance(
  model: Pick<
    Asset3D,
    "isSynthetic" | "isDemoOnly" | "isProductVerified" | "fidelity" | "license" | "licenseEvidence"
  >,
): Pick<
  Asset3D,
  "isSynthetic" | "isDemoOnly" | "isProductVerified" | "fidelity" | "license" | "licenseEvidence"
> {
  return {
    isSynthetic: true, // a render is always synthetic imagery, even of a verified model
    isDemoOnly: model.isDemoOnly,
    isProductVerified: model.isProductVerified,
    fidelity: model.fidelity,
    license: model.license,
    licenseEvidence: model.licenseEvidence,
  };
}
