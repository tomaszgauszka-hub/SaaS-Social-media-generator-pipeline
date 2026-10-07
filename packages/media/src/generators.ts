import fs from "node:fs";
import path from "node:path";
import { seededRandom } from "@cre/shared";
import { estimateWordTimings, sanitizeAssText, wrapText } from "./ass.ts";
import { drawtextFont, ffColor, filterQuote, probeMedia, runFfmpeg } from "./ffmpeg.ts";
import { renderSceneToFile } from "./scene.ts";
import type { MotionType, SubtitleWord } from "./schema.ts";
import { mixHex, readableOn } from "./templates.ts";

/**
 * Programmatic media generated locally with FFmpeg. Zero API cost.
 * Used by the mock providers (MOCK_MEDIA=true) and as free fallbacks (music beds, SFX, placeholders).
 */

const fmt = (n: number) => Number(n.toFixed(4)).toString();

async function ensureDir(file: string) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
}

async function writeTextFile(dir: string, name: string, content: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fs.promises.writeFile(p, content, "utf8");
  return p;
}

export interface GradientImageOptions {
  width: number;
  height: number;
  colors: [string, string];
  seed: string;
  /** small caption burned into the image (e.g. "MOCK IMAGE · prompt…") */
  label?: string;
  signal?: AbortSignal;
}

/** Abstract gradient "scene" with soft bokeh, film grain and vignette — stands in for an AI image. */
export async function generateGradientImage(outPath: string, opts: GradientImageOptions): Promise<void> {
  await ensureDir(outPath);
  const rnd = seededRandom(opts.seed);
  const { width: W, height: H } = opts;
  const parts: string[] = [
    `gradients=s=${W}x${H}:c0=${ffColor(opts.colors[0])}:c1=${ffColor(opts.colors[1])}:x0=${Math.round(rnd() * W * 0.3)}:y0=0:x1=${W}:y1=${H}:seed=${Math.floor(rnd() * 1e6)}:d=0.1,format=rgba[g]`,
  ];
  let base = "g";
  const circles = 5;
  for (let i = 0; i < circles; i++) {
    const r = Math.round((0.08 + rnd() * 0.16) * W);
    const x = Math.round(rnd() * W - r);
    const y = Math.round(rnd() * H - r);
    const light = mixHex(opts.colors[i % 2 === 0 ? 0 : 1], "#FFFFFF", 0.55);
    const alpha = (0.1 + rnd() * 0.12).toFixed(3);
    parts.push(
      `color=c=${ffColor(light)}:s=${r * 2}x${r * 2}:d=0.1,format=rgba,` +
        `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*${alpha}*clip(1-hypot(X-${r},Y-${r})/${r},0,1)',gblur=sigma=${Math.max(2, Math.round(r / 6))}[c${i}]`,
      `[${base}][c${i}]overlay=x=${x}:y=${y}:format=auto[g${i}]`,
    );
    base = `g${i}`;
  }
  parts.push(`[${base}]noise=alls=7:allf=t,vignette=angle=PI/4.5[v]`);
  let final = "v";
  if (opts.label) {
    const dir = path.dirname(outPath);
    const labelFile = await writeTextFile(
      dir,
      `${path.basename(outPath)}.label.txt`,
      sanitizeAssText(opts.label).slice(0, 90),
    );
    parts.push(
      `[v]drawtext=textfile=${filterQuote(labelFile)}:${drawtextFont("Inter")}fontsize=${Math.round(W * 0.022)}:fontcolor=white@0.55:` +
        `x=(w-text_w)/2:y=h-${Math.round(H * 0.045)}:box=1:boxcolor=black@0.25:boxborderw=${Math.round(W * 0.012)}[vl]`,
    );
    final = "vl";
  }
  await runFfmpeg(
    [
      "-filter_complex",
      `${parts.join(";")};[${final}]format=rgb24[out]`,
      "-map",
      "[out]",
      "-frames:v",
      "1",
      outPath,
    ],
    opts.signal ? { signal: opts.signal } : {},
  );
}

export interface PackshotOptions {
  title: string;
  subtitle?: string;
  primary: string;
  accent: string;
  width?: number;
  height?: number;
  signal?: AbortSignal;
}

