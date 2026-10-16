import type { Env } from "@cre/config";
import type { RenderEngine } from "../../contracts/engine.ts";
import { UnrealEngine, type UnrealEngineOptions } from "./batch.ts";
import { resolveUnrealConfig } from "./config.ts";

export * from "./config.ts";
export * from "./detect.ts";
export * from "./job.ts";
export * from "./result.ts";
export * from "./batch.ts";
export * from "./remote-exec.ts";

/**
 * Factory for setup.ts registerUnrealFactory(): the Unreal adapter configured from @cre/config's Env (UE_EDITOR_CMD,
 * UE_PROJECT, UE_RENDER_TIMEOUT_MS, UE_REMOTE_EXEC_PORT) plus the optional UE_* variables of the process environment.
 * It never throws for a missing install: the engine then probes as unavailable with the reason.
 */
export function createUnrealEngine(
  env: Partial<Pick<Env, "UE_EDITOR_CMD" | "UE_PROJECT" | "UE_RENDER_TIMEOUT_MS" | "UE_REMOTE_EXEC_PORT">>,
  opts: Omit<UnrealEngineOptions, "config"> = {},
  processEnv: NodeJS.ProcessEnv = process.env,
): RenderEngine {
  return new UnrealEngine({ ...opts, config: resolveUnrealConfig({}, env, processEnv) });
}
