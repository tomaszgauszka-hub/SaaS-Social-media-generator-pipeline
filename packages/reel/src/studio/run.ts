import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { FatalError } from "@cre/shared";
import { z } from "zod";
import type { CallContext } from "../capabilities/types.ts";
import { ProductAnimation, ShotPreset, ShotTechnique } from "../contracts/ids.ts";
import { StudioJob, StudioResult, StudioShotResult } from "../contracts/media.ts";
import { withResourceLock } from "../util/lock.ts";
import { runProcess } from "../util/proc.ts";
import { resolveReelTools, type ReelTools } from "../util/tools.ts";
import { studioToolsDir, type StudioOverrides } from "./cache.ts";

/*
 * TypeScript → Blender bridge. The job is validated, written to <output.dir>/job.json and handed to the studio by
 * path; Blender runs as a plain process (no shell) under a host-wide "blender" lock, and its result.json is
 * validated before anything downstream trusts a single file name in it.
 */

const FILE_NAMES = {
  plate: /^plate\.png$/,
  relight: /^(off|on)\.png$/,
  sequence: /^f_\d{4}\.png$/,
} as const;

/** StudioShotResult + the extras the studio writes (fallbacks, camera, timings). */
export const StudioShotOutput = StudioShotResult.extend({
  preset: ShotPreset.optional(),
  renderedPreset: ShotPreset.optional(),
  /** the preset needed a multi-part model; this nearest feasible move was rendered instead */
  fallbackPreset: ShotPreset.optional(),
  fallbackReason: z.string().max(300).optional(),
  animationFallback: ProductAnimation.optional(),
  /** the technique was not renderable (a relight of a product without a light): this one was rendered instead */
  fallbackTechnique: ShotTechnique.optional(),
  fallbackTechniqueReason: z.string().max(300).optional(),
  /** a close-up of a thin part was framed on the product's widest band instead (why) */
  macroFocus: z.string().max(300).optional(),
  overscan: z.number().min(1).max(1.6).optional(),
  bitDepth: z.union([z.literal(8), z.literal(16)]).optional(),
  viewTransform: z.string().optional(),
  frameMs: z.array(z.number().int().min(0)).optional(),
  camera: z.record(z.string(), z.number()).optional(),
})
  .loose()
  .superRefine((r, ctx) => {
    const re = FILE_NAMES[r.technique];
    if (r.files.some((f) => !re.test(f)))
      ctx.addIssue({ code: "custom", message: `unexpected file name for ${r.technique}` });
    if (r.technique === "plate" && r.files.length !== 1)
      ctx.addIssue({ code: "custom", message: "a plate has one file" });
    if (r.technique === "relight" && r.files.join() !== "off.png,on.png")
      ctx.addIssue({ code: "custom", message: "a relight has off.png, on.png" });
    if (r.productBoxes.length !== r.files.length)
      ctx.addIssue({ code: "custom", message: "one product box per file" });
  });
export type StudioShotOutput = z.infer<typeof StudioShotOutput>;

export const StudioRunResult = StudioResult.extend({
  shots: z.array(StudioShotOutput),
  blenderVersion: z.string().optional(),
  product: z
    .object({
      heightM: z.number(),
      radiusM: z.number(),
      scaleApplied: z.number(),
      parts: z.number().int(),
      emissive: z.string(),
      bulb: z.array(z.number()).nullable(),
    })
    .loose()
    .optional(),
  set: z.record(z.string(), z.unknown()).optional(),
}).loose();
export type StudioRunResult = z.infer<typeof StudioRunResult>;

/** A shot result with the directory its files live in. */
export type LocatedShotResult = StudioShotOutput & { dir: string };

/** Command line that runs the studio: a Python with `bpy`, or a Blender executable in background mode. */
export function studioCommand(
  tools: Pick<ReelTools, "blenderPython" | "blenderBin">,
  jobPath: string,
  runPy = path.join(studioToolsDir(), "run.py"),
): { command: string; args: string[] } {
  if (tools.blenderPython) return { command: tools.blenderPython, args: ["-B", runPy, jobPath] };
  if (tools.blenderBin)
    return {
      command: tools.blenderBin,
      args: [
        "-b",
        "--factory-startup",
        "-noaudio",
        "--python-exit-code",
        "1",
        "--python",
        runPy,
        "--",
        jobPath,
      ],
    };
  throw new FatalError(
    "Blender is not installed: set BLENDER_PYTHON (bpy module) or BLENDER_BIN — see tools/README.md",
  );
}

