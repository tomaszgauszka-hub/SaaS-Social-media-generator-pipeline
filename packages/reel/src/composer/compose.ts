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
import type { BrandProfile, PlatformProfile, Rect } from "../contracts/profiles.ts";
import { FileCache, fileSha256 } from "../util/cache.ts";
import {
  buildLoudnessApplyArgs,
  buildLoudnessMeasureArgs,
  buildMixArgs,
  loudnormTarget,
  parseLoudnormJson,
} from "./audio.ts";
import { buildMasterArgs, logoOverlay, textBandTop } from "./master.ts";
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

const cellRatios = new Map<string, number>();

/**
 * libass's \fs per em of a font file: it sizes a face by ascent + descent — the OS/2 win metrics (as
 * VSFilter / GDI), else FreeType's own (hhea), else the typo metrics, else the bbox — over unitsPerEm.
 * Inter: 2478 / 2048.
 */
export function fontCellRatio(file: string): number {
  let ratio = cellRatios.get(file);
  if (ratio === undefined) {
    const f = fontkit.create(fs.readFileSync(file)) as fontkit.Font;
    const os2 = (f as unknown as { "OS/2"?: Record<string, number> })["OS/2"];
    const cell = [
      (os2?.winAscent ?? 0) + (os2?.winDescent ?? 0),
      f.ascent - f.descent,
      (os2?.typoAscender ?? 0) - (os2?.typoDescender ?? 0),
      f.bbox.maxY - f.bbox.minY,
    ].find((h) => h > 0);
    ratio = cell && f.unitsPerEm > 0 ? cell / f.unitsPerEm : 1;
    cellRatios.set(file, ratio);
  }
  return ratio;
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
  outPath: string;
  workDir: string;
  /** master videos are cached here by visualHash (multilingual, multi-platform, A/B and retry reuse) */
  cacheDir?: string;
  tracker?: CostRecorder;
  scope?: string;
  signal?: AbortSignal;
}

export interface MasterVideo {
  path: string;
  durationMs: number;
  frameCount: number;
  /** hash of everything that affects the pixels (never copy, voice, captions, logo or platform) */
  visualHash: string;
  ffmpegMs: number;
  reused: boolean;
}

export async function masterVisualHash(input: Pick<ComposeMasterInput, "plan" | "clips">): Promise<string> {
  const { plan } = input;
  const clips = await Promise.all(
    input.clips.map(async (c) => ({ shotId: c.shotId, sha: await fileSha256(c.path) })),
  );
  return sha256Hex(
    stableStringify({
      v: COMPOSER_VERSION,
      // only what reaches the pixels: timing, transitions and the clips (overlay slots are copy)
      shots: plan.shots.map((s) => ({
        id: s.id,
        startMs: s.startMs,
        durationMs: s.durationMs,
        transitionIn: s.transitionIn,
      })),
      resolution: plan.resolution,
      fps: plan.fps,
      durationMs: plan.durationMs,
      clips,
    }),
  ).slice(0, 40);
}

