import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withResourceLock } from "@cre/reel";
import { FatalError, RetryableError } from "@cre/shared";
import { z } from "zod";
import {
  EngineUnavailableError,
  type EngineCapabilities,
  type EngineProgress,
  type EngineRenderOutput,
  type EngineRenderRequest,
  type GpuInfo,
  type RenderEngine,
} from "../../contracts/engine.ts";
import { detectGpu } from "../gpu.ts";
import { engineEnv, runEngineProcess, type EngineProcResult } from "../proc.ts";
import { resolveUnrealConfig, type UnrealConfig } from "./config.ts";
import { capabilitiesFromDetection, detectUnreal, type UnrealDetection } from "./detect.ts";
import {
  buildUeSceneJob,
  findMaterialReport,
  MaterialReport,
  sha256File,
  stageBakedTextures,
  UeSceneJob,
} from "./job.ts";
import { readUeResultFile, toEngineOutput } from "./result.ts";

/*
 * Unreal Engine adapter: Recipe3D (UE_* template) + an imported model (.fbx / .glb) → UE scene job JSON →
 * UnrealEditor-Cmd <dedicated project> -ExecutePythonScript=<tools/unreal/ue_scene.py> → validated result.json.
 *
 * Why -ExecutePythonScript (and not -run=pythonscript): Movie Render Queue renders over editor ticks with a real
 * RHI. -ExecutePythonScript starts the full editor loop and runs the script once the editor is up; the script drives
 * the render from a tick callback and quits the editor when result.json is written. The PythonScript commandlet runs
 * a script without that loop and with rendering disabled — MRQ never progresses there (it is used for diagnostics).
 *
 * The job path travels in R3D_UE_JOB (environment), not on the command line: UE parses its raw command line itself,
 * and a quoted "-ExecutePythonScript=… <args>" token does not survive Windows argument quoting. The process runs
 * without a shell, with a minimal environment, under a per-project lock (one editor per project: levels and the
 * render queue are shared state), and is killed as a process tree on abort / timeout.
 */

/** Flags of every unattended editor run (UE 5.x): no dialogs, no "press any key", no splash, no audio, the full
 * log on stdout (Python's print arrives as LogPython lines). */
export const UE_EDITOR_FLAGS = [
  "-unattended",
  "-nopause",
  "-nosplash",
  "-NoSound",
  "-stdout",
  "-FullStdOutLogOutput",
];

export interface UnrealEngineOptions {
  /** overrides of the resolved configuration (default: resolveUnrealConfig() from the process environment) */
  config?: Partial<UnrealConfig>;
  /** run a different launcher in front of the editor arguments (tests: node + the fake editor) */
  launcher?: { command: string; prefixArgs: string[] };
  /** accept results marked mock (the test double only — a mock is never presented as a render) */
  allowMock?: boolean;
  /** extra environment of the editor process (e.g. UE-LocalDataCachePath); secrets never belong here */
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
  /** material report of the request's model when it is not in a sidecar file */
  resolveMaterialReport?: (req: EngineRenderRequest) => Promise<unknown>;
  /** extra yaw (degrees) that turns a product's front to +X, when its export convention differs */
  frontYawDeg?: (req: EngineRenderRequest) => number;
  /** longest wait for the per-project lock (default 6 h) */
  lockTimeoutMs?: number;
  gpu?: () => GpuInfo;
  /** host environment used for detection (default process.env) */
  hostEnv?: NodeJS.ProcessEnv;
}

/** "-ExecutePythonScript=<script>" — the absolute path, or (a Windows path with spaces / quotes, which UE's raw
 * command-line parser would split) the bare file name resolved through UE_PYTHONPATH. */