const rendererVersions = new Map<string, Promise<string>>();

/**
 * Identity of the renderer (bpy / Blender version + build hash), resolved once per process. It is part of every
 * render cache key: renders of an older Blender are never reused, nor cut next to renders of a newer one.
 */
export function studioRendererVersion(
  tools: Pick<ReelTools, "blenderPython" | "blenderBin">,
): Promise<string> {
  const probe = tools.blenderPython
    ? {
        command: tools.blenderPython,
        args: ["-c", "import bpy; print('bpy', bpy.app.version_string, bpy.app.build_hash.decode())"],
      }
    : tools.blenderBin
      ? { command: tools.blenderBin, args: ["-b", "--factory-startup", "--version"] }
      : undefined;
  if (!probe) return Promise.resolve("none"); // nothing renders: every lookup misses, runStudio explains why
  const id = [probe.command, ...probe.args].join("\0");
  let v = rendererVersions.get(id);
  if (!v) {
    v = runProcess(probe.command, probe.args, {
      env: studioEnv({ blenderThreads: 0 }),
      timeoutMs: 120_000,
      maxOutputBytes: 16 * 1024,
    }).then((r) => {
      const lines = r.stdout.split("\n").map((l) => l.trim());
      const version = lines.filter((l) => /^(bpy |Blender \d)|^build hash:/.test(l)).join(" ");
      if (!version) throw new FatalError(`cannot tell the Blender version of ${probe.command}`);
      return version.slice(0, 200);
    });
    rendererVersions.set(id, v);
    v.catch(() => rendererVersions.delete(id)); // a failed probe is retried by the next call
  }
  return v;
}

/** Only what Blender needs — API keys and other secrets of the worker never reach the render process. */
export function studioEnv(
  tools: Pick<ReelTools, "blenderThreads">,
  overrides: StudioOverrides = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ", "LD_LIBRARY_PATH"])
    if (base[k]) env[k] = base[k];
  if (tools.blenderThreads > 0) env.BLENDER_THREADS = String(tools.blenderThreads);
  if (overrides.samples !== undefined) env.STUDIO_SAMPLES = String(Math.round(overrides.samples));
  if (overrides.scale !== undefined) env.STUDIO_SCALE = String(overrides.scale);
  return env;
}

export interface StudioProgress {
  shotId: string;
  frame: number;
  total: number;
  ms?: number;
}

/** Parses "PROGRESS shot=sh01 frame=3/40 ms=8123" lines of the studio's stdout. */
export function parseProgressLine(line: string): StudioProgress | null {
  const m = /^PROGRESS shot=(sh\d{2}) frame=(\d+)\/(\d+)(?: ms=(\d+))?/.exec(line.trim());
  if (!m) return null;
  return { shotId: m[1]!, frame: Number(m[2]), total: Number(m[3]), ...(m[4] ? { ms: Number(m[4]) } : {}) };
}

/** Frames a job renders (plate 1, relight 2, sequence ⌈duration·fps⌉ + 1 — shotlib.sequence_frame_count). */
export function studioFrameCount(job: Pick<StudioJob, "shots">): number {
  return job.shots.reduce((n, s) => {
    if (s.technique === "plate") return n + 1;
    if (s.technique === "relight") return n + 2;
    return n + Math.max(2, Math.ceil((s.durationMs * s.renderFps) / 1000 - 1e-9) + 1);
  }, 0);
}

/**
 * Longest a studio run waits for a free Blender slot before it fails retryably — as long as a reel job may run
 * (reel.produce timeout), so it only bounds runs without a job deadline (CLI, tests) and wedged hosts.
 */
export const STUDIO_LOCK_WAIT_MS = 60 * 60_000;