/**
 * Stylised product "packshot" placeholder (transparent PNG): a rounded package with a label showing the real
 * product title. Clearly a placeholder — QA flags it so real product photos replace it before real publishing.
 */
export async function generateProductPackshot(outPath: string, opts: PackshotOptions): Promise<void> {
  await ensureDir(outPath);
  const W = opts.width ?? 900;
  const H = opts.height ?? 1100;
  const bw = Math.round(W * 0.62);
  const bh = Math.round(H * 0.8);
  const rad = Math.round(bw * 0.09);
  const [r0, g0, b0] = hexRgb(opts.primary);
  const shade = (c: number) =>
    `clip(${c}*(1.08-0.38*Y/${bh})*(1+0.28*exp(-pow((X-${Math.round(bw * 0.2)})/${Math.round(bw * 0.07)},2))),0,255)`;
  const alpha = `255*clip(${rad}+0.5-hypot(max(0,abs(X-${bw / 2})-${bw / 2 - rad}),max(0,abs(Y-${bh / 2})-${bh / 2 - rad})),0,1)`;
  const lw = Math.round(bw * 0.84);
  const lh = Math.round(bh * 0.36);
  const lrad = Math.round(lw * 0.06);
  const labelAlpha = `240*clip(${lrad}+0.5-hypot(max(0,abs(X-${lw / 2})-${lw / 2 - lrad}),max(0,abs(Y-${lh / 2})-${lh / 2 - lrad})),0,1)`;
  const capW = Math.round(bw * 0.42);
  const capH = Math.round(bh * 0.07);
  const capRad = Math.round(capH * 0.35);
  const capAlpha = `255*clip(${capRad}+0.5-hypot(max(0,abs(X-${capW / 2})-${capW / 2 - capRad}),max(0,abs(Y-${capH / 2})-${capH / 2 - capRad})),0,1)`;
  const capColor = hexRgb(mixHex(opts.primary, "#000000", 0.45));

  const titleSize = Math.round(lw * 0.11);
  const titleLines = wrapText(sanitizeAssText(opts.title), lw * 0.86, titleSize).slice(0, 3);
  const dir = path.join(path.dirname(outPath), `.${path.basename(outPath)}.txt`);
  const labelTop = Math.round((H - bh) / 2 + bh * 0.34);
  const textColor = readableOn("#FFFFFF");
  const drawtexts: string[] = [];
  for (let i = 0; i < titleLines.length; i++) {
    const f = await writeTextFile(dir, `line${i}.txt`, titleLines[i]!);
    const y =
      labelTop +
      Math.round(lh * 0.5) -
      Math.round((titleLines.length * titleSize * 1.25) / 2) +
      Math.round(i * titleSize * 1.25);
    drawtexts.push(
      `drawtext=textfile=${filterQuote(f)}:${drawtextFont("Inter:style=Bold")}fontsize=${titleSize}:fontcolor=${ffColor(textColor)}:x=(w-text_w)/2:y=${y}`,
    );
  }
  if (opts.subtitle) {
    const f = await writeTextFile(dir, "sub.txt", sanitizeAssText(opts.subtitle).slice(0, 40));
    drawtexts.push(
      `drawtext=textfile=${filterQuote(f)}:${drawtextFont("Inter")}fontsize=${Math.round(titleSize * 0.55)}:fontcolor=${ffColor(opts.accent)}:x=(w-text_w)/2:y=${labelTop + Math.round(lh * 0.82)}`,
    );
  }
  const graph = [
    `color=c=black@0.0:s=${W}x${H}:d=0.1,format=rgba[canvas]`,
    `color=c=black:s=${bw}x${bh}:d=0.1,format=rgba,geq=r='${shade(r0)}':g='${shade(g0)}':b='${shade(b0)}':a='${alpha}'[box]`,
    `color=c=white:s=${lw}x${lh}:d=0.1,format=rgba,geq=r='255':g='255':b='255':a='${labelAlpha}'[label]`,
    `color=c=black:s=${capW}x${capH}:d=0.1,format=rgba,geq=r='${capColor[0]}':g='${capColor[1]}':b='${capColor[2]}':a='${capAlpha}'[cap]`,
    `[canvas][box]overlay=x=${Math.round((W - bw) / 2)}:y=${Math.round((H - bh) / 2)}:format=auto[c1]`,
    `[c1][cap]overlay=x=${Math.round((W - capW) / 2)}:y=${Math.round((H - bh) / 2 - capH * 0.75)}:format=auto[c2]`,
    `[c2][label]overlay=x=${Math.round((W - lw) / 2)}:y=${labelTop}:format=auto[c3]`,
    `[c3]${drawtexts.length ? drawtexts.join(",") : "null"},format=rgba[out]`,
  ].join(";");
  await runFfmpeg(
    ["-filter_complex", graph, "-map", "[out]", "-frames:v", "1", outPath],
    opts.signal ? { signal: opts.signal } : {},
  );
  await fs.promises.rm(dir, { recursive: true, force: true });
}