export function scriptArgument(scriptPath: string, platform: NodeJS.Platform = process.platform): string {
  const unsafe = /[\s"]/.test(scriptPath);
  if (unsafe && platform === "win32") return `-ExecutePythonScript=${path.win32.basename(scriptPath)}`;
  return `-ExecutePythonScript=${scriptPath}`;
}

/** Editor arguments of a scene render. */
export function ueSceneArgs(
  project: string,
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [project, scriptArgument(scriptPath, platform), ...UE_EDITOR_FLAGS];
}

/** Editor arguments of the diagnostics commandlet (no rendering needed: the PythonScript commandlet). */
export function ueDiagnoseArgs(
  project: string,
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const script =
    /[\s"]/.test(scriptPath) && platform === "win32" ? path.win32.basename(scriptPath) : scriptPath;
  return [project, "-run=pythonscript", `-script=${script}`, ...UE_EDITOR_FLAGS];
}

/** Windows variables an editor needs beyond engineEnv()'s minimal set (no secrets among them). */
const WINDOWS_ENV = [
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "windir",
  "COMPUTERNAME",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PATHEXT",
  "ComSpec",
  "OS",
  "UE-LocalDataCachePath",
  "UE-SharedDataCachePath",
];

export function ueEnv(
  scriptsDir: string,
  extra: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const win: Record<string, string> = {};
  for (const k of WINDOWS_ENV) if (base[k]) win[k] = base[k];
  return engineEnv({ ...win, UE_PYTHONPATH: scriptsDir, R3D_UE_TOOLS: scriptsDir, ...extra }, base);
}

/** Progress / marker lines of ue_scene.py, also behind UE's log prefix ("[…][  0]LogPython: PROGRESS …"). */
export function parseUeLine(
  line: string,
):
  | { kind: "progress"; progress: EngineProgress }
  | { kind: "started" }
  | { kind: "result" }
  | { kind: "phase"; phase: string }
  | null {
  const p = /(?:^|[\s:])PROGRESS job=\S+ frame=(\d+)\/(\d+)(?: ms=(\d+))?/.exec(line);
  if (p) {
    return {
      kind: "progress",
      progress: { frame: Number(p[1]), total: Number(p[2]), ...(p[3] ? { ms: Number(p[3]) } : {}) },
    };
  }
  if (/(?:^|[\s:])R3D_STARTED script=ue_scene\b/.test(line)) return { kind: "started" };
  if (/(?:^|[\s:])RESULT \S/.test(line)) return { kind: "result" };
  const ph = /(?:^|[\s:])PHASE ([a-z]+) job=/.exec(line);
  return ph ? { kind: "phase", phase: ph[1]! } : null;
}

const CRASH =
  /0xC0000005|EXCEPTION_ACCESS_VIOLATION|GPU crash|D3D device|DXGI_ERROR|device (was )?removed|out of video memory|Fatal error!|Assertion failed/i;

const UeDiagnoseReport = z
  .object({
    ok: z.boolean(),
    tool: z.string(),
    engineVersion: z.string(),
    missingRequired: z.array(z.string()),
    warnings: z.array(z.string()),
    mock: z.boolean().default(false),
  })
  .loose();
export type UeDiagnoseReport = z.infer<typeof UeDiagnoseReport>;

export class UnrealEngine implements RenderEngine {
  readonly id = "unreal" as const;
  readonly config: UnrealConfig;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly opts: UnrealEngineOptions = {}) {
    this.config = resolveUnrealConfig(opts.config ?? {});
    this.platform = opts.platform ?? process.platform;
  }

  /** File-system detection (no editor start): executable, version, project, plugins, marker. */
  detect(): UnrealDetection {
    return detectUnreal(this.config, this.opts.hostEnv ?? process.env, this.platform);
  }

  probe(): Promise<EngineCapabilities> {
    const gpu = (this.opts.gpu ?? detectGpu)();
    return Promise.resolve(capabilitiesFromDetection(this.detect(), gpu));
  }

  private command(args: string[]): { command: string; args: string[] } {
    const det = this.detect();
    if (!det.available || !det.editorCmd)
      throw new EngineUnavailableError("unreal", det.reason ?? "unavailable");
    return this.opts.launcher
      ? { command: this.opts.launcher.command, args: [...this.opts.launcher.prefixArgs, ...args] }
      : { command: det.editorCmd, args };
  }

  private lockDir(): string {
    return (
      this.config.lockDir ??
      path.join(path.dirname(this.config.project ?? os.tmpdir()), "Saved", "Render3D", "locks")
    );
  }

  private lockName(): string {
    const id = createHash("sha256")
      .update(path.resolve(this.config.project ?? ""))
      .digest("hex")
      .slice(0, 12);
    return `unreal-project-${id}`;
  }

  async render(req: EngineRenderRequest): Promise<EngineRenderOutput> {
    const det = this.detect();
    if (!det.available) throw new EngineUnavailableError("unreal", det.reason ?? "unavailable");
    const warnings = [...det.warnings];
    const outDir = path.join(path.resolve(req.workDir), "ue");
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.rm(path.join(outDir, "result.json"), { force: true });

    // the model: a local .fbx / .glb that matches the library record
    if (!req.productFile) {
      throw new FatalError(
        `${req.product.assetId}: no model file — the UE adapter imports .fbx / .glb (export procedural products from Blender first)`,
      );
    }
    const productFile = path.resolve(req.productFile);
    const st = await fsp.stat(productFile).catch(() => null);
    if (!st?.isFile()) throw new FatalError(`model file not found: ${productFile}`);
    const sha = await sha256File(productFile);
    const ext = path.extname(productFile).slice(1).toLowerCase();
    const record = req.product.outputFiles.find((f) => f.role === ext);
    if (record && record.sha256 !== sha)
      throw new FatalError(`${path.basename(productFile)} does not match the library record (sha256)`);

    // material report (sidecar or resolver) + baked maps copied into the job
    let report: MaterialReport | null = null;
    if (this.opts.resolveMaterialReport) {
      const raw = await this.opts.resolveMaterialReport(req);
      if (raw !== null && raw !== undefined) {
        const parsed = MaterialReport.safeParse(raw);
        if (parsed.success) report = parsed.data;
        else warnings.push(`ignored an invalid material report: ${parsed.error.message.slice(0, 200)}`);
      }
    }
    if (!report) {
      const side = await findMaterialReport(productFile);
      report = side.report;
      if (side.warning) warnings.push(side.warning);
    }
    const baked = await stageBakedTextures(productFile, outDir);
    warnings.push(...baked.warnings);

    const timeoutMs = this.config.renderTimeoutMs ?? req.timeoutMs;
    const built = buildUeSceneJob({ ...req, productFile }, outDir, {
      sha256: sha,
      materialReport: report,
      bakedTextures: baked.maps,
      executor: this.config.executor,
      gi: this.config.gi,
      maxRenderSec: Math.min(172_800, Math.max(10, Math.round(timeoutMs / 1000))),
      ...(this.opts.frontYawDeg ? { frontYawDeg: this.opts.frontYawDeg(req) } : {}),
    });
    warnings.push(...built.warnings);
    const job = UeSceneJob.parse(built.job);
    const jobPath = path.join(path.resolve(req.workDir), "ue-scene-job.json");
    await fsp.writeFile(jobPath, JSON.stringify(job, null, 1));

    const scriptPath = path.join(this.config.scriptsDir, "ue_scene.py");
    const project = det.project!.file;
    const { command, args } = this.command(ueSceneArgs(project, scriptPath, this.platform));
    const env = ueEnv(this.config.scriptsDir, { R3D_UE_JOB: jobPath, ...(this.opts.env ?? {}) });
    const logFile = path.join(path.resolve(req.workDir), "unreal.log");

    const proc = await withResourceLock(
      this.lockDir(),
      this.lockName(),
      1,
      () => this.runEditor(command, args, env, logFile, timeoutMs, req),
      {
        ...(req.signal ? { signal: req.signal } : {}),
        pollMs: 1000,
        timeoutMs: this.opts.lockTimeoutMs ?? 6 * 3_600_000,
      },
    );
    return this.finish(proc, outDir, job, warnings, req, logFile);
  }

  /** Runs the editor: startup watchdog until ue_scene.py reports in, exit grace after RESULT. */
  private async runEditor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    logFile: string,
    timeoutMs: number,
    req: EngineRenderRequest,
  ): Promise<{ res: EngineProcResult | null; error: unknown; stop: "startup" | "exit-grace" | null }> {
    const internal = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, internal.signal]) : internal.signal;
    let stop: "startup" | "exit-grace" | null = null;
    const startup = setTimeout(() => {
      stop = "startup";
      internal.abort();
    }, this.config.startupTimeoutMs);
    let grace: NodeJS.Timeout | null = null;
    const log = fs.createWriteStream(logFile);
    try {
      const res = await runEngineProcess(command, args, {
        env,
        check: false,
        timeoutMs,
        signal,
        maxOutputBytes: 256 * 1024,
        ...(req.onSpawn ? { onSpawn: req.onSpawn } : {}),
        onLine: (line) => {
          log.write(`${line}\n`);
          const m = parseUeLine(line);
          if (!m) return;
          if (m.kind === "started") clearTimeout(startup);
          else if (m.kind === "progress") req.onProgress?.(m.progress);
          else if (m.kind === "result" && !grace)
            grace = setTimeout(() => {
              stop = "exit-grace";
              internal.abort();
            }, this.config.exitGraceMs);
        },
      });
      return { res, error: null, stop };
    } catch (error) {
      return { res: null, error, stop };
    } finally {
      clearTimeout(startup);
      if (grace) clearTimeout(grace);
      log.end();
    }
  }

  private finish(
    run: { res: EngineProcResult | null; error: unknown; stop: "startup" | "exit-grace" | null },
    outDir: string,
    job: UeSceneJob,
    warnings: string[],
    req: EngineRenderRequest,
    logFile: string,
  ): EngineRenderOutput {
    const tail = () => {
      const out = run.res ? run.res.stderr.trim() || run.res.stdout.trim() : "";
      return out.split(/\r?\n/).slice(-15).join("\n").slice(-2000) || `(see ${logFile})`;
    };
    if (req.signal?.aborted)
      throw run.error instanceof Error ? run.error : new RetryableError("unreal render aborted");
    const file = readUeResultFile(outDir);
    if (file.kind === "ok") {
      if (file.result.mock && !this.opts.allowMock)
        throw new FatalError(
          "result.json is marked mock (the fake editor): refusing to present it as a render",
        );
      const extra = [...warnings];
      if (run.stop === "exit-grace")
        extra.push("the editor did not exit after writing the result: it was stopped");
      else if (run.res && run.res.code !== 0)
        extra.push(`the editor exited with ${run.res.code} after the render`);
      const gpu = (this.opts.gpu ?? detectGpu)();
      return toEngineOutput(file.result, outDir, job, {
        warnings: extra,
        gpuName: gpu.name,
        parts: req.product.parts.map((p) => ({
          name: p.name,
          role: p.role,
          verified: p.verified,
          internal: p.internal,
        })),
      });
    }
    if (run.error) {
      if (run.stop === "startup")
        throw new EngineUnavailableError(
          "unreal",
          `the editor did not run ue_scene.py within ${Math.round(this.config.startupTimeoutMs / 1000)} s — is the Python Editor Script Plugin enabled in the render project? (log: ${logFile})`,
        );
      if (run.error instanceof FatalError && /^cannot start /.test(run.error.message))
        throw new EngineUnavailableError("unreal", run.error.message);
      throw run.error instanceof Error ? run.error : new RetryableError("unreal render failed");
    }
    const res = run.res!;
    if (file.kind === "failure") {
      const f = file.failure;
      const msg = `${f.error}: ${f.message}`.slice(0, 1500);
      if (f.error === "invalid_job") throw new FatalError(`UE rejected the scene job: ${msg}`);
      if (f.error === "not_dedicated_project" || f.error === "api_missing")
        throw new EngineUnavailableError("unreal", msg);
      if (CRASH.test(f.message)) throw new RetryableError(`UE render failed (GPU / device): ${msg}`);
      throw new FatalError(`UE render failed: ${msg}`);
    }
    if (res.code === 3) throw new FatalError(`UE rejected the scene job: ${tail()}`);
    if (CRASH.test(res.stdout.slice(-20_000)) || CRASH.test(res.stderr) || res.code < 0 || res.code > 255)
      throw new RetryableError(`the editor crashed (exit ${res.code}): ${tail()}`);
    throw new FatalError(`the editor exited with ${res.code} without result.json: ${tail()}`);
  }

  /**
   * Runs tools/unreal/ue_diagnose.py in the render project through the PythonScript commandlet and returns its
   * report (engine version, API variants found, plugins, rendering capabilities, warnings).
   */
  async diagnose(opts: {
    outDir: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<UeDiagnoseReport> {
    const det = this.detect();
    if (!det.available) throw new EngineUnavailableError("unreal", det.reason ?? "unavailable");
    await fsp.mkdir(opts.outDir, { recursive: true });
    const out = path.join(path.resolve(opts.outDir), "diagnose.json");
    await fsp.rm(out, { force: true });
    const { command, args } = this.command(
      ueDiagnoseArgs(det.project!.file, path.join(this.config.scriptsDir, "ue_diagnose.py"), this.platform),
    );
    const res = await runEngineProcess(command, args, {
      env: ueEnv(this.config.scriptsDir, { R3D_UE_DIAG_OUT: out, ...(this.opts.env ?? {}) }),
      check: false,
      timeoutMs: opts.timeoutMs ?? 20 * 60_000,
      maxOutputBytes: 128 * 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    let text: string;
    try {
      text = await fsp.readFile(out, "utf8");
    } catch {
      throw new FatalError(`diagnostics wrote no report (exit ${res.code}): ${res.stdout.slice(-1500)}`);
    }
    return UeDiagnoseReport.parse(JSON.parse(text));
  }
}