export async function composeMaster(input: ComposeMasterInput): Promise<MasterVideo> {
  const t0 = Date.now();
  const { plan } = input;
  const visualHash = await masterVisualHash(input);
  const render = async (out: string) => {
    const built = buildMasterArgs({ plan, clips: input.clips, outPath: out });
    await runFfmpeg(built.args, input.signal ? { signal: input.signal } : {});
  };
  const { frameCount } = buildMasterArgs({ plan, clips: input.clips, outPath: input.outPath });
  await fsp.mkdir(path.dirname(input.outPath), { recursive: true });
  let reused = false;
  if (input.cacheDir) {
    const cached = await new FileCache(input.cacheDir).getOrCreate(
      "master",
      visualHash,
      "master.mp4",
      render,
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
    frames: frameCount,
    cached: reused,
    scope: input.scope ?? "master",
  });
  return {
    path: input.outPath,
    durationMs: Math.round((frameCount * 1000) / plan.fps),
    frameCount,
    visualHash,
    ffmpegMs,
    reused,
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
  /** the platform this pass delivers for (logo placement; the layout / captions were built for it) */
  platform: PlatformProfile;
  /** brand logo, placed per platform outside its UI zones */
  logo?: BrandProfile["logo"];
  /** reuse the normalised audio of an earlier pass (same plan audio, another platform) */
  reuseAudio?: { path: string; lufs: number; truePeakDb: number };
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
  audioReused: boolean;
  logoBox?: Rect;
}

const logoSizes = new Map<string, { width: number; height: number }>();

async function logoSize(file: string): Promise<{ width: number; height: number }> {
  let s = logoSizes.get(file);
  if (!s) {
    const info = await probeMedia(file);
    if (!info.width || !info.height) throw new Error(`logo ${file} has no size`);
    s = { width: info.width, height: info.height };
    logoSizes.set(file, s);
  }
  return s;
}

export async function composeLocalized(input: ComposeLocalizedInput): Promise<LocalizedVideo> {
  const t0 = Date.now();
  const { plan } = input;
  const run = (args: string[], logLevel?: "info") =>
    runFfmpeg(args, { ...(input.signal ? { signal: input.signal } : {}), ...(logLevel ? { logLevel } : {}) });
  const tag = `${plan.metadata.variantKey}-${plan.language}-${input.platform.id}`.replace(
    /[^A-Za-z0-9_-]/g,
    "_",
  );
  const dir = path.join(input.workDir, `compose-${tag}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  // 1. audio: mix → two-pass loudness to the plan's target (or reuse the identical audio of another platform)
  const mixWav = path.join(dir, "mix.wav");
  const finalWav = input.reuseAudio?.path ?? path.join(dir, "audio.wav");
  const mix = buildMixArgs({
    durationMs: plan.durationMs,
    ...(input.music ? { music: input.music } : {}),
    musicGainDb: plan.music.gainDb,
    ducking: plan.music.ducking,
    ...(input.voice ? { voice: input.voice } : {}),
    sfx: input.sfx,
    outWav: mixWav,
  });
  let audio: LocalizedVideo["audio"];
  if (input.reuseAudio) {
    audio = { lufs: input.reuseAudio.lufs, truePeakDb: input.reuseAudio.truePeakDb, normalised: true };
  } else {
    audio = await masterAudio();
  }
  async function masterAudio(): Promise<LocalizedVideo["audio"]> {
    await run(mix.args);
    // the plan's mastering target (from the platform; a QA retry may lower the true-peak ceiling)
    const target = loudnormTarget({
      lufs: plan.render_profile.audio.lufs,
      truePeakDb: plan.render_profile.audio.truePeakDb,
    });
    try {
      const measured = parseLoudnormJson(
        (await run(buildLoudnessMeasureArgs(mixWav, target), "info")).stderr,
      );
      const applied = await run(
        buildLoudnessApplyArgs(mixWav, finalWav, target, measured, plan.durationMs),
        "info",
      );
      const out = parseLoudnormJson(applied.stderr);
      return { lufs: Number(out.output_i), truePeakDb: Number(out.output_tp), normalised: true };
    } catch {
      // silent mix (no sources) — nothing to normalise
      await run(["-i", mixWav, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", finalWav]);
      return { lufs: -70, truePeakDb: -70, normalised: false };
    }
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
      cellRatioOf: fontCellRatio,
      defaultFace,
      locale: plan.language,
    }),
  );
  const frameCount = Math.round((plan.durationMs * plan.fps) / 1000);
  await fsp.mkdir(path.dirname(input.outPath), { recursive: true });
  const logoWin = plan.branding.logo;
  const textTop = textBandTop(input.texts, plan.resolution.height);
  const logo =
    input.logo && logoWin.enabled && logoWin.endMs > logoWin.startMs
      ? logoOverlay({
          ...(textTop !== undefined ? { textTop } : {}),
          logo: { ...input.logo, ...(await logoSize(input.logo.path)), position: logoWin.position },
          window: logoWin,
          platform: input.platform,
          fps: plan.fps,
          durationMs: plan.durationMs,
          inputIndex: 2,
          inLabel: "0:v",
          outLabel: "lg",
        })
      : undefined;
  await runFfmpeg(
    buildLocalizedVideoArgs({
      ...(logo ? { logo } : {}),
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
    duckExpr: input.reuseAudio ? null : mix.duckExpr,
    audioReused: Boolean(input.reuseAudio),
    ...(logo ? { logoBox: logo.box } : {}),
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
  /** logo overlay built by logoOverlay() with inputIndex 2, inLabel "0:v", outLabel "lg" */
  logo?: { inputArgs: string[]; graph: string[] };
}): string[] {
  for (const p of [o.assFile, o.fontsDir])
    if (!/^[A-Za-z0-9._-]+$/.test(p)) throw new Error(`unsafe filter path ${p}`);
  const subs = `ass=filename=${o.assFile}:fontsdir=${o.fontsDir},format=yuv420p[v]`;
  return [
    "-i",
    o.masterPath,
    "-i",
    o.audioPath,
    ...(o.logo ? o.logo.inputArgs : []),
    "-filter_complex",
    o.logo ? `${o.logo.graph.join(";")};[lg]${subs}` : `[0:v]${subs}`,
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
