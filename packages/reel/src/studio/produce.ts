import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CallContext } from "../capabilities/types.ts";
import type { BlenderProfile } from "../contracts/ids.ts";
import type { ShotClip } from "../contracts/media.ts";
import type { PlanShot, ReelPlan } from "../contracts/plan.ts";
import type { ProductSource } from "../contracts/product.ts";
import { cacheKey, FileCache, fileSha256 } from "../util/cache.ts";
import { resolveReelTools, type ReelTools } from "../util/tools.ts";
import { STUDIO_SHOT_NAMESPACE, studioCacheKey, studioCodeVersion, type StudioOverrides } from "./cache.ts";
import {
  buildShotClipArgs,
  encodeShotClip,
  SHOT_CLIP_CRF,
  SHOT_CLIP_VERSION,
  type ShotClipArgsInput,
} from "./encode.ts";
import { blenderShotGroups, buildStudioJob } from "./job.ts";
import {
  runStudio,
  StudioShotOutput,
  studioRendererVersion,
  type LocatedShotResult,
  type StudioProgress,
  type StudioRun,
} from "./run.ts";

/*
 * Plan → shot clips, with two cache levels:
 *   studio-shot/<key>   Blender output of one shot (key: model sha, studio code, Blender version, profile, set,
 *                       camera, spec)
 *   shot-clip/<key>     the encoded 1080×1920 clip + its product track (key: studio key + move / timing / fps)
 * Locale and A/B variants of a product therefore never re-render a shot, and re-timing a plate only re-encodes.
 * Shots a failed / killed / timed-out studio run finished are cached too, so a retry renders only the rest.
 */

export const SHOT_CLIP_NAMESPACE = "shot-clip";

export interface ProduceShotClipsOptions {
  /** ProductProfile.traits.emitsLight (default: inferred from the ProductSource) */
  emitsLight?: boolean;
  emissiveHints?: readonly string[];
  /** tests / previews only (fewer samples, smaller renders) — part of the cache key */
  overrides?: StudioOverrides;
  tools?: ReelTools;
  x264Preset?: ShotClipArgsInput["x264Preset"];
  onProgress?: (p: StudioProgress) => void;
}

export interface ShotRenderInfo {
  shotId: string;
  studioKey: string;
  /** no Blender work was needed for this shot */
  renderHit: boolean;
  clipHit: boolean;
  technique: PlanShot["technique"];
  renderedPreset: PlanShot["preset"];
  fallbackPreset?: PlanShot["preset"];
  /** rendered as this technique instead of the planned one (a relight of a product without a light) */
  fallbackTechnique?: PlanShot["technique"];
  animationFallback?: string;
  frames: number;
  renderSize: { width: number; height: number };
  renderMs: number;
  encodeMs: number;
}

export interface ProducedShotClips {
  /** one clip per Blender shot, in plan order */
  clips: ShotClip[];
  shots: ShotRenderInfo[];
  /** plan shots this module does not produce (other sources) */
  skipped: { shotId: string; reason: string }[];
  studioRuns: number;
  studioWallMs: number;
}

/** Cached studio output of a shot, re-labelled with the asking shot's id. */
async function cachedShot(
  cache: FileCache,
  key: string,
  shotId: string,
): Promise<LocatedShotResult | undefined> {
  const raw = await cache.readJson<unknown>(STUDIO_SHOT_NAMESPACE, key, "result.json");
  const parsed = raw === undefined ? undefined : StudioShotOutput.safeParse(raw);
  if (!parsed?.success) return undefined;
  const dir = cache.dir(STUDIO_SHOT_NAMESPACE, key);
  if (!parsed.data.files.every((f) => cache.has(STUDIO_SHOT_NAMESPACE, key, f))) return undefined;
  return { ...parsed.data, id: shotId, dir };
}

/**
 * A shot a failed studio run had finished: Blender writes <shotId>/result.json (atomically) after its last file.
 * Results older than the run are leftovers of an earlier one (other code / overrides) and never count (2 s of
 * slack for coarse file-system clocks).
 */
