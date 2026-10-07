import fs from "node:fs";
import path from "node:path";
import { sha256Hex, stableStringify } from "@cre/shared";
import { ffColor, probeMedia, runFfmpeg } from "./ffmpeg.ts";
import type { Background, Format, ImageLayer, MotionType, Scene } from "./schema.ts";

/** Bump when the scene filtergraph changes so cached clips are not reused across renderer versions. */
export const SCENE_RENDERER_VERSION = "4";

export interface SceneRenderContext {
  format: Format;
  /** x264 preset for intermediate scene clips (cache only; final encode uses `preset`) */
  intermediatePreset?: string;
  /** maps a project source reference ("asset:<id>", path …) to a local file path */
  resolveSrc: (src: string) => string;
  cacheDir: string;
  preset?: string;
  signal?: AbortSignal;
  /** oversampling factor for smooth zoom/pan (2 = motion computed on a 2× canvas) */
  oversample?: number;
}

export interface SceneGraph {
  inputs: string[][];
  filter: string;
  /** label of the final rgba stream (before pixel-format conversion) */
  outLabel: string;
  frames: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const fmt = (n: number) => Number(n.toFixed(4)).toString();

export function frameCount(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps));
}

/** Smoothstep easing of progress p = on/(N-1), as an FFmpeg expression. */
function easeExpr(frames: number): string {
  const p = `(on/${Math.max(1, frames - 1)})`;
  return `(${p}*${p}*(3-2*${p}))`;
}

export function zoompanExpressions(
  motion: MotionType,
  intensity: number,
  frames: number,
): { z: string; x: string; y: string } | null {
  const e = easeExpr(frames);
  const i = fmt(intensity);
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  switch (motion) {
    case "static":
      return null;
    case "zoom_in":
      return { z: `1+${i}*${e}`, x: cx, y: cy };
    case "zoom_out":
      return { z: `1+${i}*(1-${e})`, x: cx, y: cy };
    case "kenburns":
      return {
        z: `1+${i}*${e}`,
        x: `(iw-iw/zoom)*(0.35+0.3*${e})`,
        y: `(ih-ih/zoom)*(0.55-0.25*${e})`,
      };
    case "pan_left":
      return { z: fmt(1 + intensity), x: `(iw-iw/zoom)*(1-${e})`, y: `(ih-ih/zoom)/2` };
    case "pan_right":
      return { z: fmt(1 + intensity), x: `(iw-iw/zoom)*${e}`, y: `(ih-ih/zoom)/2` };
    case "pan_up":
      return { z: fmt(1 + intensity), x: `(iw-iw/zoom)/2`, y: `(ih-ih/zoom)*(1-${e})` };
    case "pan_down":
      return { z: fmt(1 + intensity), x: `(iw-iw/zoom)/2`, y: `(ih-ih/zoom)*${e}` };
  }
}

function backgroundInput(
  bg: Background,
  format: Format,
  durationSec: number,
  resolve: (s: string) => string,
): string[] {
  const { width: W, height: H, fps: F } = format;
  switch (bg.type) {
    case "color":
      return ["-f", "lavfi", "-i", `color=c=${ffColor(bg.color)}:s=${W}x${H}:r=${F}:d=${fmt(durationSec)}`];
    case "gradient": {
      const speed = bg.animated ? 0.006 : 0.00001;
      return [
        "-f",
        "lavfi",
        "-i",
        `gradients=s=${W}x${H}:c0=${ffColor(bg.colors[0])}:c1=${ffColor(bg.colors[1])}:x0=0:y0=0:x1=${W}:y1=${H}:speed=${speed}:r=${F}:d=${fmt(durationSec)}:seed=42`,
      ];
    }
    case "image":
      return ["-i", resolve(bg.src)];
    case "video":
      return ["-i", resolve(bg.src)];
  }
}

/**
 * Background chain. Everything stays yuv420p (overlay blends rgba layers onto it with format=auto), and costly
 * per-image work (blur, darken) runs once on the single source frame before zoompan multiplies it into frames.
 */
