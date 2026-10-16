import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { SafeId } from "@cre/reel/contracts";
import { FatalError } from "@cre/shared";
import { z } from "zod";
import type { EngineRenderRequest } from "../../contracts/engine.ts";
import {
  ActionStep,
  BackgroundPreset,
  CameraPreset,
  EnvironmentPreset,
  Fidelity,
  FPS_VALUES,
  HexColor,
  isUnrealTemplate,
  LightingPreset,
  Movement,
  PartName,
  RenderQuality,
  UNREAL_TEMPLATES,
} from "../../contracts/index.ts";
import { UE_EXECUTORS, UE_GI_MODES, type UeExecutor, type UeGiMode } from "./config.ts";

/*
 * The UE scene job: what tools/unreal/ue_scene.py renders. The schema below is the TypeScript twin of
 * tools/unreal/ue_job.py validate_job (closed sets, bounded numbers, strict objects; a vitest feeds a built job to
 * the Python validator). The only paths it carries are the job's output directory, the product model file and
 * baked texture maps the adapter copied into the output directory.
 */

export const UE_SCENE_VERSION = 1;
export const MATERIAL_STATUSES = ["PBR_DIRECT", "NEEDS_BAKE", "APPROXIMATED", "UNSUPPORTED"] as const;
export const BAKE_CHANNELS = ["baseColor", "roughness", "metallic", "normal"] as const;
export type BakeChannel = (typeof BAKE_CHANNELS)[number];
const MATERIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,119}$/;
const noControl = (s: string) => ![...s].some((c) => c.charCodeAt(0) < 32);

const AbsPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(noControl, "no control characters")
  .refine((p) => path.isAbsolute(p), "an absolute path");

/** One row of tools/blender/scenes/export.py's material report (extra fields of newer exporters are dropped). */
export const MaterialReportRow = z
  .object({
    material: z.string().regex(MATERIAL_NAME),
    status: z.enum(MATERIAL_STATUSES),
    notes: z.array(z.string().max(300).refine(noControl)).max(16).default([]),
    textures: z.array(z.string().max(200).refine(noControl)).max(32).default([]),
    baseColor: HexColor.optional(),
    roughness: z.number().min(0).max(1).optional(),
    metallic: z.number().min(0).max(1).optional(),
  })
  .loose();
export const MaterialReport = z
  .object({
    materials: z.array(MaterialReportRow).max(64),
    counts: z.record(z.string(), z.number()).optional(),
    ueReady: z.boolean().optional(),
  })
  .loose();
export type MaterialReport = z.infer<typeof MaterialReport>;

const JobMaterialRow = z
  .object({
    material: z.string().regex(MATERIAL_NAME),
    status: z.enum(MATERIAL_STATUSES),
    notes: z.array(z.string().max(300)).max(16),
    textures: z.array(z.string().max(200)).max(32),
    baseColor: HexColor.optional(),
    roughness: z.number().min(0).max(1).optional(),
    metallic: z.number().min(0).max(1).optional(),
  })
  .strict();

