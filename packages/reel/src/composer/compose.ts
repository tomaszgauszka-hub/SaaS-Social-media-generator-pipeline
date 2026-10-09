import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { probeMedia, runFfmpeg } from "@cre/media";
import { sha256Hex, stableStringify } from "@cre/shared";
import * as fontkit from "fontkit";
import type { CostRecorder } from "../capabilities/types.ts";
import type {
  CaptionTrack,
  MusicTrack,
  SfxCueFile,
  ShotClip,
  TextElement,
  VoiceTrack,
} from "../contracts/media.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import { PLATFORM_PROFILES, type BrandProfile, type Rect } from "../contracts/profiles.ts";
import { FileCache, fileSha256 } from "../util/cache.ts";
import {
  buildLoudnessApplyArgs,
  buildLoudnessMeasureArgs,
  buildMixArgs,
  loudnormTarget,
  parseLoudnormJson,
} from "./audio.ts";
import { buildMasterArgs } from "./master.ts";
import { buildReelAss } from "./subtitles.ts";

/**
 * ReelComposer — the local, deterministic editor (FFmpeg + libass). Two passes:
 *
 *   composeMaster     shot clips → MASTER video (transitions, logo; no text, no audio). Cached by visualHash.
 *   composeLocalized  master + music + voice + SFX + captions + text → final MP4 for ONE locale.
 *
 * A new language therefore costs one audio pass + one video pass over the existing master — shots are never
 * re-rendered. Arguments are built by pure functions (master.ts, audio.ts, subtitles.ts) and run without a shell.
 */

export const COMPOSER_VERSION = "reel-composer/1";

/* ---------------------------------------------------------------- fonts ------------------------ */

const faceNames = new Map<string, string>();

/** The face name libass matches for a font file (full name, falls back to family). */
export function fontFaceName(file: string): string {
  let name = faceNames.get(file);
  if (!name) {
    const f = fontkit.create(fs.readFileSync(file)) as fontkit.Font;
    name = (f.fullName || f.familyName || path.basename(file, path.extname(file)))
      .replace(/[\\{},]/g, " ")
      .trim();
    faceNames.set(file, name);
  }
  return name;
}

/** Copy the used font files into `<dir>/fonts` (libass `fontsdir`). */
async function prepareFonts(dir: string, files: readonly string[]): Promise<string> {
  const fontsDir = path.join(dir, "fonts");
  await fsp.mkdir(fontsDir, { recursive: true });
  for (const [i, f] of [...new Set(files)].entries()) {
    await fsp.copyFile(
      f,
      path.join(fontsDir, `${String(i).padStart(2, "0")}${path.extname(f).toLowerCase()}`),
    );
  }
  return "fonts";
}

/* ---------------------------------------------------------------- master ----------------------- */

export interface ComposeMasterInput {
  plan: ReelPlan;
  clips: readonly ShotClip[];
  logo?: BrandProfile["logo"];
  outPath: string;
  workDir: string;
  /** master videos are cached here by visualHash (multilingual + retry reuse) */
  cacheDir?: string;
  tracker?: CostRecorder;
  scope?: string;
  signal?: AbortSignal;
}

export interface MasterVideo {
  path: string;
  durationMs: number;
  frameCount: number;
  /** hash of everything that affects the pixels (never copy / voice / captions) */
  visualHash: string;
  ffmpegMs: number;
  reused: boolean;
  logoBox?: Rect;
}

export async function masterVisualHash(
  input: Pick<ComposeMasterInput, "plan" | "clips" | "logo">,
): Promise<string> {
  const { plan } = input;
  const clips = await Promise.all(
    input.clips.map(async (c) => ({ shotId: c.shotId, sha: await fileSha256(c.path) })),
  );
  return sha256Hex(
    stableStringify({
      v: COMPOSER_VERSION,
      shots: plan.shots.map(({ overlaySlot: _o, ...visual }) => visual),
      resolution: plan.resolution,
      fps: plan.fps,
      durationMs: plan.durationMs,
      platform: plan.platform,
      logo: input.logo
        ? { window: plan.branding.logo, widthPx: input.logo.widthPx, sha: await fileSha256(input.logo.path) }
        : null,
      clips,
    }),
  ).slice(0, 40);
}

