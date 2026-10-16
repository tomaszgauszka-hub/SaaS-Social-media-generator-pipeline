import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFromRoot } from "@cre/config";
import { FatalError, RetryableError } from "@cre/shared";
import { z } from "zod";
import type { Asset3D } from "../../contracts/asset.ts";
import {
  AnchorTrack,
  EngineUnavailableError,
  type EngineCapabilities,
  type EngineRenderOutput,
  type EngineRenderRequest,
  type RenderEngine,
} from "../../contracts/engine.ts";
import { isUnrealTemplate, type Recipe3D } from "../../contracts/recipe.ts";
import { detectGpu } from "../gpu.ts";
import { engineEnv, runEngineProcess } from "../proc.ts";

/*
 * Blender adapter: Recipe3D → scene job JSON → tools/blender/scenes/run.py (a Python with the bpy module, or a
 * Blender executable in background mode — e.g. the workstation's Blender 4.3) → validated result.json.
 *
 * The job names closed-set values only and the process gets a minimal environment; result.json is validated
 * (schema + file-name patterns + paths inside the job's output directory) before anything downstream trusts it.
 */

export const SCENES_DIR = resolveFromRoot("tools/blender/scenes");

export interface BlenderEngineOptions {
  blenderPython: string | null;
  blenderBin: string | null;
  scenesDir?: string;
  /** probe timeout (ms) */
  probeTimeoutMs?: number;
}

const Box = z.array(z.number()).length(4);
export const BlenderSceneResult = z
  .object({
    ok: z.literal(true),
    sceneVersion: z.string(),
    jobId: z.string(),
    template: z.string(),
    blender: z.object({ version: z.string(), versionString: z.string(), renderer: z.string() }).loose(),
    device: z.object({ device: z.string(), backend: z.string() }).loose(),
    frames: z
      .object({
        dir: z.literal("frames"),
        pattern: z.literal("f_%04d.png"),
        count: z.number().int().min(0),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        fps: z.number().int().positive(),
        alpha: z.boolean(),
      })
      .strict(),
    product: z
      .object({
        geometryHash: z.string().regex(/^[0-9a-f]{64}$/),
        materialHash: z.string().regex(/^[0-9a-f]{64}$/),
        parts: z.array(
          z
            .object({ name: z.string(), role: z.string(), verified: z.boolean(), internal: z.boolean() })
            .loose(),
        ),
        actions: z.array(z.string()),
      })
      .loose(),
    productBoxes: z.array(Box),
    anchorTracks: z.record(z.string(), AnchorTrack),
    controlViews: z.array(z.string().regex(/^views\/[a-z_]+\.png$/)),
    exports: z
      .object({
        files: z.record(z.string(), z.string()),
        dimensionsM: z.array(z.number()).length(3),
      })
      .loose()
      .nullable(),
    materialReport: z.unknown(),
    blend: z.literal("scene.blend").nullable(),
    missingTextures: z.array(z.string()),
    warnings: z.array(z.string()),
    timings: z.object({ totalMs: z.number(), renderMs: z.number(), frameMs: z.array(z.number()) }).loose(),
  })
  .loose();
export type BlenderSceneResult = z.infer<typeof BlenderSceneResult>;

const FORMATS = new Set(["glb", "gltf", "obj", "fbx", "blend"]);

