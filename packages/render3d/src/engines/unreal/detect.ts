import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineCapabilities, GpuInfo } from "../../contracts/engine.ts";
import type { UnrealConfig } from "./config.ts";

/*
 * Unreal detection without starting the editor (an editor start takes minutes): the executable, the engine version
 * from Engine/Build/Build.version next to it, and the render project (.uproject JSON, its plugin list, the
 * Render3D marker). Anything missing makes the engine unavailable with a precise reason; the worker then defers
 * the job or falls back to Blender.
 */

export interface UeVersion {
  major: number;
  minor: number;
  patch: number;
  changelist: number | null;
  branch: string | null;
}

/** Plugins the adapter cannot work without (not enabled by default in a blank project). */
export const REQUIRED_PLUGINS = ["PythonScriptPlugin", "MovieRenderPipeline"] as const;
/** Plugins it uses that may already be enabled by the engine (warned about when not listed). */
export const RECOMMENDED_PLUGINS = ["EditorScriptingUtilities", "SequencerScripting"] as const;
export const MARKER_FILE = "DefaultRender3D.ini";
/** The release the adapter and its UE scripts were written for (other 5.x versions are allowed with a warning). */
export const TARGET_UE = { major: 5, minor: 8 } as const;

export function parseBuildVersion(text: string): UeVersion | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === "number" && Number.isInteger(o[k]) ? o[k] : null);
  const major = num("MajorVersion");
  const minor = num("MinorVersion");
  const patch = num("PatchVersion");
  if (major === null || minor === null || patch === null) return null;
  return {
    major,
    minor,
    patch,
    changelist: num("Changelist"),
    branch: typeof o.BranchName === "string" ? o.BranchName.slice(0, 120) : null,
  };
}

export const versionString = (v: UeVersion) => `${v.major}.${v.minor}.${v.patch}`;

/** The engine's `Engine` directory of an editor binary (…/Engine/Binaries/<Platform>/UnrealEditor-Cmd[.exe]). */
export function engineDirOf(editorCmd: string): string | null {
  let dir = path.dirname(path.resolve(editorCmd));
  for (let i = 0; i < 6; i++) {
    if (
      path.basename(dir).toLowerCase() === "engine" &&
      fs.existsSync(path.join(dir, "Build", "Build.version"))
    )
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function readBuildVersion(editorCmd: string): { version: UeVersion; file: string } | null {
  const engine = engineDirOf(editorCmd);
  if (!engine) return null;
  const file = path.join(engine, "Build", "Build.version");
  try {
    const version = parseBuildVersion(fs.readFileSync(file, "utf8"));
    return version ? { version, file } : null;
  } catch {
    return null;
  }
}

/**
 * Default editor locations of Epic Games Launcher installs on Windows: <Program Files>/Epic Games/UE_5.<n>/Engine/
 * Binaries/Win64/UnrealEditor-Cmd.exe, newest 5.x first. Other platforms / source builds: set UE_EDITOR_CMD.
 */
export function windowsEditorCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env.ProgramFiles, env.ProgramW6432, "C:\\Program Files"]
    .filter((r): r is string => Boolean(r))
    .map((r) => path.join(r, "Epic Games"));
  const out: { file: string; minor: number }[] = [];
  for (const root of [...new Set(roots)]) {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      const m = /^UE_5\.(\d+)$/.exec(n);
      if (!m) continue;
      out.push({
        file: path.join(root, n, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe"),
        minor: Number(m[1]),
      });
    }
  }
  return out.sort((a, b) => b.minor - a.minor).map((c) => c.file);
}