export interface RunStudioOptions {
  overrides?: StudioOverrides;
  tools?: ReelTools;
  /** default: 2 min + a generous per-frame budget for the profile */
  timeoutMs?: number;
  /** default STUDIO_LOCK_WAIT_MS */
  lockTimeoutMs?: number;
  onProgress?: (p: StudioProgress) => void;
}

export interface StudioRun {
  result: StudioRunResult;
  /** <output.dir> — shot files are in <dir>/<shotId>/ */
  dir: string;
  wallMs: number;
}

/**
 * Renders a StudioJob: writes job.json, runs Blender (no shell) under the host-wide "blender" lock
 * (BLENDER_MAX_CONCURRENT slots), validates result.json and records local compute per shot.
 */
export async function runStudio(
  job: StudioJob,
  ctx: CallContext,
  opts: RunStudioOptions = {},
): Promise<StudioRun> {
  const parsed = StudioJob.parse(job);
  const tools = opts.tools ?? resolveReelTools();
  const dir = path.resolve(parsed.output.dir);
  await fsp.mkdir(dir, { recursive: true });
  const jobPath = path.join(dir, "job.json");
  await fsp.rm(path.join(dir, "result.json"), { force: true });
  await fsp.writeFile(
    jobPath,
    JSON.stringify(
      {
        ...parsed,
        product: { ...parsed.product, modelPath: path.resolve(parsed.product.modelPath) },
        output: { ...parsed.output, dir },
      },
      null,
      1,
    ),
  );
  const { command, args } = studioCommand(tools, jobPath);
  const perFrameMs = parsed.profile === "FAST" ? 120_000 : 900_000;
  const timeoutMs = opts.timeoutMs ?? 120_000 + studioFrameCount(parsed) * perFrameMs;
  const started = Date.now();
  const proc = await withResourceLock(
    path.join(ctx.cacheDir, ".locks"),
    "blender",
    tools.blenderMaxConcurrent,
    () =>
      runProcess(command, args, {
        env: studioEnv(tools, opts.overrides),
        check: false,
        timeoutMs,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        maxOutputBytes: 64 * 1024,
        onLine: (line) => {
          const p = parseProgressLine(line);
          if (p) {
            opts.onProgress?.(p);
            ctx.logger?.debug({ ...p, jobKey: parsed.jobKey }, "studio progress");
          } else if (line.startsWith("PHASE "))
            ctx.logger?.debug({ jobKey: parsed.jobKey, line }, "studio phase");
        },
      }),
    {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      pollMs: 500,
      timeoutMs: opts.lockTimeoutMs ?? STUDIO_LOCK_WAIT_MS,
    },
  );
  if (proc.code !== 0) {
    const tail = (proc.stderr.trim() || proc.stdout.trim()).split("\n").slice(-15).join("\n");
    throw new FatalError(
      proc.code === 3
        ? `studio rejected the job: ${tail}`
        : `Blender studio failed (exit ${proc.code}): ${tail}`,
    );
  }
  const resultPath = path.join(dir, "result.json");
  const result = StudioRunResult.parse(JSON.parse(await fsp.readFile(resultPath, "utf8")));
  if (result.jobKey !== parsed.jobKey)
    throw new FatalError(`studio result is for job ${result.jobKey}, expected ${parsed.jobKey}`);
  const want = parsed.shots.map((s) => s.id).join();
  if (result.shots.map((s) => s.id).join() !== want)
    throw new FatalError(`studio result shots ≠ job shots (${want})`);
  for (const s of result.shots) {
    for (const f of s.files)
      if (!fs.existsSync(path.join(dir, s.id, f)))
        throw new FatalError(`studio output missing: ${s.id}/${f}`);
    ctx.tracker.compute({
      stage: "blender",
      label:
        `studio ${s.id} ${s.renderedPreset ?? s.preset ?? ""} ${s.technique} ${s.width}x${s.height}`.slice(
          0,
          120,
        ),
      wallMs: s.renderMs,
      frames: s.files.length,
      scope: ctx.scope,
    });
  }
  ctx.tracker.compute({
    stage: "blender",
    label: `studio scene ${parsed.environment} (${parsed.shots.length} shots)`,
    wallMs: result.sceneMs,
    scope: ctx.scope,
  });
  return { result, dir, wallMs: Date.now() - started };
}