/** The scene job the Python generators consume (tools/blender/scenes/scene_spec.py). */
export function buildSceneJob(
  req: Pick<
    EngineRenderRequest,
    "jobId" | "recipe" | "product" | "productFile" | "device" | "renderer" | "threads"
  >,
  outDir: string,
): Record<string, unknown> {
  const r: Recipe3D = req.recipe;
  if (isUnrealTemplate(r.template)) throw new FatalError(`${r.template} is an Unreal template`);
  const p: Asset3D = req.product;
  let product: Record<string, unknown>;
  if (p.generator) {
    product = {
      source: "procedural",
      generator: p.generator.name,
      params: p.generator.params,
      fidelity: p.fidelity,
      assetId: p.assetId,
      structureVerified: p.structureVerified,
    };
  } else {
    if (!req.productFile) throw new FatalError(`${p.assetId} has no model file to render`);
    const ext = path.extname(req.productFile).slice(1).toLowerCase();
    if (!FORMATS.has(ext)) throw new FatalError(`unsupported model format .${ext}`);
    product = {
      source: "file",
      path: path.resolve(req.productFile),
      format: ext,
      realHeightM: p.dimensionsM ? p.dimensionsM[2] : null,
      emitsLight: p.actions.includes("LIGHT_ON"),
      hints: [],
      fidelity: p.fidelity,
      assetId: p.assetId,
      structureVerified: p.structureVerified,
    };
  }
  const exportFormats = [
    ...(r.outputs.includes("export_glb") ? ["glb"] : []),
    ...(r.outputs.includes("export_fbx") ? ["fbx"] : []),
  ];
  return {
    version: 1,
    jobId: req.jobId,
    template: r.template,
    quality: r.quality,
    device: req.device,
    renderer: req.renderer ?? "CYCLES",
    durationSec: r.durationSec,
    fps: r.fps,
    resolution: r.resolution,
    seed: r.seed,
    threads: req.threads,
    turns: r.turns,
    framing: r.framing,
    camera: r.camera,
    lighting: r.lighting,
    background: r.background,
    ...(r.environment ? { environment: r.environment } : {}),
    ...(r.focus ? { focus: r.focus } : {}),
    actions: r.actions,
    product,
    outputs: {
      frames: true,
      alpha: r.outputs.includes("alpha") || r.background.preset === "transparent",
      controlViews: r.outputs.includes("control_views"),
      blend: r.outputs.includes("blend"),
      export: exportFormats,
    },
    output: { dir: path.resolve(outDir) },
  };
}

export function blenderCommand(
  opts: Pick<BlenderEngineOptions, "blenderPython" | "blenderBin">,
  script: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (opts.blenderPython) return { command: opts.blenderPython, args: ["-B", script, ...args] };
  if (opts.blenderBin)
    return {
      command: opts.blenderBin,
      args: [
        "-b",
        "--factory-startup",
        "-noaudio",
        "--python-exit-code",
        "1",
        "--python",
        script,
        "--",
        ...args,
      ],
    };
  throw new EngineUnavailableError(
    "blender",
    "set BLENDER_PYTHON (bpy module) or BLENDER_BIN (Blender executable)",
  );
}

export function parseSceneProgress(line: string): { frame: number; total: number; ms?: number } | null {
  const m = /^PROGRESS job=\S+ frame=(\d+)\/(\d+)(?: ms=(\d+))?/.exec(line.trim());
  if (!m) return null;
  return { frame: Number(m[1]), total: Number(m[2]), ...(m[3] ? { ms: Number(m[3]) } : {}) };
}

/** "4.3.0" from "bpy 4.3.0 …" / "Blender 4.3.0 …" probe output. */
export function parseBlenderVersion(out: string): string | null {
  const m = /(?:^|\s)(?:bpy|Blender)\s+(\d+\.\d+(?:\.\d+)?)/m.exec(out);
  return m ? m[1]! : null;
}

export class BlenderEngine implements RenderEngine {
  readonly id = "blender" as const;
  private probed: Promise<EngineCapabilities> | null = null;
  private readonly scenesDir: string;

  constructor(private readonly opts: BlenderEngineOptions) {
    this.scenesDir = opts.scenesDir ?? SCENES_DIR;
  }

  probe(): Promise<EngineCapabilities> {
    this.probed ??= this.doProbe();
    this.probed.catch(() => (this.probed = null));
    return this.probed;
  }

  private async doProbe(): Promise<EngineCapabilities> {
    const gpu = detectGpu();
    const base = { engine: "blender" as const, gpu, host: os.hostname() };
    const exe = this.opts.blenderPython ?? this.opts.blenderBin;
    if (!exe || !fs.existsSync(exe))
      return {
        ...base,
        available: false,
        version: null,
        reason: "Blender not configured (BLENDER_PYTHON / BLENDER_BIN)",
        renderers: [],
      };
    const probe = this.opts.blenderPython
      ? { command: this.opts.blenderPython, args: ["-c", "import bpy; print('bpy', bpy.app.version_string)"] }
      : { command: this.opts.blenderBin!, args: ["-b", "--factory-startup", "--version"] };
    try {
      const r = await runEngineProcess(probe.command, probe.args, {
        env: engineEnv(),
        timeoutMs: this.opts.probeTimeoutMs ?? 120_000,
      });
      const version = parseBlenderVersion(r.stdout);
      if (!version)
        return {
          ...base,
          available: false,
          version: null,
          reason: "cannot read the Blender version",
          renderers: [],
        };
      const [maj, min] = version.split(".").map(Number);
      if (maj! < 4 || (maj === 4 && min! < 2))
        return {
          ...base,
          available: false,
          version: `Blender ${version}`,
          reason: "Blender 4.2 or newer is required",
          renderers: [],
        };
      return {
        ...base,
        available: true,
        version: `Blender ${version}`,
        reason: null,
        renderers: gpu.available ? ["CYCLES", "EEVEE"] : ["CYCLES"],
      };
    } catch (e) {
      return {
        ...base,
        available: false,
        version: null,
        reason: `probe failed: ${(e as Error).message.slice(0, 300)}`,
        renderers: [],
      };
    }
  }