function backgroundChain(bg: Background, format: Format, frames: number, oversample: number): string {
  const { width: W, height: H, fps: F } = format;
  const durationSec = frames / F;
  const darken = (amount: number) =>
    amount > 0 ? `,drawbox=x=0:y=0:w=iw:h=ih:color=black@${fmt(amount)}:t=fill` : "";
  switch (bg.type) {
    case "color":
    case "gradient":
      return `[0:v]format=yuv420p,setsar=1[bg]`;
    case "video": {
      const blur = bg.blur > 0 ? `,gblur=sigma=${fmt(bg.blur)}` : "";
      return (
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${F},` +
        `trim=duration=${fmt(durationSec)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${fmt(durationSec)},` +
        `trim=duration=${fmt(durationSec)}${blur}${darken(bg.darken)},format=yuv420p[bg]`
      );
    }
    case "image": {
      const motion = zoompanExpressions(bg.motion.type, bg.motion.intensity, frames);
      const os = motion ? oversample : 1;
      const w = even(W * os);
      const h = even(H * os);
      const blur = bg.blur > 0 ? `,gblur=sigma=${fmt(bg.blur * os)}` : "";
      const base = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1${blur}${darken(bg.darken)},format=yuv420p`;
      const move = motion
        ? `,zoompan=z='${motion.z}':x='${motion.x}':y='${motion.y}':d=${frames}:s=${W}x${H}:fps=${F}`
        : `,loop=loop=${frames - 1}:size=1:start=0,setpts=N/(${F}*TB)`;
      return `${base}${move}[bg]`;
    }
  }
}

interface FittedLayer {
  layer: ImageLayer;
  path: string;
  w: number;
  h: number;
}

async function fitLayer(
  layer: ImageLayer,
  resolve: (s: string) => string,
  signal?: AbortSignal,
): Promise<FittedLayer> {
  const p = resolve(layer.src);
  const info = await probeMedia(p, signal ? { signal } : {});
  const iw = info.width ?? layer.width;
  const ih = info.height ?? layer.height;
  const scale = Math.min(layer.width / iw, layer.height / ih);
  return { layer, path: p, w: even(iw * scale), h: even(ih * scale) };
}

function layerPositionExpr(fl: FittedLayer, format: Format, durationSec: number): { x: string; y: string } {
  const { layer, w, h } = fl;
  const u = format.width / 1080;
  const st = fmt(layer.enterAtMs / 1000);
  const dur = fmt(Math.max(0.05, layer.enterDurationMs / 1000));
  const progress = `min(1,max(0,(t-${st})/${dur}))`;
  const easeOut = `pow(1-${progress},3)`;
  let x = `${fmt(layer.x - w / 2)}`;
  let y = `${fmt(layer.y - h / 2)}`;
  if (layer.driftX !== 0) x += `+${fmt(layer.driftX)}*t/${fmt(durationSec)}`;
  if (layer.enter === "slide_left") x += `+${fmt(format.width * 0.6)}*${easeOut}`;
  if (layer.enter === "slide_right") x += `-${fmt(format.width * 0.6)}*${easeOut}`;
  if (layer.enter === "slide_up") y += `+${fmt(160 * u)}*${easeOut}`;
  if (layer.enter === "rise") y += `+${fmt(60 * u)}*(1-${progress})`;
  if (layer.float) y += `+${fmt(10 * u)}*sin(2*PI*t/3.2)`;
  return { x, y };
}

/**
 * Build the FFmpeg inputs + filtergraph for one scene. The graph ends in an rgba stream labelled `outLabel`
 * so callers can append further filters (e.g. libass text for still images).
 */
export async function buildSceneGraph(scene: Scene, ctx: SceneRenderContext): Promise<SceneGraph> {
  const { format } = ctx;
  const frames = frameCount(scene.durationMs, format.fps);
  const durationSec = frames / format.fps;
  const inputs: string[][] = [backgroundInput(scene.background, format, durationSec, ctx.resolveSrc)];
  const parts: string[] = [backgroundChain(scene.background, format, frames, ctx.oversample ?? 2)];

  const fitted = await Promise.all(scene.layers.map((l) => fitLayer(l, ctx.resolveSrc, ctx.signal)));
  let base = "bg";
  fitted.forEach((fl, i) => {
    const idx = i + 1;
    inputs.push(["-i", fl.path]);
    const { layer, w, h } = fl;
    const fade =
      layer.enter !== "none"
        ? `,fade=t=in:st=${fmt(layer.enterAtMs / 1000)}:d=${fmt(Math.max(0.05, layer.enterDurationMs / 1000))}:alpha=1`
        : "";
    parts.push(
      `[${idx}:v]scale=${w}:${h}:flags=lanczos,format=rgba,loop=loop=${frames - 1}:size=1:start=0,setpts=N/(${format.fps}*TB)${fade}[l${i}]`,
    );
    const pos = layerPositionExpr(fl, format, durationSec);
    if (layer.shadow) {
      const pad = even(Math.max(16, Math.max(w, h) * 0.06));
      const blur = Math.max(4, Math.min(Math.round(pad * 0.6), Math.floor(Math.min(w, h) / 4)));
      const offX = Math.round(format.width * 0.012);
      const offY = Math.round(format.width * 0.022);
      parts.push(
        `[l${i}]split=2[l${i}a][l${i}s]`,
        `[l${i}s]pad=iw+${pad * 2}:ih+${pad * 2}:${pad}:${pad}:color=black@0,` +
          `colorchannelmixer=rr=0:rg=0:rb=0:gr=0:gg=0:gb=0:br=0:bg=0:bb=0:aa=0.55,` +
          `boxblur=luma_radius=0:chroma_radius=0:alpha_radius=${blur}:alpha_power=2[s${i}]`,
        `[${base}][s${i}]overlay=x='${pos.x}-${pad}+${offX}':y='${pos.y}-${pad}+${offY}':format=auto:shortest=1[bs${i}]`,
        `[bs${i}][l${i}a]overlay=x='${pos.x}':y='${pos.y}':format=auto:shortest=1[b${i}]`,
      );
    } else {
      parts.push(`[${base}][l${i}]overlay=x='${pos.x}':y='${pos.y}':format=auto:shortest=1[b${i}]`);
    }
    base = `b${i}`;
  });

  if (scene.vignette) {
    parts.push(`[${base}]vignette=angle=PI/5[vg]`);
    base = "vg";
  }
  return { inputs, filter: parts.join(";"), outLabel: base, frames };
}

async function fileFingerprint(p: string): Promise<string> {
  try {
    const st = await fs.promises.stat(p);
    return `${p}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return `${p}:missing`;
  }
}

/** Cache key = renderer version + scene JSON + output format + fingerprints of every input file. */
export async function sceneCacheKey(scene: Scene, ctx: SceneRenderContext): Promise<string> {
  const sources: string[] = [];
  if (scene.background.type === "image" || scene.background.type === "video")
    sources.push(scene.background.src);
  for (const l of scene.layers) sources.push(l.src);
  const fingerprints = await Promise.all(sources.map((s) => fileFingerprint(ctx.resolveSrc(s))));
  return sha256Hex(
    stableStringify({
      v: SCENE_RENDERER_VERSION,
      scene: { ...scene, id: undefined },
      format: ctx.format,
      oversample: ctx.oversample ?? 2,
      intermediatePreset: ctx.intermediatePreset ?? "ultrafast",
      fingerprints,
    }),
  ).slice(0, 40);
}

export interface SceneRenderResult {
  path: string;
  cached: boolean;
  ms: number;
  frames: number;
}

/** Render one scene to an intermediate MP4 (no audio), reusing a cached clip when inputs are unchanged. */
export async function renderScene(scene: Scene, ctx: SceneRenderContext): Promise<SceneRenderResult> {
  const started = Date.now();
  const key = await sceneCacheKey(scene, ctx);
  const dir = path.join(ctx.cacheDir, "scenes");
  await fs.promises.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${key}.mp4`);
  const frames = frameCount(scene.durationMs, ctx.format.fps);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    return { path: out, cached: true, ms: Date.now() - started, frames };
  }
  const tmp = `${out}.${process.pid}.${Date.now()}.tmp.mp4`;
  await renderSceneToFile(scene, ctx, tmp);
  await fs.promises.rename(tmp, out); // atomic publish into the cache
  return { path: out, cached: false, ms: Date.now() - started, frames };
}

export async function renderSceneToFile(
  scene: Scene,
  ctx: SceneRenderContext,
  outPath: string,
): Promise<void> {
  const graph = await buildSceneGraph(scene, ctx);
  const args = [
    ...graph.inputs.flat(),
    "-filter_complex",
    `${graph.filter};[${graph.outLabel}]format=yuv420p[vout]`,
    "-map",
    "[vout]",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    ctx.intermediatePreset ?? "ultrafast",
    "-crf",
    "15",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(ctx.format.fps),
    "-frames:v",
    String(graph.frames),
    "-f",
    "mp4",
    outPath,
  ];
  await runFfmpeg(args, ctx.signal ? { signal: ctx.signal } : {});
}