export const UeSceneJob = z
  .object({
    version: z.literal(UE_SCENE_VERSION),
    kind: z.literal("ue_scene"),
    jobId: SafeId,
    template: z.enum(UNREAL_TEMPLATES),
    quality: RenderQuality,
    durationSec: z.number().min(0.5).max(20),
    fps: z
      .number()
      .int()
      .refine((f) => (FPS_VALUES as readonly number[]).includes(f)),
    resolution: z
      .tuple([z.number().int().min(128).max(4096), z.number().int().min(128).max(4096)])
      .refine(([w, h]) => w % 2 === 0 && h % 2 === 0),
    seed: z.number().int().min(0).max(2_147_483_647),
    turns: z.number().min(0.1).max(4),
    camera: z.object({ preset: CameraPreset, movement: Movement }).strict(),
    framing: z
      .object({ centerY: z.number().min(0.3).max(0.7), fill: z.number().min(0.25).max(0.9).optional() })
      .strict(),
    lighting: z.object({ preset: LightingPreset }).strict(),
    background: z
      .object({ preset: BackgroundPreset, color: HexColor.optional(), accent: HexColor.optional() })
      .strict(),
    environment: z.object({ preset: EnvironmentPreset }).strict().optional(),
    focus: PartName.optional(),
    actions: z.array(ActionStep).max(8),
    product: z
      .object({
        assetId: SafeId,
        path: AbsPath.refine((p) => /\.(fbx|glb)$/i.test(p), "a .fbx or .glb file"),
        format: z.enum(["fbx", "glb"]),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        dimensionsM: z.tuple([z.number(), z.number(), z.number()]).optional(),
        fidelity: Fidelity,
        frontYawDeg: z.number().min(-180).max(180),
        materialReport: z
          .object({ materials: z.array(JobMaterialRow).max(64) })
          .strict()
          .optional(),
        bakedTextures: z
          .record(z.string().regex(MATERIAL_NAME), z.partialRecord(z.enum(BAKE_CHANNELS), AbsPath))
          .optional(),
      })
      .strict(),
    render: z
      .object({
        executor: z.enum(UE_EXECUTORS),
        gi: z.enum(UE_GI_MODES),
        maxRenderSec: z.number().min(10).max(172_800),
        warmUpFrames: z.number().int().min(0).max(256).optional(),
        spatialSamples: z.number().int().min(1).max(64).optional(),
        temporalSamples: z.number().int().min(1).max(64).optional(),
        setupOnly: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ dir: AbsPath }).strict(),
    interactive: z.boolean(),
  })
  .strict()
  .superRefine((j, ctx) => {
    if (j.background.preset === "environment" && !j.environment)
      ctx.addIssue({ code: "custom", message: "background 'environment' needs environment.preset" });
    if (path.extname(j.product.path).slice(1).toLowerCase() !== j.product.format)
      ctx.addIssue({ code: "custom", message: "product.format does not match the file extension" });
    const root = path.resolve(j.output.dir) + path.sep;
    for (const maps of Object.values(j.product.bakedTextures ?? {}))
      for (const p of Object.values(maps))
        if (p && !path.resolve(p).startsWith(root))
          ctx.addIssue({ code: "custom", message: `baked texture ${p} is outside output.dir` });
    for (const a of j.actions)
      if (a.endSec > j.durationSec)
        ctx.addIssue({ code: "custom", message: `action ${a.kind} ends after the clip` });
  });
export type UeSceneJob = z.infer<typeof UeSceneJob>;

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export function productFormat(file: string): "fbx" | "glb" {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext !== "fbx" && ext !== "glb")
    throw new FatalError(
      `the UE adapter imports .fbx or .glb models, not .${ext || "?"} (${path.basename(file)})`,
    );
  return ext;
}

/**
 * The material report of a model, from a sidecar next to it: <model>.materials.json, material_report.json, or a
 * Blender export result.json one level up (tools/blender/scenes writes export/product.fbx + result.json with
 * `materialReport`). Invalid sidecars are reported, never trusted.
 */
export async function findMaterialReport(
  productFile: string,
): Promise<{ report: MaterialReport | null; source: string | null; warning: string | null }> {
  const dir = path.dirname(productFile);
  const base = path.basename(productFile, path.extname(productFile));
  const candidates: [string, (j: unknown) => unknown][] = [
    [path.join(dir, `${base}.materials.json`), (j) => j],
    [path.join(dir, "material_report.json"), (j) => j],
    [
      path.join(path.dirname(dir), "result.json"),
      (j) => (j as { materialReport?: unknown } | null)?.materialReport,
    ],
  ];
  for (const [file, pick] of candidates) {
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    try {
      const value = pick(JSON.parse(text));
      if (value === undefined || value === null) continue;
      return { report: MaterialReport.parse(value), source: file, warning: null };
    } catch (e) {
      return {
        report: null,
        source: file,
        warning: `ignored invalid material report ${file}: ${(e as Error).message.slice(0, 200)}`,
      };
    }
  }
  return { report: null, source: null, warning: null };
}

const BAKED_FILE =
  /^([A-Za-z0-9][A-Za-z0-9 _.-]{0,119})\.(baseColor|roughness|metallic|normal)\.(png|jpe?g|tga|exr)$/;

/**
 * Baked maps next to the model (<model dir>/baked/<Material>.<channel>.<ext>, e.g. Body.baseColor.png) are copied
 * into the job's output directory so the job only names paths inside it.
 */
