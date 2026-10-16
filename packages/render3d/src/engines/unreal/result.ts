import fs from "node:fs";
import path from "node:path";
import { SafeId } from "@cre/reel/contracts";
import { FatalError } from "@cre/shared";
import { z } from "zod";
import { AnchorTrack, type EngineRenderOutput } from "../../contracts/engine.ts";
import { CameraPreset, FPS_VALUES, UNREAL_TEMPLATES } from "../../contracts/index.ts";
import { frameCount, renderSize } from "../../routing/estimate.ts";
import { UE_EXECUTORS } from "./config.ts";
import type { UeSceneJob } from "./job.ts";

/*
 * tools/unreal/ue_scene.py result.json — validated (schema, job identity, frame count / size, file names, every frame
 * present as a regular file inside the job's output directory) before anything downstream trusts it. The shape
 * matches the Blender generators' result where the engine-independent worker reads it (frames, productBoxes,
 * anchorTracks, controlViews, timings, warnings).
 */

const finite = z.number().refine(Number.isFinite, "finite");
const Box = z
  .tuple([finite, finite, finite, finite])
  .refine((b) => b.every((v) => v >= -10 && v <= 11), "box");
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Dims = z.tuple([finite, finite, finite]);

export const UeSceneResult = z
  .object({
    ok: z.literal(true),
    /** true only for the test double (testing/fake-unreal-editor.mjs) — never a real render */
    mock: z.boolean().default(false),
    sceneVersion: z.string().regex(/^ue-scene\/\d+$/),
    jobId: SafeId,
    template: z.enum(UNREAL_TEMPLATES),
    unreal: z
      .object({
        version: z.string().max(200),
        executor: z.enum(UE_EXECUTORS),
        configClass: z.string().max(80),
        gi: z.enum(["lumen", "screen_space"]),
        apiVariants: z.record(z.string(), z.string().max(120)).default({}),
      })
      .loose(),
    device: z
      .object({ device: z.string().max(40), name: z.string().max(200).nullable().default(null) })
      .loose(),
    frames: z
      .object({
        dir: z.literal("frames"),
        pattern: z.literal("f_%04d.png"),
        startNumber: z.union([z.literal(0), z.literal(1)]),
        count: z.number().int().min(2).max(1200),
        width: z.number().int().min(128).max(4096),
        height: z.number().int().min(128).max(4096),
        fps: z
          .number()
          .int()
          .refine((f) => (FPS_VALUES as readonly number[]).includes(f)),
        alpha: z.literal(false),
      })
      .strict(),
    product: z
      .object({
        assetId: SafeId,
        assetPath: z.string().regex(/^\/Game\/Render3D\/[A-Za-z0-9_/]+$/),
        sourceSha256: Hex64,
        importSkipped: z.boolean(),
        measuredCm: Dims,
        dimsCm: Dims,
        expectedCm: Dims.nullable(),
        scaleApplied: finite.refine((s) => s > 0),
        mismatchPct: finite.nullable(),
        materialHash: Hex64,
      })
      .loose(),
    set: z
      .object({ name: z.string().max(80), key: z.string().regex(/^[0-9a-f]{16}$/), rebuilt: z.boolean() })
      .loose(),
    productBoxes: z.array(Box),
    anchorTracks: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), AnchorTrack),
    camera: z.object({ preset: CameraPreset, lensMm: finite, distanceCm: finite }).loose(),
    controlViews: z.array(z.string().regex(/^views\/[a-z_]+\.png$/)).max(0),
    materials: z
      .array(
        z
          .object({
            slot: z.string().max(200),
            material: z.string().max(200).nullable(),
            status: z.string().max(40).nullable(),
            action: z.enum(["keep", "instance", "neutral"]),
          })
          .loose(),
      )
      .max(256),
    materialReport: z.unknown(),
    mrq: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string().max(4000)).max(500),
    timings: z
      .object({
        totalMs: z.number().int().min(0),
        renderMs: z.number().int().min(0),
        frameMs: z.array(z.number().int().min(0)),
      })
      .loose(),
    log: z.literal("ue_scene.log").optional(),
  })
  .loose()
  .superRefine((r, ctx) => {
    if (r.productBoxes.length !== r.frames.count)
      ctx.addIssue({
        code: "custom",
        message: `${r.productBoxes.length} product boxes for ${r.frames.count} frames`,
      });
    for (const [k, t] of Object.entries(r.anchorTracks))
      if (t.length !== r.frames.count)
        ctx.addIssue({ code: "custom", message: `anchor track ${k}: wrong length` });
  });
