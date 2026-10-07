import fs from "node:fs";
import path from "node:path";
import { buildProjectAss } from "./ass.ts";
import { ffColor, filterQuote, getFfmpegConfig, probeMedia, runFfmpeg, type MediaInfo } from "./ffmpeg.ts";
import { renderScene, type SceneRenderContext } from "./scene.ts";
import { VideoProject, type VideoProjectInput } from "./schema.ts";
import { computeTimeline, type Timeline } from "./timeline.ts";

export interface RenderOptions {
  /** maps "asset:<id>" (or any project source string) to a local file path */
  resolveSrc: (src: string) => string;
  /** scratch directory for this render (ASS file etc.) */
  workDir: string;
  /** shared cache directory (scene clips) */
  cacheDir: string;
  outputPath: string;
  coverPath?: string;
  signal?: AbortSignal;
  preset?: string;
  oversample?: number;
  onProgress?: (event: { stage: string; detail?: string }) => void;
}

export interface RenderResult {
  outputPath: string;
  coverPath?: string;
  assPath: string;
  durationMs: number;
  info: MediaInfo;
  timeline: Timeline;
  scenes: { id: string; cached: boolean; ms: number }[];
  totalMs: number;
}

const fmt = (n: number) => Number(n.toFixed(4)).toString();

/** Bump when the final pass (typography, overlays, audio mix) renders identical input differently. */
export const COMPOSITOR_VERSION = "2";

export interface ResolvedAudio {
  music?: string;
  voiceover?: string;
  sfx: string[];
  logo?: string;
}

/**
 * Build the final-pass FFmpeg arguments. Pure function (no I/O) so the graph can be unit-tested.
 * Input order: scene clips, music, voice-over, sfx…, logo, progress-bar source, silence source.
 */
export function buildFinalArgs(
  project: VideoProject,
  timeline: Timeline,
  scenePaths: string[],
  assPath: string,
  audio: ResolvedAudio,
  outputPath: string,
  opts: { preset?: string; fontsDir?: string } = {},
): string[] {
  const { width: W, fps: F } = project.format;
  const T = timeline.totalMs / 1000;
  const inputs: string[][] = scenePaths.map((p) => ["-i", p]);
  const filters: string[] = [];

  // ---- video: join scenes ------------------------------------------------------------------------
  let v = "[0:v]";
  for (let k = 1; k < scenePaths.length; k++) {
    const w = timeline.windows[k]!;
    const out = `[vj${k}]`;
    if (w.transitionMs === 0) {
      filters.push(`${v}[${k}:v]concat=n=2:v=1:a=0${out}`);
    } else {
      filters.push(
        `${v}[${k}:v]xfade=transition=${w.transition}:duration=${fmt(w.transitionMs / 1000)}:offset=${fmt(w.startMs / 1000)}${out}`,
      );
    }
    v = out;
  }
  if (scenePaths.length === 1) {
    filters.push(`[0:v]null[vj0]`);
    v = "[vj0]";
  }

  // ---- typography (libass) -----------------------------------------------------------------------
  const fontsDir = opts.fontsDir ? `:fontsdir=${filterQuote(opts.fontsDir)}` : "";
  filters.push(`${v}ass=filename=${filterQuote(assPath)}${fontsDir}[vt]`);
  v = "[vt]";

  let nextInput = scenePaths.length;
  const audioLabels: string[] = [];
  const aFormat = "aformat=sample_rates=48000:channel_layouts=stereo";

  // ---- audio inputs ------------------------------------------------------------------------------
  let musicLabel: string | undefined;
  if (audio.music && project.audio.music) {
    inputs.push(["-stream_loop", "-1", "-i", audio.music]);
    const i = nextInput++;
    const vol = project.audio.music.volume;
    const fadeOutStart = Math.max(0, T - 1.2);
    filters.push(
      `[${i}:a]${aFormat},atrim=0:${fmt(T)},asetpts=PTS-STARTPTS,volume=${fmt(vol)},` +
        `afade=t=in:st=0:d=0.6,afade=t=out:st=${fmt(fadeOutStart)}:d=1.2[mus]`,
    );
    musicLabel = "[mus]";
  }
  if (audio.voiceover && project.audio.voiceover) {
    inputs.push(["-i", audio.voiceover]);
    const i = nextInput++;
    const delay = Math.round(project.audio.voiceover.startMs);
    filters.push(
      `[${i}:a]${aFormat},adelay=${delay}|${delay},volume=${fmt(project.audio.voiceover.volume)},apad=whole_dur=${fmt(T)},atrim=0:${fmt(T)}[vo]`,
    );
    if (musicLabel && project.audio.music?.duck) {
      filters.push(`[vo]asplit=2[vo1][vosc]`);
      filters.push(
        `${musicLabel}[vosc]sidechaincompress=threshold=0.035:ratio=6:attack=15:release=320[musd]`,
      );
      audioLabels.push("[musd]", "[vo1]");
    } else {
      if (musicLabel) audioLabels.push(musicLabel);
      audioLabels.push("[vo]");
    }
  } else if (musicLabel) {
    audioLabels.push(musicLabel);
  }
  project.audio.sfx.forEach((sfx, n) => {
    const file = audio.sfx[n];
    if (!file) return;
    inputs.push(["-i", file]);
    const i = nextInput++;
    const at = Math.round(sfx.atMs);
    filters.push(`[${i}:a]${aFormat},adelay=${at}|${at},volume=${fmt(sfx.volume)}[sfx${n}]`);
    audioLabels.push(`[sfx${n}]`);
  });

  // ---- logo --------------------------------------------------------------------------------------
  if (audio.logo && project.logo) {
    inputs.push(["-i", audio.logo]);
    const i = nextInput++;
    const lw = Math.round(project.logo.width);
    const margin = Math.round(W * 0.03);
    const pos = project.logo.position;
    const x = pos.endsWith("left") ? `${project.safeArea.left}` : `W-w-${project.safeArea.right}`;
    const y = pos.startsWith("top") ? `${project.safeArea.top - margin}` : `H-h-${project.safeArea.bottom}`;
    filters.push(
      `[${i}:v]scale=${lw}:-2,format=rgba,colorchannelmixer=aa=${fmt(project.logo.opacity)}[logo]`,
    );
    filters.push(`${v}[logo]overlay=x=${x}:y=${y}:format=auto[vl]`);
    v = "[vl]";
  }

  // ---- progress bar ------------------------------------------------------------------------------
  if (project.progressBar?.enabled) {
    const h = project.progressBar.height;
    inputs.push([
      "-f",
      "lavfi",
      "-i",
      `color=c=${ffColor(project.progressBar.color)}:s=${W}x${h}:r=${F}:d=${fmt(T)}`,
    ]);
    const i = nextInput++;
    filters.push(`${v}[${i}:v]overlay=x='-W+W*t/${fmt(T)}':y=0:eof_action=pass[vp]`);
    v = "[vp]";
  }
  filters.push(`${v}format=yuv420p[vout]`);

  // ---- audio mix ---------------------------------------------------------------------------------
  if (audioLabels.length === 0) {
    inputs.push(["-f", "lavfi", "-t", fmt(T), "-i", "anullsrc=r=48000:cl=stereo"]);
    const i = nextInput++;
    filters.push(`[${i}:a]anull[aout]`);
  } else {
    const mix =
      audioLabels.length === 1
        ? `${audioLabels[0]}anull`
        : `${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0:duration=longest:dropout_transition=0`;
    filters.push(
      `${mix},atrim=0:${fmt(T)},loudnorm=I=${project.audio.targetLufs}:TP=-1.5:LRA=11,aresample=48000,${aFormat}[aout]`,
    );
  }

  return [
    ...inputs.flat(),
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    opts.preset ?? project.output.preset,
    "-crf",
    String(project.output.crf),
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(F),
    "-g",
    String(F * 2),
    "-c:a",
    "aac",
    "-b:a",
    project.output.audioBitrate,
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-t",
    fmt(T),
    outputPath,
  ];
}

