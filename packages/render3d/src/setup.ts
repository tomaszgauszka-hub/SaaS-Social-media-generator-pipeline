import os from "node:os";
import path from "node:path";
import { getEnv, resolveFromRoot, type Env } from "@cre/config";
import { createStorageProvider, type StorageProvider } from "@cre/providers";
import { resolveReelTools } from "@cre/reel";
import type { RenderEngine } from "./contracts/engine.ts";
import { costAssumptionsFromEnv } from "./cost/local.ts";
import { BlenderEngine } from "./engines/blender/adapter.ts";
import { UnavailableEngine } from "./engines/unavailable.ts";
import { FileAssetLibrary, type AssetLibrary3D } from "./library/library.ts";
import { RenderWorker3D, type RenderWorkerOptions } from "./worker/render-worker.ts";

/*
 * Wiring from configuration: storage (the app's Storage provider), library, engines and the render worker.
 * Engine executables come from env only (never from a request or a model).
 */

export interface Render3DSetup {
  env: Env;
  storage: StorageProvider;
  library: AssetLibrary3D;
  blender: RenderEngine;
  unreal: RenderEngine;
  worker: RenderWorker3D;
  dataDir: string;
}

export interface Render3DOverrides {
  library?: AssetLibrary3D;
  storage?: StorageProvider;
  blender?: RenderEngine;
  unreal?: RenderEngine;
  worker?: Partial<RenderWorkerOptions>;
}

/** Unreal adapter factory (set by the Unreal module; until then Unreal probes as unavailable). */
let unrealFactory: ((env: Env) => RenderEngine) | null = null;
export function registerUnrealFactory(f: (env: Env) => RenderEngine): void {
  unrealFactory = f;
}

export function createRender3D(env: Env = getEnv(), o: Render3DOverrides = {}): Render3DSetup {
  const tools = resolveReelTools(env);
  const dataDir = resolveFromRoot(env.RENDER3D_DATA_DIR);
  const storage = o.storage ?? createStorageProvider(env);
  const library = o.library ?? new FileAssetLibrary(path.join(dataDir, "library"), storage);
  const blender =
    o.blender ?? new BlenderEngine({ blenderPython: tools.blenderPython, blenderBin: tools.blenderBin });
  const unreal =
    o.unreal ??
    (unrealFactory
      ? unrealFactory(env)
      : new UnavailableEngine("unreal", "Unreal Engine adapter not configured (UE_EDITOR_CMD / UE_PROJECT)"));
  const worker = new RenderWorker3D({
    library,
    engines: { blender, unreal },
    workRoot: path.join(dataDir, "work"),
    lockDir: path.join(tools.cacheDir, "locks"),
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    heavySlots: env.RENDER3D_MAX_CONCURRENT,
    blenderSlots: env.BLENDER_MAX_CONCURRENT,
    device: env.RENDER3D_DEVICE,
    threads: env.BLENDER_THREADS,
    cost: costAssumptionsFromEnv(process.env),
    router: {
      skip3dWhenWorkerOffline: env.RENDER3D_SKIP_WHEN_OFFLINE,
      minValueFor3d: env.RENDER3D_MIN_VALUE,
    },
    minFreeRamMb: Math.min(1500, Math.round(os.totalmem() / 1048576 / 8)),
    ...o.worker,
  });
  return { env, storage, library, blender, unreal, worker, dataDir };
}
