import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withResourceLock } from "@cre/reel";
import { DeferredError, FatalError, RetryableError } from "@cre/shared";
import {
  inheritProvenance,
  type Asset3D,
  type ClipQaReport,
  type RenderTelemetry,
} from "../contracts/asset.ts";
import { EngineUnavailableError, type EngineCapabilities, type RenderEngine } from "../contracts/engine.ts";
import { Recipe3D, TEMPLATE_MATERIAL, type Recipe3DInput } from "../contracts/recipe.ts";
import { visualKey } from "../cache/keys.ts";
import { localRenderCost, type LocalCost, type LocalCostAssumptions } from "../cost/local.ts";
import { encodeClip } from "../engines/encode.ts";
import type { AssetLibrary3D, LibraryFile } from "../library/library.ts";
import { runClipQa } from "../qa/clip-qa.ts";
import { frameCount, renderSize } from "../routing/estimate.ts";
import { routeRender, type RouteDecision, type RouterSettings } from "../routing/router.ts";
import { ResourceSampler } from "./telemetry.ts";

/*
 * Render worker for 3D clips. Runs without any conversation with an LLM: it executes saved recipes through local
 * engines, one validated job at a time per resource slot.
 *
 *   route (library / 2D / Blender / Unreal) → reserve resources (host-wide heavy-render semaphore shared by
 *   Blender and Unreal + the engine's own slot + free-memory check) → render with timeout, abort and resource
 *   sampling → encode → clip QA → store in the library (Storage + metadata) → telemetry + local cost.
 *
 * Failures are classified for the job runner: engine offline / not enough memory → DeferredError (parked,
 * resumed later, no attempt used), crashes / timeouts → RetryableError, invalid recipes → FatalError.
 * Temporary files are removed on success and failure (the log tail is kept in the error).
 */

export interface RenderWorkerOptions {
  library: AssetLibrary3D;
  engines: { blender: RenderEngine; unreal: RenderEngine };
  workRoot: string;
  lockDir: string;
  ffmpeg: string;
  ffprobe: string;
  /** heavy renders (Blender or Unreal) at once on this host */
  heavySlots: number;
  /** Blender processes at once — the same "blender" lock the reel studio uses */
  blenderSlots: number;
  device: "CPU" | "GPU" | "AUTO";
  threads: number;
  cost: LocalCostAssumptions;
  router?: Partial<RouterSettings>;
  /** keep the PNG frames after encoding (debugging) */
  keepFrames?: boolean;
  /** longest wait for a free render slot (ms) */
  lockTimeoutMs?: number;
  /** below this much available memory (MB) a render is deferred */
  minFreeRamMb?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface RenderJob3D {
  jobId: string;
  recipe: Recipe3DInput;
  valueScore?: number;
  brandId?: string | null;
  /** production renders need an owner-approved preview of the same recipe */
  requireApprovedPreview?: boolean;
}

export interface RenderJob3DResult {
  decision: RouteDecision;
  /** the clip (new or reused); null when routed to the 2D pipeline */
  asset: Asset3D | null;
  reused: boolean;
  cost: LocalCost | null;
  qa: ClipQaReport | null;
  telemetry: RenderTelemetry | null;
}

/** Available memory (MB): /proc/meminfo MemAvailable, else os.freemem(). */
export function availableMemoryMb(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {
    /* not Linux */
  }
  return Math.round(os.freemem() / 1048576);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : null;
};

export class RenderWorker3D {
  private caps: { at: number; blender: EngineCapabilities; unreal: EngineCapabilities } | null = null;

  constructor(private readonly o: RenderWorkerOptions) {}

  private log(msg: string, data?: Record<string, unknown>) {
    this.o.log?.(msg, data);
  }

  async capabilities(force = false): Promise<{ blender: EngineCapabilities; unreal: EngineCapabilities }> {
    if (!force && this.caps && Date.now() - this.caps.at < 60_000) return this.caps;
    const [blender, unreal] = await Promise.all([
      this.o.engines.blender.probe(),
      this.o.engines.unreal.probe(),
    ]);
    this.caps = { at: Date.now(), blender, unreal };
    return this.caps;
  }