async function finishedShot(
  dir: string,
  shotId: string,
  since: number,
): Promise<StudioShotOutput | undefined> {
  const file = path.join(dir, shotId, "result.json");
  try {
    if ((await fsp.stat(file)).mtimeMs < since - 2000) return undefined;
    const parsed = StudioShotOutput.safeParse(JSON.parse(await fsp.readFile(file, "utf8")));
    if (!parsed.success || parsed.data.id !== shotId) return undefined;
    return parsed.data.files.every((f) => fs.existsSync(path.join(dir, shotId, f))) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Moves a freshly rendered shot directory into the cache atomically (a concurrent install wins harmlessly). */
async function installShot(
  cache: FileCache,
  key: string,
  srcDir: string,
  result: StudioShotOutput,
): Promise<string> {
  const dest = cache.dir(STUDIO_SHOT_NAMESPACE, key);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.rename(srcDir, tmp);
  } catch {
    await fsp.cp(srcDir, tmp, { recursive: true }); // another filesystem
  }
  await fsp.writeFile(path.join(tmp, "result.json"), JSON.stringify(result, null, 1));
  try {
    // a complete entry has its result.json (written before the atomic rename): keep it, drop ours
    if (fs.existsSync(path.join(dest, "result.json"))) throw new Error("installed concurrently");
    await fsp.rm(dest, { recursive: true, force: true }); // incomplete leftovers
    await fsp.rename(tmp, dest);
  } catch {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  return dest;
}

export function shotClipKey(
  studioKey: string,
  shot: PlanShot,
  plan: Pick<ReelPlan, "fps" | "resolution">,
  x264Preset: string,
): string {
  return cacheKey(SHOT_CLIP_NAMESPACE, SHOT_CLIP_VERSION, {
    studioKey,
    preset: shot.preset,
    technique: shot.technique,
    params: shot.params,
    durationMs: shot.durationMs,
    fps: plan.fps,
    resolution: plan.resolution,
    crf: SHOT_CLIP_CRF,
    x264Preset,
  });
}

/**
 * Renders (or reuses) every Blender shot of a plan and encodes its clip. Shots are grouped by environment (one
 * studio run builds one set); only shots missing from the render cache go to Blender.
 */
export async function produceShotClips(
  plan: ReelPlan,
  product: ProductSource,
  profile: BlenderProfile,
  ctx: CallContext,
  opts: ProduceShotClipsOptions = {},
): Promise<ProducedShotClips> {
  const cache = new FileCache(ctx.cacheDir);
  const skipped = plan.shots
    .filter((s) => s.source !== "blender")
    .map((s) => ({ shotId: s.id, reason: `source "${s.source}" is not rendered by the studio` }));
  const groups = blenderShotGroups(plan);
  const out: ProducedShotClips = { clips: [], shots: [], skipped, studioRuns: 0, studioWallMs: 0 };
  if (!groups.length) return out;
  if (!product.model3d) throw new Error(`product ${product.id} has no 3D model for its Blender shots`);
  const modelSha =
    product.model3d.sha256 ?? plan.product.model3dSha ?? (await fileSha256(product.model3d.path));
  const tools = opts.tools ?? resolveReelTools();
  const codeVersion = studioCodeVersion();
  const renderer = await studioRendererVersion(tools);
  const located = new Map<string, { result: LocatedShotResult; key: string; hit: boolean }>();
  const jobOpts = {
    modelSha,
    ...(opts.emitsLight !== undefined ? { emitsLight: opts.emitsLight } : {}),
    ...(opts.emissiveHints ? { emissiveHints: opts.emissiveHints } : {}),
  };

  for (const shots of groups) {
    const probe = buildStudioJob(plan, product, profile, ctx.workDir, { ...jobOpts, shots });
    const keys = new Map(
      probe.shots.map((s) => [
        s.id,
        studioCacheKey(s, probe, {
          codeVersion,
          renderer,
          ...(opts.overrides ? { overrides: opts.overrides } : {}),
        }),
      ]),
    );
    const missing: PlanShot[] = [];
    const firstWithKey = new Map<string, string>();
    for (const s of shots) {
      const key = keys.get(s.id)!;
      const hit = await cachedShot(cache, key, s.id);
      if (hit) located.set(s.id, { result: hit, key, hit: true });
      else if (!firstWithKey.has(key)) {
        firstWithKey.set(key, s.id);
        missing.push(s);
      }
    }
    if (missing.length) {
      const job0 = buildStudioJob(plan, product, profile, ctx.workDir, { ...jobOpts, shots: missing });
      const job = {
        ...job0,
        output: { ...job0.output, dir: path.join(ctx.workDir, "studio", job0.jobKey.slice(0, 20)) },
      };
      const started = Date.now();
      let run: StudioRun;
      try {
        run = await runStudio(job, ctx, {
          tools,
          ...(opts.overrides ? { overrides: opts.overrides } : {}),
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        });
      } catch (err) {
        // keep every shot Blender finished before it failed / was killed: the retry resumes from the cache
        const dir = path.resolve(job.output.dir);
        for (const s of missing) {
          const r = await finishedShot(dir, s.id, started);
          if (r) await installShot(cache, keys.get(s.id)!, path.join(dir, s.id), r).catch(() => undefined);
        }
        throw err;
      }
      out.studioRuns += 1;
      out.studioWallMs += run.wallMs;
      for (const r of run.result.shots) {
        const key = keys.get(r.id)!;
        const dir = await installShot(cache, key, path.join(run.dir, r.id), r);
        located.set(r.id, { result: { ...r, dir }, key, hit: false });
      }
      await fsp.rm(run.dir, { recursive: true, force: true });
    }
    // shots that share a render with an earlier shot of this job
    for (const s of shots) {
      if (located.has(s.id)) continue;
      const src = located.get(firstWithKey.get(keys.get(s.id)!)!)!;
      located.set(s.id, { result: { ...src.result, id: s.id }, key: src.key, hit: true });
    }
  }

  const x264Preset = opts.x264Preset ?? "fast";
  for (const shot of plan.shots) {
    const loc = located.get(shot.id);
    if (!loc) continue;
    if (loc.hit)
      ctx.tracker.compute({
        stage: "blender",
        label: `studio ${shot.id} (cached)`,
        wallMs: 0,
        cached: true,
        scope: ctx.scope,
      });
    const clipKey = shotClipKey(loc.key, shot, plan, x264Preset);
    const fresh: { clip?: ShotClip } = {};
    const { path: clipPath, hit: clipHit } = await cache.getOrCreate(
      SHOT_CLIP_NAMESPACE,
      clipKey,
      "clip.mp4",
      async (tmp) => {
        fresh.clip = await encodeShotClip(loc.result, shot, plan, tmp, {
          x264Preset,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      },
    );
    // the product track is a pure function of the shot (no metadata file that could go stale)
    const productTrack =
      fresh.clip?.productTrack ??
      buildShotClipArgs({
        shot: loc.result,
        dir: loc.result.dir,
        planShot: shot,
        fps: plan.fps,
        width: plan.resolution.width,
        height: plan.resolution.height,
        outPath: clipPath,
      }).productTrack;
    const encodeMs = fresh.clip?.encodeMs ?? 0;
    if (fresh.clip)
      ctx.tracker.compute({
        stage: "ffmpeg",
        label: `shot clip ${shot.id} ${shot.technique}`,
        wallMs: encodeMs,
        scope: ctx.scope,
      });
    const clip: ShotClip = {
      shotId: shot.id,
      path: clipPath,
      durationMs: shot.durationMs,
      width: plan.resolution.width,
      height: plan.resolution.height,
      fps: plan.fps,
      productTrack,
      cacheHit: loc.hit,
      renderMs: loc.hit ? 0 : loc.result.renderMs,
      encodeMs,
    };
    out.clips.push(clip);
    const r = loc.result;
    out.shots.push({
      shotId: shot.id,
      studioKey: loc.key,
      renderHit: loc.hit,
      clipHit,
      technique: r.technique,
      renderedPreset: r.renderedPreset ?? shot.preset,
      ...(r.fallbackPreset ? { fallbackPreset: r.fallbackPreset } : {}),
      ...(r.fallbackTechnique ? { fallbackTechnique: r.fallbackTechnique } : {}),
      ...(r.animationFallback ? { animationFallback: r.animationFallback } : {}),
      frames: r.files.length,
      renderSize: { width: r.width, height: r.height },
      renderMs: loc.hit ? 0 : r.renderMs,
      encodeMs: clip.encodeMs,
    });
  }
  return out;
}