export type UeSceneResult = z.infer<typeof UeSceneResult>;

export const UeSceneFailure = z
  .object({
    ok: z.literal(false),
    error: z.string().max(60),
    message: z.string().max(4000),
    exitCode: z.number().int(),
    warnings: z.array(z.string().max(4000)).max(500).default([]),
  })
  .loose();
export type UeSceneFailure = z.infer<typeof UeSceneFailure>;

export type UeResultFile =
  { kind: "ok"; result: UeSceneResult } | { kind: "failure"; failure: UeSceneFailure } | { kind: "missing" };

export function readUeResultFile(outDir: string): UeResultFile {
  const file = path.join(outDir, "result.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { kind: "missing" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new FatalError(`UE result.json is not JSON: ${(e as Error).message.slice(0, 200)}`);
  }
  if (raw && typeof raw === "object" && (raw as { ok?: unknown }).ok === false) {
    const f = UeSceneFailure.safeParse(raw);
    if (!f.success) throw new FatalError(`UE failure result is malformed: ${f.error.message.slice(0, 400)}`);
    return { kind: "failure", failure: f.data };
  }
  const r = UeSceneResult.safeParse(raw);
  if (!r.success) throw new FatalError(`UE result.json failed validation: ${r.error.message.slice(0, 600)}`);
  return { kind: "ok", result: r.data };
}

/** A path inside root (no escape through "..", absolute names or symlinked directories). */
function inside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const rootReal = fs.realpathSync(root);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new FatalError(`UE output missing: ${rel}`);
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep))
    throw new FatalError(`UE result path escapes the job: ${rel}`);
  return abs;
}

/** Check a validated result against the job and the files on disk, then map it to the engine contract. */
export function toEngineOutput(
  r: UeSceneResult,
  outDir: string,
  job: UeSceneJob,
  extra: { warnings?: string[]; gpuName?: string | null; parts?: EngineRenderOutput["parts"] } = {},
): EngineRenderOutput {
  if (r.jobId !== job.jobId) throw new FatalError(`UE result is for job ${r.jobId}, expected ${job.jobId}`);
  if (r.template !== job.template) throw new FatalError(`UE result template ${r.template} ≠ ${job.template}`);
  if (r.product.sourceSha256 !== job.product.sha256)
    throw new FatalError("UE result is for another model file");
  const want = frameCount(job.durationSec, job.fps);
  const [w, h] = renderSize({ resolution: job.resolution, quality: job.quality });
  if (r.frames.count !== want) throw new FatalError(`UE rendered ${r.frames.count} frames, expected ${want}`);
  if (r.frames.width !== w || r.frames.height !== h)
    throw new FatalError(`UE frames are ${r.frames.width}x${r.frames.height}, expected ${w}x${h}`);
  if (r.frames.fps !== job.fps) throw new FatalError(`UE fps ${r.frames.fps} ≠ ${job.fps}`);
  const framesDir = inside(outDir, r.frames.dir);
  for (let i = 0; i < r.frames.count; i++) {
    const name = `f_${String(r.frames.startNumber + i).padStart(4, "0")}.png`;
    const file = path.join(framesDir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      throw new FatalError(`UE frame missing: frames/${name}`);
    }
    if (!st.isFile() || st.size === 0)
      throw new FatalError(`UE frame frames/${name} is not a regular PNG file`);
  }
  const warnings = [...r.warnings, ...(extra.warnings ?? [])];
  if (r.mock)
    warnings.unshift("MOCK render: produced by the fake UnrealEditor-Cmd test double, not by Unreal Engine");
  return {
    framesDir,
    framePattern: r.frames.pattern,
    startNumber: r.frames.startNumber,
    frameCount: r.frames.count,
    width: r.frames.width,
    height: r.frames.height,
    fps: r.frames.fps,
    alpha: false,
    productBoxes: r.productBoxes,
    anchorTracks: r.anchorTracks,
    controlViews: [],
    exports: { dimensionsM: r.product.dimsCm.map((v) => Math.round(v * 1000) / 100_000) },
    materialReport: r.materialReport ?? null,
    sceneFile: null,
    engineVersion: `Unreal Engine ${r.unreal.version}`.slice(0, 200),
    device: extra.gpuName ? `GPU ${extra.gpuName}` : "GPU",
    warnings,
    geometryHash: r.product.sourceSha256,
    materialHash: r.product.materialHash,
    parts: extra.parts ?? [],
    actions: [],
    timings: { totalMs: r.timings.totalMs, renderMs: r.timings.renderMs, frameMs: r.timings.frameMs },
    raw: r,
  };
}
