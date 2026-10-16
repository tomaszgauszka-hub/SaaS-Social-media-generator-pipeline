import { resolveFromRoot, type Env } from "@cre/config";
import { z } from "zod";

/*
 * Unreal adapter configuration. Tool paths come from configuration only (never from a request or a model):
 *   UE_EDITOR_CMD                 UnrealEditor-Cmd(.exe) of the UE 5.x install (unset: common Windows install
 *                                 paths are searched, see detect.ts)
 *   UE_PROJECT                    the dedicated render .uproject (tools/unreal/ue_project.py init) — never a game
 *   UE_RENDER_TIMEOUT_MS          optional hard limit of one render (default: the worker's request timeout)
 *   UE_REMOTE_EXEC_PORT           optional Python remote execution multicast group port (default 6766)
 * read from @cre/config's Env, plus these optional ones read from the process environment here:
 *   UE_STARTUP_TIMEOUT_MS         editor start → ue_scene.py running (default 20 min: first start compiles shaders)
 *   UE_REMOTE_EXEC_COMMAND_PORT   TCP command port the remote-exec client listens on (default 6776)
 *   UE_REMOTE_EXEC_GROUP          multicast group address (default 239.0.0.1)
 *   UE_MRQ_EXECUTOR               pie (default) | new_process
 *   UE_GI_MODE                    auto (default) | lumen | screen_space
 */

export const UE_EXECUTORS = ["pie", "new_process"] as const;
export type UeExecutor = (typeof UE_EXECUTORS)[number];
export const UE_GI_MODES = ["auto", "lumen", "screen_space"] as const;
export type UeGiMode = (typeof UE_GI_MODES)[number];

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optInt = (min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).optional());
const optPath = z.preprocess(
  blankToUndefined,
  z
    .string()
    .max(1024)
    .refine((s) => !/[\0\r\n]/.test(s), "no control characters")
    .optional(),
);

/** Every UE setting the adapter reads (validated even when it arrives through @cre/config's Env). */
export const UnrealEnvSchema = z.object({
  UE_EDITOR_CMD: optPath,
  UE_PROJECT: optPath,
  UE_RENDER_TIMEOUT_MS: optInt(60_000, 48 * 3_600_000),
  UE_REMOTE_EXEC_PORT: optInt(1024, 65535),
  UE_STARTUP_TIMEOUT_MS: optInt(30_000, 6 * 3_600_000),
  UE_REMOTE_EXEC_COMMAND_PORT: optInt(1024, 65535),
  UE_REMOTE_EXEC_GROUP: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^(22[4-9]|23\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/, "an IPv4 multicast address")
      .optional(),
  ),
  UE_MRQ_EXECUTOR: z.preprocess(blankToUndefined, z.enum(UE_EXECUTORS).optional()),
  UE_GI_MODE: z.preprocess(blankToUndefined, z.enum(UE_GI_MODES).optional()),
});
export type UnrealEnv = z.infer<typeof UnrealEnvSchema>;

export type UnrealEnvInput = Partial<
  Pick<Env, "UE_EDITOR_CMD" | "UE_PROJECT" | "UE_RENDER_TIMEOUT_MS" | "UE_REMOTE_EXEC_PORT">
>;

export interface UnrealConfig {
  /** configured editor executable (absolute, or a bare command name looked up in PATH); null: search defaults */
  editorCmd: string | null;
  /** configured render project (.uproject, absolute) */
  project: string | null;
  /** hard limit of one render; null: the request's timeout */
  renderTimeoutMs: number | null;
  /** the editor must print R3D_STARTED (ue_scene.py running) within this time */
  startupTimeoutMs: number;
  /** after RESULT the editor gets this long to exit cleanly before it is stopped (the result stands) */
  exitGraceMs: number;
  remoteExecGroup: string;
  remoteExecPort: number;
  remoteExecCommandPort: number;
  executor: UeExecutor;
  gi: UeGiMode;
  /** tools/unreal (the UE Python scripts) */
  scriptsDir: string;
  /** lock directory of the per-project render lock (default <project>/Saved/Render3D/locks) */
  lockDir: string | null;
}

export const DEFAULT_STARTUP_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_EXIT_GRACE_MS = 120_000;

function absPath(p: string | undefined): string | null {
  if (!p) return null;
  return resolveFromRoot(p);
}

/** A bare command name (no directory part) is resolved through PATH by detect.ts; anything else is a path. */
function editorPath(p: string | undefined): string | null {
  if (!p) return null;
  return /[\\/]/.test(p) ? resolveFromRoot(p) : p;
}

/**
 * Configuration from @cre/config's Env (UE_EDITOR_CMD, UE_PROJECT, UE_RENDER_TIMEOUT_MS, UE_REMOTE_EXEC_PORT), the
 * extra UE_* variables of `processEnv`, and explicit overrides (overrides win). Invalid values throw (zod).
 */
export function resolveUnrealConfig(
  overrides: Partial<UnrealConfig> = {},
  env: UnrealEnvInput = {},
  processEnv: NodeJS.ProcessEnv = process.env,
): UnrealConfig {
  const e = UnrealEnvSchema.parse({
    UE_EDITOR_CMD: env.UE_EDITOR_CMD ?? processEnv.UE_EDITOR_CMD,
    UE_PROJECT: env.UE_PROJECT ?? processEnv.UE_PROJECT,
    UE_RENDER_TIMEOUT_MS: env.UE_RENDER_TIMEOUT_MS ?? processEnv.UE_RENDER_TIMEOUT_MS,
    UE_REMOTE_EXEC_PORT: env.UE_REMOTE_EXEC_PORT ?? processEnv.UE_REMOTE_EXEC_PORT,
    UE_STARTUP_TIMEOUT_MS: processEnv.UE_STARTUP_TIMEOUT_MS,
    UE_REMOTE_EXEC_COMMAND_PORT: processEnv.UE_REMOTE_EXEC_COMMAND_PORT,
    UE_REMOTE_EXEC_GROUP: processEnv.UE_REMOTE_EXEC_GROUP,
    UE_MRQ_EXECUTOR: processEnv.UE_MRQ_EXECUTOR,
    UE_GI_MODE: processEnv.UE_GI_MODE,
  });
  return {
    editorCmd: editorPath(e.UE_EDITOR_CMD),
    project: absPath(e.UE_PROJECT),
    renderTimeoutMs: e.UE_RENDER_TIMEOUT_MS ?? null,
    startupTimeoutMs: e.UE_STARTUP_TIMEOUT_MS ?? DEFAULT_STARTUP_TIMEOUT_MS,
    exitGraceMs: DEFAULT_EXIT_GRACE_MS,
    remoteExecGroup: e.UE_REMOTE_EXEC_GROUP ?? "239.0.0.1",
    remoteExecPort: e.UE_REMOTE_EXEC_PORT ?? 6766,
    remoteExecCommandPort: e.UE_REMOTE_EXEC_COMMAND_PORT ?? 6776,
    executor: e.UE_MRQ_EXECUTOR ?? "pie",
    gi: e.UE_GI_MODE ?? "auto",
    scriptsDir: resolveFromRoot("tools/unreal"),
    lockDir: null,
    ...overrides,
  };
}