export async function composeMaster(input: ComposeMasterInput): Promise<MasterVideo> {
  const t0 = Date.now();
  const { plan } = input;
  const platform = PLATFORM_PROFILES[plan.platform];
  const visualHash = await masterVisualHash(input);
  let logo: Parameters<typeof buildMasterArgs>[0]["logo"];
  if (input.logo && plan.branding.logo.enabled) {
    const info = await probeMedia(input.logo.path);
    if (!info.width || !info.height) throw new Error(`logo ${input.logo.path} has no size`);
    logo = {
      path: input.logo.path,
      width: info.width,
      height: info.height,
      widthPx: input.logo.widthPx,
      position: input.logo.position,
    };
  }
  const render = async (out: string) => {
    const built = buildMasterArgs({
      plan,
      clips: input.clips,
      platform,
      ...(logo ? { logo } : {}),
      outPath: out,
    });
    await runFfmpeg(built.args, input.signal ? { signal: input.signal } : {});
    return built;
  };
  const built = buildMasterArgs({
    plan,
    clips: input.clips,
    platform,
    ...(logo ? { logo } : {}),
    outPath: input.outPath,
  });
  await fsp.mkdir(path.dirname(input.outPath), { recursive: true });
  let reused = false;
  if (input.cacheDir) {
    const cached = await new FileCache(input.cacheDir).getOrCreate(
      "master",
      visualHash,
      "master.mp4",
      async (tmp) => {
        await render(tmp);
      },
    );
    reused = cached.hit;
    if (path.resolve(cached.path) !== path.resolve(input.outPath))
      await fsp.copyFile(cached.path, input.outPath);
  } else {
    await render(input.outPath);
  }
  const ffmpegMs = Date.now() - t0;
  input.tracker?.compute({
    stage: "ffmpeg",
    label: `master ${plan.metadata.variantKey}`,
    wallMs: ffmpegMs,
    frames: built.frameCount,
    cached: reused,
    scope: input.scope ?? "master",
  });
  return {
    path: input.outPath,
    durationMs: Math.round((built.frameCount * 1000) / plan.fps),
    frameCount: built.frameCount,
    visualHash,
    ffmpegMs,
    reused,
    ...(built.logoBox ? { logoBox: built.logoBox } : {}),
  };
}

/* ---------------------------------------------------------------- localized -------------------- */

export interface ComposeLocalizedInput {
  plan: ReelPlan;
  masterPath: string;
  music?: MusicTrack;
  voice?: VoiceTrack;
  sfx: readonly SfxCueFile[];
  captions?: CaptionTrack;
  texts: readonly TextElement[];
  outPath: string;
  posterPath: string;
  workDir: string;
  /** poster frame time (default: middle of the CTA window) */
  posterAtMs?: number;
  tracker?: CostRecorder;
  scope?: string;
  signal?: AbortSignal;
}

export interface LocalizedVideo {
  path: string;
  posterPath: string;
  assPath: string;
  audioPath: string;
  durationMs: number;
  ffmpegMs: number;
  audioMs: number;
  videoMs: number;
  /** loudness of the normalised mix (before AAC) */
  audio: { lufs: number; truePeakDb: number; normalised: boolean };
  duckExpr: string | null;
}