  async route(job: RenderJob3D, workerOnline = true): Promise<RouteDecision> {
    const recipe = Recipe3D.parse(job.recipe);
    const product = await this.o.library.get(recipe.productAssetId);
    const caps = await this.capabilities();
    return routeRender(
      { recipe, product, ...(job.valueScore !== undefined ? { valueScore: job.valueScore } : {}) },
      {
        ...caps,
        workerOnline,
        library: this.o.library,
        history: await this.o.library.timingHistory(),
        ...(this.o.router ? { settings: this.o.router } : {}),
        cost: this.o.cost,
      },
    );
  }

  async run(
    job: RenderJob3D,
    opts: {
      signal?: AbortSignal;
      onProgress?: (frame: number, total: number) => void;
      timeoutMs?: number;
    } = {},
  ): Promise<RenderJob3DResult> {
    const decision = await this.route(job);
    this.log("render3d.route", { jobId: job.jobId, engine: decision.engine, reasons: decision.reasons });
    switch (decision.engine) {
      case "EXISTING_ASSET":
        return {
          decision,
          asset: decision.existingAsset,
          reused: true,
          cost: null,
          qa: decision.existingAsset?.qa ?? null,
          telemetry: decision.existingAsset?.telemetry
            ? { ...decision.existingAsset.telemetry, cacheHit: true, renderDurationMs: 0, framesRendered: 0 }
            : null,
        };
      case "PROGRAMMATIC_2D":
        return { decision, asset: null, reused: false, cost: null, qa: null, telemetry: null };
      case "BLOCKED":
        throw new FatalError(`3D render blocked: ${decision.reasons.join("; ")}`);
      case "DEFER":
        throw new DeferredError(`3D render deferred: ${decision.reasons.join("; ")}`);
      case "EXTERNAL_AI":
        throw new FatalError("external AI generation is not enabled for 3D clips (BudgetGuard policy)");
      case "BLENDER":
      case "UNREAL":
        break;
    }
    const recipe = decision.recipe!;
    const product = (await this.o.library.get(recipe.productAssetId))!;
    if (recipe.quality === "production" && job.requireApprovedPreview) {
      const previewKey = visualKey(Recipe3D.parse({ ...recipe, quality: "preview" }), product);
      const preview = await this.o.library.findByVisualKey(previewKey);
      if (preview?.approval.status !== "APPROVED")
        throw new FatalError(
          `production render of ${recipe.template} needs an approved preview first` +
            (preview
              ? ` (preview ${preview.assetId} is ${preview.approval.status})`
              : " (no preview rendered yet)"),
        );
    }
    const engine = decision.engine === "UNREAL" ? this.o.engines.unreal : this.o.engines.blender;
    const est = decision.estimate!;
    const free = availableMemoryMb();
    const needMb = Math.max(this.o.minFreeRamMb ?? 1500, est.peakRamMb);
    if (free < needMb)
      throw new DeferredError(
        `not enough free memory for ${engine.id}: ${free} MB available, ${needMb} MB needed`,
        120_000,
      );

    const work = path.join(this.o.workRoot, `${job.jobId}-${Date.now().toString(36)}`);
    await fsp.mkdir(work, { recursive: true });
    const timeoutMs = opts.timeoutMs ?? Math.max(10 * 60_000, Math.round(est.totalMs * 4));
    const lockOpts = {
      timeoutMs: this.o.lockTimeoutMs ?? 6 * 3_600_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    try {
      return await withResourceLock(
        this.o.lockDir,
        "render-heavy",
        this.o.heavySlots,
        async () => {
          const inner = async () =>
            this.renderLocked(job, decision, recipe, product, engine, work, timeoutMs, opts);
          return engine.id === "blender"
            ? await withResourceLock(this.o.lockDir, "blender", this.o.blenderSlots, inner, lockOpts)
            : await withResourceLock(this.o.lockDir, "unreal", 1, inner, lockOpts);
        },
        lockOpts,
      );
    } catch (e) {
      if (e instanceof EngineUnavailableError) throw new DeferredError(e.message);
      throw e;
    } finally {
      if (!this.o.keepFrames) await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * The model file Unreal imports: the product's FBX / glTF export, made once by Blender (UE conventions, material
   * report) and kept on the product's library record — an unchanged model is never exported or imported again.
   */
  private async unrealModelFile(product: Asset3D, work: string, signal?: AbortSignal): Promise<string> {
    const existing =
      (await this.o.library.localPath(product, "fbx")) ?? (await this.o.library.localPath(product, "glb"));
    if (existing) return existing;
    const src = product.outputFiles.find((f) => f.role === "source_model");
    if (src && /\.(fbx|glb)$/i.test(src.key))
      return (await this.o.library.localPath(product, "source_model"))!;
    const blender = this.o.engines.blender;
    if (!canExport(blender)) throw new FatalError("no Blender exporter to prepare the model for Unreal");
    const file = product.generator ? null : await this.o.library.localPath(product, "source_model");
    const exp = await blender.exportModel(product, file, work, { ...(signal ? { signal } : {}) });
    const files: LibraryFile[] = [];
    if (exp.fbx) files.push({ role: "fbx", localPath: exp.fbx, contentType: "application/octet-stream" });
    if (exp.glb) files.push({ role: "glb", localPath: exp.glb, contentType: "model/gltf-binary" });
    if (!files.length) throw new FatalError(`Blender exported no model for ${product.assetId}`);
    const stored = await this.o.library.put(product, files);
    this.log("render3d.model_export", { product: product.assetId, report: exp.report });
    return ((await this.o.library.localPath(stored, "fbx")) ??
      (await this.o.library.localPath(stored, "glb")))!;
  }

  private async renderLocked(
    job: RenderJob3D,
    decision: RouteDecision,
    recipe: Recipe3D,
    product: Asset3D,
    engine: RenderEngine,
    work: string,
    timeoutMs: number,
    opts: { signal?: AbortSignal; onProgress?: (frame: number, total: number) => void },
  ): Promise<RenderJob3DResult> {
    const caps = await this.capabilities();
    const engineCaps = engine.id === "unreal" ? caps.unreal : caps.blender;
    const sampler = new ResourceSampler(1000, engineCaps.gpu.available);
    const productFile =
      engine.id === "unreal"
        ? await this.unrealModelFile(product, work, opts.signal)
        : product.generator
          ? null
          : await this.o.library.localPath(product, "source_model");
    const t0 = Date.now();
    let failure: string | null = null;
    let out;
    try {
      out = await engine.render({
        jobId: job.jobId,
        recipe,
        product,
        productFile,
        workDir: work,
        device: this.o.device,
        threads: this.o.threads,
        timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
        onSpawn: (pid) => sampler.start(pid),
        onProgress: (p) => opts.onProgress?.(p.frame, p.total),
      });
    } catch (e) {
      failure = (e as Error).message.slice(0, 500);
      throw e instanceof FatalError || e instanceof RetryableError || e instanceof EngineUnavailableError
        ? e
        : new RetryableError(`${engine.id} render failed: ${failure}`);
    } finally {
      const res = sampler.stop();
      if (failure) this.log("render3d.failure", { jobId: job.jobId, engine: engine.id, failure, ...res });
    }
    const renderMs = Date.now() - t0;
    const resources = sampler.stop();
    const frames = frameCount(recipe.durationSec, recipe.fps);
    const enc = await encodeClip(out, path.join(work, "encoded"), {
      ffmpeg: this.o.ffmpeg,
      quality: recipe.quality,
      fps: recipe.fps,
      frames,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const [w, h] = renderSize(recipe);
    const qa = await runClipQa({
      video: enc.video,
      render: out,
      expected: {
        width: engine.id === "unreal" ? out.width : w,
        height: engine.id === "unreal" ? out.height : h,
        fps: recipe.fps,
        frames,
      },
      dimensionsM: product.dimensionsM,
      allowEarlyOutOfFrame: recipe.template === "PRODUCT_ASSEMBLY",
      controlViewsRequested: recipe.outputs.includes("control_views"),
      ffmpeg: this.o.ffmpeg,
      ffprobe: this.o.ffprobe,
    });
    const device = out.device.startsWith("GPU") ? "GPU" : "CPU";
    const cost = localRenderCost(renderMs + enc.encodeMs, device, this.o.cost);
    const metaFile = path.join(work, "encoded", "metadata.json");
    const outputSize = [enc.video, enc.alphaVideo, enc.thumbnail]
      .filter((f): f is string => Boolean(f))
      .reduce((n, f) => n + fs.statSync(f).size, 0);
    const telemetry: RenderTelemetry = {
      engine: engine.id,
      template: recipe.template,
      modelSource: product.source,
      renderDurationMs: renderMs,
      peakRamMb: resources.peakRamMb,
      peakVramMb: resources.peakVramMb,
      cpuUsagePct: resources.cpuUsagePct,
      gpuUsagePct: resources.gpuUsagePct,
      outputSizeBytes: outputSize,
      framesRendered: out.frameCount,
      cacheHit: false,
      failureReason: null,
      device: out.device,
      host: os.hostname(),
      perFrameMsMedian: median(out.timings.frameMs),
    };
    fs.writeFileSync(
      metaFile,
      JSON.stringify(
        {
          recipe,
          decision: { engine: decision.engine, reasons: decision.reasons, rejected: decision.rejected },
          productBoxes: out.productBoxes,
          anchorTracks: out.anchorTracks,
          parts: out.parts,
          materialReport: out.materialReport,
          exports: out.exports.report ?? null,
          warnings: out.warnings,
          qa,
          telemetry,
          cost,
        },
        null,
        1,
      ),
    );
    const files: LibraryFile[] = [
      { role: "video", localPath: enc.video, contentType: "video/mp4" },
      { role: "thumbnail", localPath: enc.thumbnail, contentType: "image/jpeg" },
      { role: "metadata", localPath: metaFile, contentType: "application/json" },
    ];
    if (enc.alphaVideo)
      files.push({ role: "alpha_video", localPath: enc.alphaVideo, contentType: "video/webm" });
    if (enc.controlSheet)
      files.push({ role: "control_sheet", localPath: enc.controlSheet, contentType: "image/jpeg" });
    if (out.sceneFile)
      files.push({ role: engine.id === "unreal" ? "ue_level" : "blend", localPath: out.sceneFile });
    if (out.exports.glb)
      files.push({ role: "glb", localPath: out.exports.glb, contentType: "model/gltf-binary" });
    if (out.exports.fbx)
      files.push({ role: "fbx", localPath: out.exports.fbx, contentType: "application/octet-stream" });

    const existing = await this.o.library.get(clipId(decision.recipeHash!));
    const assetId =
      existing?.approval.status === "REJECTED"
        ? `${clipId(decision.recipeHash!)}-r${Date.now().toString(36)}`
        : clipId(decision.recipeHash!);
    const asset = await this.o.library.put(
      {
        assetId,
        assetType: "RENDER_CLIP",
        productId: product.productId,
        brandId: job.brandId ?? product.brandId,
        category: product.category,
        source: `render:${decision.recipeHash}`,
        ...inheritProvenance(product),
        structureVerified: product.structureVerified,
        engine: engine.id,
        engineVersion: out.engineVersion,
        version: 1,
        geometryHash: out.geometryHash,
        materialHash: out.materialHash,
        renderSettingsHash: decision.engineIdentity,
        recipeHash: decision.recipeHash,
        visualKey: decision.visualKey,
        durationMs: Math.round((out.frameCount / out.fps) * 1000),
        resolution: [out.width, out.height],
        fps: out.fps,
        renderTimeMs: renderMs,
        renderCostEstimateUsd: cost.usd,
        createdAt: new Date().toISOString(),
        parts: out.parts.map((p) => ({
          name: p.name,
          role: p.role,
          verified: p.verified,
          internal: p.internal,
        })),
        materialType: TEMPLATE_MATERIAL[recipe.template],
        template: recipe.template,
        quality: recipe.quality,
        parentAssetIds: [product.assetId],
        telemetry,
        qa,
      },
      files,
    );
    if (product.geometryHash && out.geometryHash && product.geometryHash !== out.geometryHash)
      this.log("render3d.geometry_drift", {
        product: product.assetId,
        stored: product.geometryHash,
        rendered: out.geometryHash,
      });
    if (!product.geometryHash && out.geometryHash)
      await this.o.library.put({
        ...product,
        geometryHash: out.geometryHash,
        materialHash: out.materialHash,
      });
    this.log("render3d.done", {
      jobId: job.jobId,
      assetId: asset.assetId,
      renderMs,
      qa: qa.score,
      costUsd: cost.usd,
    });
    return { decision, asset, reused: false, cost, qa, telemetry };
  }
}

export const clipId = (recipeHash: string): string => `clip-${recipeHash.slice(0, 20)}`;

/** Blender adapters can export a product model for Unreal (duck-typed: test engines need not). */
interface ModelExporter {
  exportModel(
    product: Asset3D,
    productFile: string | null,
    workDir: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ fbx: string | null; glb: string | null; report: unknown; dimensionsM: number[] | null }>;
}
const canExport = (e: RenderEngine): e is RenderEngine & ModelExporter =>
  typeof (e as Partial<ModelExporter>).exportModel === "function";
