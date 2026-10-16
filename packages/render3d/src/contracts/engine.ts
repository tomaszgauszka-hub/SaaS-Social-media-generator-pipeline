import { z } from "zod";
import type { Asset3D } from "./asset.ts";
import type { Recipe3D } from "./recipe.ts";

/*
 * Render engine adapter contract. An adapter turns one validated recipe into a numbered PNG sequence + an engine
 * result (product boxes, anchor tracks, control views, exports). Everything after that — encoding, clip QA,
 * storage, library, telemetry, cost — is engine-independent and lives in the render worker.
 *
 * Adapters run local processes only (Blender as a module / executable, UnrealEditor-Cmd), never through a shell,
 * and never execute model-written code: the process gets a JSON job naming closed-set values.
 */

export type EngineId = "blender" | "unreal";

export interface GpuInfo {
  available: boolean;
  name: string | null;
  vramMb: number | null;
}

export interface EngineCapabilities {
  engine: EngineId;
  available: boolean;
  /** e.g. "Blender 4.3.0", "Unreal Engine 5.8.1" */
  version: string | null;
  /** why the engine is not available (missing executable, project, plugin …) */
  reason: string | null;
  gpu: GpuInfo;
  /** e.g. ["CYCLES", "EEVEE"] or ["MRQ"] */
  renderers: string[];
  /** where the engine runs (hostname) */
  host: string;
}

export interface EngineProgress {
  frame: number;
  total: number;
  ms?: number;
}

export interface EngineRenderRequest {
  jobId: string;
  recipe: Recipe3D;
  /** the product model being shown */
  product: Asset3D;
  /** local path of the product's source model file (imported models); null for procedural models */
  productFile: string | null;
  /** scratch directory owned by this render (frames, logs, job json) */
  workDir: string;
  device: "CPU" | "GPU" | "AUTO";
  renderer?: "CYCLES" | "EEVEE";
  threads: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (p: EngineProgress) => void;
  /** called with the child pid once the engine process starts (resource sampling) */
  onSpawn?: (pid: number) => void;
}

export const AnchorTrack = z.array(z.union([z.tuple([z.number(), z.number()]), z.null()]));

export interface EngineRenderOutput {
  framesDir: string;
  /** printf-style pattern inside framesDir, e.g. "f_%04d.png" */
  framePattern: string;
  /** first frame number of the sequence */
  startNumber: number;
  frameCount: number;
  width: number;
  height: number;
  fps: number;
  alpha: boolean;
  /** [u0, v0, u1, v1] per frame, normalised frame coordinates (may exceed 0–1 when out of frame) */
  productBoxes: number[][];
  anchorTracks: Record<string, ([number, number] | null)[]>;
  controlViews: string[];
  exports: { glb?: string; fbx?: string; report?: unknown; dimensionsM?: number[] };
  materialReport: unknown;
  sceneFile: string | null;
  engineVersion: string;
  device: string;
  warnings: string[];
  geometryHash: string | null;
  materialHash: string | null;
  parts: { name: string; role: string; verified: boolean; internal: boolean }[];
  actions: string[];
  timings: { totalMs: number; renderMs: number; frameMs: number[] };
  /** the raw engine result.json (kept as the clip's metadata file) */
  raw: Record<string, unknown>;
}

export interface RenderEngine {
  readonly id: EngineId;
  probe(): Promise<EngineCapabilities>;
  render(req: EngineRenderRequest): Promise<EngineRenderOutput>;
}

/** Engine not reachable right now (render station off, editor closed): the job waits and resumes later. */
export class EngineUnavailableError extends Error {
  constructor(
    readonly engine: EngineId,
    readonly reason: string,
  ) {
    super(`${engine} unavailable: ${reason}`);
    this.name = "EngineUnavailableError";
  }
}