/** Resolve a bare command name through PATH (no shell). */
export function whichSync(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string | null {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? env.Path ?? "").split(sep).filter(Boolean)) {
    for (const ext of ["", ...exts]) {
      const file = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export function isDedicatedProject(projectDir: string): boolean {
  try {
    const lines = fs
      .readFileSync(path.join(projectDir, "Config", MARKER_FILE), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    return lines.includes("[Render3D]") && lines.includes("DedicatedRenderProject=True");
  } catch {
    return false;
  }
}

export interface ProjectInfo {
  ok: boolean;
  reason: string | null;
  warnings: string[];
  file: string;
  dir: string;
  name: string;
  dedicated: boolean;
  engineAssociation: string | null;
  plugins: Record<string, boolean>;
}

export function inspectProject(uproject: string, engine: UeVersion | null = null): ProjectInfo {
  const file = path.resolve(uproject);
  const dir = path.dirname(file);
  const base: ProjectInfo = {
    ok: false,
    reason: null,
    warnings: [],
    file,
    dir,
    name: path.basename(file, path.extname(file)),
    dedicated: false,
    engineAssociation: null,
    plugins: {},
  };
  if (path.extname(file).toLowerCase() !== ".uproject")
    return { ...base, reason: `UE_PROJECT ${file} is not a .uproject file` };
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ...base,
      reason:
        code === "ENOENT"
          ? `UE_PROJECT ${file} does not exist`
          : `cannot read ${file}: ${(e as Error).message.slice(0, 200)}`,
    };
  }
  if (!data || typeof data !== "object" || !("FileVersion" in data))
    return { ...base, reason: `${file} is not an Unreal project file` };
  const d = data as { EngineAssociation?: unknown; Plugins?: unknown };
  const plugins: Record<string, boolean> = {};
  if (Array.isArray(d.Plugins))
    for (const p of d.Plugins as unknown[])
      if (p && typeof p === "object" && typeof (p as { Name?: unknown }).Name === "string")
        plugins[(p as { Name: string }).Name] = (p as { Enabled?: unknown }).Enabled === true;
  const association = typeof d.EngineAssociation === "string" ? d.EngineAssociation : null;
  const info: ProjectInfo = {
    ...base,
    engineAssociation: association,
    plugins,
    dedicated: isDedicatedProject(dir),
  };
  if (!info.dedicated)
    return {
      ...info,
      reason:
        `${file} is not the dedicated render project (no Config/${MARKER_FILE} marker) — create a blank project ` +
        "and run tools/unreal/ue_project.py init on it; existing game projects are never used",
    };
  const missing = REQUIRED_PLUGINS.filter((p) => !plugins[p]);
  if (missing.length)
    return {
      ...info,
      reason: `plugin(s) ${missing.join(", ")} not enabled in ${path.basename(file)} (Edit > Plugins, or ue_project.py init)`,
    };
  for (const p of RECOMMENDED_PLUGINS)
    if (!plugins[p])
      info.warnings.push(`plugin ${p} is not listed in the project (fine if the engine enables it)`);
  if (
    engine &&
    association &&
    /^\d+\.\d+$/.test(association) &&
    association !== `${engine.major}.${engine.minor}`
  )
    return {
      ...info,
      reason: `the project is associated with UE ${association} but the editor is ${versionString(engine)} (an unattended editor cannot convert it)`,
    };
  return { ...info, ok: true };
}

export interface UnrealDetection {
  available: boolean;
  reason: string | null;
  warnings: string[];
  editorCmd: string | null;
  editorSource: "config" | "path" | "default-install" | null;
  version: UeVersion | null;
  versionFile: string | null;
  project: ProjectInfo | null;
}

export function detectUnreal(
  cfg: Pick<UnrealConfig, "editorCmd" | "project" | "scriptsDir">,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): UnrealDetection {
  const out: UnrealDetection = {
    available: false,
    reason: null,
    warnings: [],
    editorCmd: null,
    editorSource: null,
    version: null,
    versionFile: null,
    project: null,
  };
  const fail = (reason: string): UnrealDetection => ({ ...out, reason });
  if (!fs.existsSync(path.join(cfg.scriptsDir, "ue_scene.py")))
    return fail(`the UE scripts are missing (${path.join(cfg.scriptsDir, "ue_scene.py")})`);
  // editor
  if (cfg.editorCmd) {
    const resolved = path.isAbsolute(cfg.editorCmd) ? cfg.editorCmd : whichSync(cfg.editorCmd, env, platform);
    if (!resolved || !fs.existsSync(resolved)) return fail(`UE_EDITOR_CMD ${cfg.editorCmd} not found`);
    out.editorCmd = resolved;
    out.editorSource = path.isAbsolute(cfg.editorCmd) ? "config" : "path";
  } else {
    const found =
      platform === "win32" ? windowsEditorCandidates(env).find((f) => fs.existsSync(f)) : undefined;
    if (!found)
      return fail(
        platform === "win32"
          ? "Unreal Engine not found: set UE_EDITOR_CMD (…/Engine/Binaries/Win64/UnrealEditor-Cmd.exe)"
          : "Unreal Engine not configured: set UE_EDITOR_CMD to UnrealEditor-Cmd of a UE 5.x install",
      );
    out.editorCmd = found;
    out.editorSource = "default-install";
  }
  try {
    if (!fs.statSync(out.editorCmd).isFile()) return fail(`${out.editorCmd} is not a file`);
  } catch {
    return fail(`${out.editorCmd} is not accessible`);
  }
  if (!/unrealeditor-cmd(\.exe)?$/i.test(path.basename(out.editorCmd)))
    out.warnings.push(
      `${path.basename(out.editorCmd)} is not UnrealEditor-Cmd: console output / exit codes may differ`,
    );
  // version
  const bv = readBuildVersion(out.editorCmd);
  if (!bv) return fail(`cannot read Engine/Build/Build.version next to ${out.editorCmd}`);
  out.version = bv.version;
  out.versionFile = bv.file;
  if (bv.version.major !== 5) return fail(`Unreal Engine ${versionString(bv.version)}: UE 5.x is required`);
  if (bv.version.minor !== TARGET_UE.minor)
    out.warnings.push(
      `Unreal Engine ${versionString(bv.version)}: the adapter targets ${TARGET_UE.major}.${TARGET_UE.minor} — run the diagnostics (API names are resolved at runtime)`,
    );
  // project
  if (!cfg.project) return fail("UE_PROJECT is not set (the dedicated render .uproject)");
  const project = inspectProject(cfg.project, bv.version);
  out.project = project;
  out.warnings.push(...project.warnings);
  if (!project.ok) return fail(project.reason ?? "render project unusable");
  return { ...out, available: true };
}

export function capabilitiesFromDetection(
  d: UnrealDetection,
  gpu: GpuInfo,
  host: string = os.hostname(),
): EngineCapabilities {
  return {
    engine: "unreal",
    available: d.available,
    version: d.version ? `Unreal Engine ${versionString(d.version)}` : null,
    reason: d.available ? null : d.reason,
    gpu,
    renderers: d.available ? ["MRQ"] : [],
    host,
  };
}