export async function stageBakedTextures(
  productFile: string,
  outDir: string,
): Promise<{ maps: Record<string, Partial<Record<BakeChannel, string>>>; warnings: string[] }> {
  const src = path.join(path.dirname(productFile), "baked");
  const maps: Record<string, Partial<Record<BakeChannel, string>>> = {};
  const warnings: string[] = [];
  let names: string[];
  try {
    names = await fsp.readdir(src);
  } catch {
    return { maps, warnings };
  }
  const dest = path.join(outDir, "inputs", "baked");
  for (const n of names.sort()) {
    const m = BAKED_FILE.exec(n);
    if (!m) {
      warnings.push(
        `baked/${n.slice(0, 80)}: not <Material>.<baseColor|roughness|metallic|normal>.<png|jpg|tga|exr> — ignored`,
      );
      continue;
    }
    const stat = await fsp.lstat(path.join(src, n));
    if (!stat.isFile()) continue; // no symlinks / directories
    await fsp.mkdir(dest, { recursive: true });
    const target = path.join(dest, n);
    await fsp.copyFile(path.join(src, n), target);
    (maps[m[1]!] ??= {})[m[2] as BakeChannel] = target;
  }
  return { maps, warnings };
}

export interface BuildUeJobInput {
  sha256: string;
  materialReport: MaterialReport | null;
  bakedTextures: Record<string, Partial<Record<BakeChannel, string>>>;
  executor: UeExecutor;
  gi: UeGiMode;
  maxRenderSec: number;
  interactive?: boolean;
  frontYawDeg?: number;
}

/**
 * Scene job for a request (pure — file checks and hashing happen before). Returns the job and the request parts
 * the UE adapter does not render (reported as warnings with the clip).
 */
export function buildUeSceneJob(
  req: Pick<EngineRenderRequest, "jobId" | "recipe" | "product" | "productFile">,
  outDir: string,
  inp: BuildUeJobInput,
): { job: UeSceneJob; warnings: string[] } {
  const r = req.recipe;
  if (!isUnrealTemplate(r.template))
    throw new FatalError(`${r.template} is not an Unreal template (use unrealEquivalent() for a UE render)`);
  if (!req.productFile)
    throw new FatalError(
      `${req.product.assetId}: the UE adapter needs a model file (.fbx / .glb) — export procedural products from Blender first`,
    );
  const warnings: string[] = [];
  const unsupported: [boolean, string][] = [
    [r.outputs.includes("alpha") || r.background.preset === "transparent", "alpha / transparent background"],
    [r.outputs.includes("control_views"), "control views"],
    [r.outputs.includes("blend"), ".blend scene file"],
    [r.outputs.includes("export_glb") || r.outputs.includes("export_fbx"), "model exports"],
  ];
  for (const [on, what] of unsupported) if (on) warnings.push(`${what} not produced by the UE adapter`);
  const report = inp.materialReport
    ? {
        materials: inp.materialReport.materials.map((m) => ({
          material: m.material,
          status: m.status,
          notes: m.notes,
          textures: m.textures,
          ...(m.baseColor ? { baseColor: m.baseColor } : {}),
          ...(m.roughness !== undefined ? { roughness: m.roughness } : {}),
          ...(m.metallic !== undefined ? { metallic: m.metallic } : {}),
        })),
      }
    : undefined;
  const dims = req.product.dimensionsM;
  const usableDims = dims && dims.every((d) => d >= 0.001 && d <= 50) ? dims : null;
  if (dims && !usableDims)
    warnings.push(`declared dimensions ${dims.join(" × ")} m are out of range: ignored`);
  const job = UeSceneJob.parse({
    version: UE_SCENE_VERSION,
    kind: "ue_scene",
    jobId: req.jobId,
    template: r.template,
    quality: r.quality,
    durationSec: r.durationSec,
    fps: r.fps,
    resolution: r.resolution,
    seed: r.seed,
    turns: r.turns,
    camera: r.camera,
    framing: {
      centerY: r.framing.centerY,
      ...(r.framing.fill !== undefined ? { fill: r.framing.fill } : {}),
    },
    lighting: r.lighting,
    background: r.background,
    ...(r.environment ? { environment: r.environment } : {}),
    ...(r.focus ? { focus: r.focus } : {}),
    actions: r.actions,
    product: {
      assetId: req.product.assetId,
      path: path.resolve(req.productFile),
      format: productFormat(req.productFile),
      sha256: inp.sha256,
      ...(usableDims ? { dimensionsM: usableDims } : {}),
      fidelity: req.product.fidelity,
      frontYawDeg: inp.frontYawDeg ?? 0,
      ...(report ? { materialReport: report } : {}),
      ...(Object.keys(inp.bakedTextures).length ? { bakedTextures: inp.bakedTextures } : {}),
    },
    render: { executor: inp.executor, gi: inp.gi, maxRenderSec: inp.maxRenderSec },
    output: { dir: path.resolve(outDir) },
    interactive: inp.interactive ?? false,
  });
  return { job, warnings };
}