export async function composeLocalized(input: ComposeLocalizedInput): Promise<LocalizedVideo> {
  const t0 = Date.now();
  const { plan } = input;
  const run = (args: string[], logLevel?: "info") =>
    runFfmpeg(args, { ...(input.signal ? { signal: input.signal } : {}), ...(logLevel ? { logLevel } : {}) });
  const tag = `${plan.metadata.variantKey}-${plan.language}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const dir = path.join(input.workDir, `compose-${tag}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  // 1. audio: mix → two-pass loudness to the platform target
  const mixWav = path.join(dir, "mix.wav");
  const finalWav = path.join(dir, "audio.wav");
  const mix = buildMixArgs({
    durationMs: plan.durationMs,
    ...(input.music ? { music: input.music } : {}),
    musicGainDb: plan.music.gainDb,
    ducking: plan.music.ducking,
    ...(input.voice ? { voice: input.voice } : {}),
    sfx: input.sfx,
    outWav: mixWav,
  });
  await run(mix.args);
  // the plan's mastering target (from the platform; a QA retry may lower the true-peak ceiling)
  const target = loudnormTarget({
    lufs: plan.render_profile.audio.lufs,
    truePeakDb: plan.render_profile.audio.truePeakDb,
  });
  let audio: LocalizedVideo["audio"];
  try {
    const measured = parseLoudnormJson((await run(buildLoudnessMeasureArgs(mixWav, target), "info")).stderr);
    const applied = await run(
      buildLoudnessApplyArgs(mixWav, finalWav, target, measured, plan.durationMs),
      "info",
    );
    const out = parseLoudnormJson(applied.stderr);
    audio = { lufs: Number(out.output_i), truePeakDb: Number(out.output_tp), normalised: true };
  } catch {
    // silent mix (no sources) — nothing to normalise
    await run(["-i", mixWav, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", finalWav]);
    audio = { lufs: -70, truePeakDb: -70, normalised: false };
  }
  const audioMs = Date.now() - t0;

  // 2. video: master + libass (captions, hook, overlays, CTA, button, disclosure) + AAC mux
  const t1 = Date.now();
  const fontFiles = [
    ...input.texts.map((t) => t.font.file),
    ...(input.captions ? [input.captions.font.file] : []),
  ];
  const fontsDir = await prepareFonts(dir, fontFiles);
  const assPath = path.join(dir, "captions.ass");
  const defaultFace = fontFiles[0] ? fontFaceName(fontFiles[0]) : "sans-serif";
  await fsp.writeFile(
    assPath,
    buildReelAss({
      width: plan.resolution.width,
      height: plan.resolution.height,
      texts: input.texts,
      ...(input.captions ? { captions: input.captions } : {}),
      faceOf: fontFaceName,
      defaultFace,
    }),
  );
  const frameCount = Math.round((plan.durationMs * plan.fps) / 1000);
  await fsp.mkdir(path.dirname(input.outPath), { recursive: true });
  await runFfmpeg(
    buildLocalizedVideoArgs({
      masterPath: input.masterPath,
      audioPath: finalWav,
      assFile: "captions.ass",
      fontsDir,
      frameCount,
      fps: plan.fps,
      crf: plan.render_profile.encode.crf,
      preset: plan.render_profile.encode.preset,
      outPath: input.outPath,
    }),
    { cwd: dir, ...(input.signal ? { signal: input.signal } : {}) },
  );
  const posterAt = input.posterAtMs ?? Math.round((plan.cta.startMs + plan.cta.endMs) / 2);
  await run([
    "-ss",
    (Math.min(posterAt, plan.durationMs - 100) / 1000).toFixed(3),
    "-i",
    input.outPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    input.posterPath,
  ]);
  const videoMs = Date.now() - t1;
  const ffmpegMs = Date.now() - t0;
  input.tracker?.compute({
    stage: "ffmpeg",
    label: `localized ${tag}`,
    wallMs: ffmpegMs,
    frames: frameCount,
    scope: input.scope ?? plan.language,
  });
  return {
    path: input.outPath,
    posterPath: input.posterPath,
    assPath,
    audioPath: finalWav,
    durationMs: Math.round((frameCount * 1000) / plan.fps),
    ffmpegMs,
    audioMs,
    videoMs,
    audio,
    duckExpr: mix.duckExpr,
  };
}

/** Pure: final encode — libass burn-in (relative paths: ffmpeg runs with cwd = the compose dir) + AAC mux. */
export function buildLocalizedVideoArgs(o: {
  masterPath: string;
  audioPath: string;
  assFile: string;
  fontsDir: string;
  frameCount: number;
  fps: number;
  crf: number;
  preset: string;
  outPath: string;
}): string[] {
  for (const p of [o.assFile, o.fontsDir])
    if (!/^[A-Za-z0-9._-]+$/.test(p)) throw new Error(`unsafe filter path ${p}`);
  return [
    "-i",
    o.masterPath,
    "-i",
    o.audioPath,
    "-filter_complex",
    `[0:v]ass=filename=${o.assFile}:fontsdir=${o.fontsDir},format=yuv420p[v]`,
    "-map",
    "[v]",
    "-map",
    "1:a:0",
    "-frames:v",
    String(o.frameCount),
    "-r",
    String(o.fps),
    "-c:v",
    "libx264",
    "-preset",
    o.preset,
    "-crf",
    String(o.crf),
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(o.fps * 2),
    "-keyint_min",
    String(o.fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    o.outPath,
  ];
}