  async render(req: EngineRenderRequest): Promise<EngineRenderOutput> {
    const caps = await this.probe();
    if (!caps.available) throw new EngineUnavailableError("blender", caps.reason ?? "unavailable");
    const outDir = path.join(req.workDir, "out");
    fs.mkdirSync(outDir, { recursive: true });
    const jobFile = path.join(req.workDir, "scene-job.json");
    fs.writeFileSync(jobFile, JSON.stringify(buildSceneJob(req, outDir), null, 2));
    const cmd = blenderCommand(this.opts, path.join(this.scenesDir, "run.py"), [jobFile]);
    const log = fs.createWriteStream(path.join(req.workDir, "blender.log"));
    try {
      await runEngineProcess(cmd.command, cmd.args, {
        env: engineEnv(req.threads > 0 ? { BLENDER_THREADS: String(req.threads) } : {}),
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.onSpawn ? { onSpawn: req.onSpawn } : {}),
        onLine: (line) => {
          log.write(`${line}\n`);
          const p = parseSceneProgress(line);
          if (p) req.onProgress?.(p);
        },
      });
    } catch (e) {
      const res = (e as { result?: { code: number; stderr: string } }).result;
      if (res?.code === 3) throw new FatalError(`invalid scene job: ${res.stderr.slice(-600)}`);
      if (e instanceof FatalError && /out of memory|CUDA error|OPTIX|Killed|bad_alloc/i.test(e.message))
        throw new RetryableError(`Blender ran out of resources: ${e.message.slice(0, 400)}`);
      throw e;
    } finally {
      log.end();
    }
    return this.readResult(outDir);
  }

  /** Validate result.json and resolve every file it names inside the output directory. */
  readResult(outDir: string): EngineRenderOutput {
    const file = path.join(outDir, "result.json");
    if (!fs.existsSync(file)) throw new FatalError("Blender finished without result.json");
    const r = BlenderSceneResult.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    const inside = (rel: string) => {
      const abs = path.resolve(outDir, rel);
      if (!abs.startsWith(path.resolve(outDir) + path.sep))
        throw new FatalError(`result path escapes the job: ${rel}`);
      return abs;
    };
    const framesDir = inside(r.frames.dir);
    const exportsOut: EngineRenderOutput["exports"] = {};
    if (r.exports) {
      for (const [k, v] of Object.entries(r.exports.files)) {
        const abs = path.resolve(v);
        if (!abs.startsWith(path.resolve(outDir) + path.sep))
          throw new FatalError(`export path escapes the job: ${v}`);
        if (k === "glb" || k === "fbx") exportsOut[k] = abs;
      }
      exportsOut.dimensionsM = r.exports.dimensionsM;
      exportsOut.report = r.exports;
    }
    return {
      framesDir,
      framePattern: r.frames.pattern,
      startNumber: 1,
      frameCount: r.frames.count,
      width: r.frames.width,
      height: r.frames.height,
      fps: r.frames.fps,
      alpha: r.frames.alpha,
      productBoxes: r.productBoxes,
      anchorTracks: r.anchorTracks,
      controlViews: r.controlViews.map(inside),
      exports: exportsOut,
      materialReport: r.materialReport,
      sceneFile: r.blend ? inside(r.blend) : null,
      engineVersion: `Blender ${r.blender.version}`,
      device: r.device.device === "GPU" ? `GPU ${r.device.backend}` : "CPU",
      warnings: [...r.warnings, ...r.missingTextures.map((t) => `missing texture: ${t}`)],
      geometryHash: r.product.geometryHash,
      materialHash: r.product.materialHash,
      parts: r.product.parts.map((p) => ({
        name: p.name,
        role: p.role,
        verified: p.verified,
        internal: p.internal,
      })),
      actions: r.product.actions,
      timings: { totalMs: r.timings.totalMs, renderMs: r.timings.renderMs, frameMs: r.timings.frameMs },
      raw: r,
    };
  }
}