export async function extractFrame(
  videoPath: string,
  outPath: string,
  atMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await runFfmpeg(
    ["-ss", fmt(atMs / 1000), "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath],
    signal ? { signal } : {},
  );
}

/**
 * Render a VideoProject to an MP4: scenes (cached) → transitions → typography → logo/progress → audio mix.
 * The render is deterministic for identical inputs; nothing here is edited by hand.
 */
export async function renderVideoProject(
  input: VideoProjectInput,
  opts: RenderOptions,
): Promise<RenderResult> {
  const started = Date.now();
  const project = VideoProject.parse(input);
  await fs.promises.mkdir(opts.workDir, { recursive: true });
  await fs.promises.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const timeline = computeTimeline(project.scenes);

  const ctx: SceneRenderContext = {
    format: project.format,
    resolveSrc: opts.resolveSrc,
    cacheDir: opts.cacheDir,
    preset: opts.preset ?? project.output.preset,
    oversample: opts.oversample ?? 2,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const sceneResults: { id: string; cached: boolean; ms: number; path: string }[] = [];
  for (const scene of project.scenes) {
    opts.onProgress?.({ stage: "scene", detail: scene.id });
    const res = await renderScene(scene, ctx);
    sceneResults.push({ id: scene.id, cached: res.cached, ms: res.ms, path: res.path });
  }

  const assPath = path.join(opts.workDir, "overlay.ass");
  await fs.promises.writeFile(assPath, buildProjectAss(project), "utf8");

  const resolved: ResolvedAudio = {
    sfx: project.audio.sfx.map((s) => opts.resolveSrc(s.src)),
    ...(project.audio.music ? { music: opts.resolveSrc(project.audio.music.src) } : {}),
    ...(project.audio.voiceover ? { voiceover: opts.resolveSrc(project.audio.voiceover.src) } : {}),
    ...(project.logo ? { logo: opts.resolveSrc(project.logo.src) } : {}),
  };

  opts.onProgress?.({ stage: "final" });
  const tmpOut = `${opts.outputPath}.tmp.mp4`;
  const fontsDir = getFfmpegConfig().fontsDir;
  const args = buildFinalArgs(
    project,
    timeline,
    sceneResults.map((s) => s.path),
    assPath,
    resolved,
    tmpOut,
    {
      ...(opts.preset ? { preset: opts.preset } : {}),
      ...(fontsDir ? { fontsDir } : {}),
    },
  );
  await runFfmpeg(args, opts.signal ? { signal: opts.signal } : {});
  await fs.promises.rename(tmpOut, opts.outputPath);

  if (opts.coverPath) {
    await fs.promises.mkdir(path.dirname(opts.coverPath), { recursive: true });
    const at = Math.min(project.coverAtMs, Math.max(0, timeline.totalMs - 100));
    await extractFrame(opts.outputPath, opts.coverPath, at, opts.signal);
  }

  const info = await probeMedia(opts.outputPath);
  return {
    outputPath: opts.outputPath,
    ...(opts.coverPath ? { coverPath: opts.coverPath } : {}),
    assPath,
    durationMs: info.durationMs,
    info,
    timeline,
    scenes: sceneResults.map(({ id, cached, ms }) => ({ id, cached, ms })),
    totalMs: Date.now() - started,
  };
}