function hexRgb(hex: string): [number, number, number] {
  const c = hex.replace(/^#/, "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

const PROGRESSIONS: Record<string, number[][]> = {
  // semitone offsets from the key root for 3-note chords (I–V–vi–IV etc.)
  upbeat: [
    [0, 4, 7],
    [-5, -1, 2],
    [-3, 0, 4],
    [-7, -3, 0],
  ],
  chill: [
    [-3, 0, 4],
    [-7, -3, 0],
    [0, 4, 7],
    [-5, -1, 2],
  ],
  tech: [
    [-3, 0, 4],
    [-7, -3, 0],
    [0, 3, 7],
    [-2, 2, 5],
  ],
};

/**
 * Procedural, royalty-free music bed: 4-chord pad progression with soft pulse and kick.
 * Each chord has an attack/release envelope so chord changes never click.
 */
export async function generateMusicBed(
  outPath: string,
  opts: {
    durationSec: number;
    seed: string;
    mood?: keyof typeof PROGRESSIONS;
    bpm?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  await ensureDir(outPath);
  const rnd = seededRandom(opts.seed);
  const progression = PROGRESSIONS[opts.mood ?? "upbeat"] ?? PROGRESSIONS.upbeat!;
  const transpose = Math.floor(rnd() * 7) - 3;
  const root = 261.63 * 2 ** (transpose / 12);
  const bpm = opts.bpm ?? 110;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const seg = `mod(floor(t/${fmt(bar)}),4)`;
  const m = `mod(t,${fmt(bar)})`;
  const freq = (note: number) => {
    const values = progression.map((chord) => root * 2 ** ((chord[note] ?? 0) / 12));
    return `if(eq(${seg},0),${fmt(values[0]!)},if(eq(${seg},1),${fmt(values[1]!)},if(eq(${seg},2),${fmt(values[2]!)},${fmt(values[3]!)})))`;
  };
  const env = `(1-exp(-9*${m}))*(1-exp(-9*(${fmt(bar)}-${m})))*(0.7+0.3*exp(-1.2*${m}))`;
  const pad = `0.075*(sin(2*PI*${freq(0)}*t)+sin(2*PI*${freq(1)}*t)+0.8*sin(2*PI*${freq(2)}*t))`;
  const bass = `0.11*sin(2*PI*(${freq(0)}/2)*t)`;
  const pulse = `(0.82+0.18*sin(2*PI*t/${fmt(beat)}))`;
  const kick = `0.22*sin(2*PI*52*mod(t,${fmt(beat)}))*exp(-16*mod(t,${fmt(beat)}))`;
  const expr = `(${pad}+${bass})*${env}*${pulse}+${kick}`;
  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=exprs='${expr}|${expr}':s=48000:d=${fmt(opts.durationSec)}`,
      "-af",
      "lowpass=f=5000,aecho=0.8:0.55:45|80:0.18|0.12,volume=0.9",
      "-ar",
      "48000",
      "-ac",
      "2",
      outPath,
    ],
    opts.signal ? { signal: opts.signal } : {},
  );
}

export interface SpeechResult {
  durationMs: number;
  words: SubtitleWord[];
}

/**
 * Local text-to-speech with FFmpeg's flite (robotic but free). Word timings are estimated.
 * Voices: kal, slt, awb, rms.
 */
export async function generateSpeech(
  outPath: string,
  opts: { text: string; voice?: string; signal?: AbortSignal },
): Promise<SpeechResult> {
  await ensureDir(outPath);
  const textFile = await writeTextFile(
    path.dirname(outPath),
    `${path.basename(outPath)}.txt`,
    sanitizeAssText(opts.text),
  );
  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `flite=textfile=${filterQuote(textFile)}:voice=${opts.voice ?? "slt"}`,
      "-ar",
      "48000",
      "-ac",
      "2",
      outPath,
    ],
    opts.signal ? { signal: opts.signal } : {},
  );
  await fs.promises.rm(textFile, { force: true });
  const info = await probeMedia(outPath);
  return { durationMs: info.durationMs, words: estimateWordTimings(opts.text, info.durationMs) };
}

/** Silent audio file (used by mock TTS when flite is unavailable). */
export async function generateSilence(
  outPath: string,
  durationSec: number,
  signal?: AbortSignal,
): Promise<void> {
  await ensureDir(outPath);
  await runFfmpeg(
    ["-f", "lavfi", "-t", fmt(durationSec), "-i", "anullsrc=r=48000:cl=stereo", outPath],
    signal ? { signal } : {},
  );
}

/** Short "whoosh" transition sound (filtered pink noise). */
export async function generateWhoosh(outPath: string, signal?: AbortSignal): Promise<void> {
  await ensureDir(outPath);
  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=0.45:c=pink:r=48000:a=0.4",
      "-af",
      "highpass=f=350,lowpass=f=3800,afade=t=in:d=0.16,afade=t=out:st=0.2:d=0.25,volume=0.8",
      "-ac",
      "2",
      outPath,
    ],
    signal ? { signal } : {},
  );
}

/** Mock image-to-video: animate a still with camera motion (no AI, no cost). */
export async function generateMotionClip(
  outPath: string,
  opts: {
    imagePath: string;
    durationSec: number;
    width: number;
    height: number;
    fps: number;
    motion?: MotionType;
    signal?: AbortSignal;
  },
): Promise<void> {
  await ensureDir(outPath);
  await renderSceneToFile(
    {
      id: "motion",
      kind: "AI_SHOT",
      durationMs: Math.round(opts.durationSec * 1000),
      background: {
        type: "image",
        src: opts.imagePath,
        motion: { type: opts.motion ?? "kenburns", intensity: 0.2 },
        blur: 0,
        darken: 0,
      },
      layers: [],
      transitionIn: { type: "cut", durationMs: 0 },
      vignette: false,
    },
    {
      format: { aspect: "9:16", width: opts.width, height: opts.height, fps: opts.fps },
      resolveSrc: (s) => s,
      cacheDir: path.dirname(outPath),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    outPath,
  );
}

/**
 * Cheap background removal for product photos shot on white/plain backgrounds (colour key).
 * Real AI background removal is a provider (BackgroundRemovalProvider); this is the free fallback.
 */
export async function colorKeyCutout(
  inputPath: string,
  outPath: string,
  opts: { color?: string; similarity?: number; blend?: number; signal?: AbortSignal } = {},
): Promise<void> {
  await ensureDir(outPath);
  const info = await probeMedia(inputPath);
  // PNGs that already carry transparency are kept as-is.
  if (info.pixFmt && /a$|^pal8|rgba|ya8|yuva/.test(info.pixFmt)) {
    await fs.promises.copyFile(inputPath, outPath);
    return;
  }
  await runFfmpeg(
    [
      "-i",
      inputPath,
      "-vf",
      `format=rgba,colorkey=${ffColor(opts.color ?? "#FFFFFF")}:${opts.similarity ?? 0.12}:${opts.blend ?? 0.08}`,
      "-frames:v",
      "1",
      outPath,
    ],
    opts.signal ? { signal: opts.signal } : {},
  );
}

/** Convert/resize any image to a target size (cover crop) — e.g. normalising downloaded product photos. */
export async function normalizeImage(
  inputPath: string,
  outPath: string,
  opts: { maxWidth: number; maxHeight: number; signal?: AbortSignal },
): Promise<void> {
  await ensureDir(outPath);
  await runFfmpeg(
    [
      "-i",
      inputPath,
      "-vf",
      `scale=${opts.maxWidth}:${opts.maxHeight}:force_original_aspect_ratio=decrease:flags=lanczos`,
      "-frames:v",
      "1",
      outPath,
    ],
    opts.signal ? { signal: opts.signal } : {},
  );
}
