import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STYLE_KITS, type MediaRef, type Palette, type RenderPlan } from "@cre/creative";
import { fontAssets, type FontFile } from "@cre/creative/node";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";

/**
 * Local render driver (spec §21): bundles the Remotion compositions once (cached by source hash), serves the
 * measured font files from the bundle's public dir and renders reels / review stills with a local headless
 * Chromium. No network, no paid service — the only cost is local CPU time.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const ENTRY = path.join(HERE, "remotion/index.tsx");
const SOURCE_DIRS = [path.join(HERE, "remotion"), path.resolve(HERE, "../../creative/src")];

export interface RenderEnvOptions {
  /** cache directory for bundles (default <repo>/.data/cache/remotion) */
  cacheDir?: string;
  browserExecutable?: string;
  /** parallel browser tabs (default: CPUs, max 6) */
  concurrency?: number;
}

export interface RenderEnv {
  serveUrl: string;
  browserExecutable: string | null;
  concurrency: number;
  bundleMs: number;
  bundleCached: boolean;
}

/** Local Chromium: $REMOTION_BROWSER_EXECUTABLE, else a Playwright headless shell, else Remotion's own download. */
export function detectBrowserExecutable(): string | null {
  const explicit = process.env.REMOTION_BROWSER_EXECUTABLE;
  if (explicit) return explicit;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  try {
    for (const dir of fs.readdirSync(base).sort().reverse()) {
      if (!dir.startsWith("chromium_headless_shell-")) continue;
      const exe = path.join(base, dir, "chrome-linux", "headless_shell");
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    /* not installed */
  }
  return null;
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|json)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
}

/** All font files any style kit can use (+ the UI face), so one bundle serves every creative. */
function allFontFiles(): FontFile[] {
  const byFile = new Map<string, FontFile>();
  for (const kit of Object.values(STYLE_KITS))
    for (const f of fontAssets(kit.tokens).files) byFile.set(f.file, f);
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

let envPromise: Promise<RenderEnv> | null = null;

export function getRenderEnv(opts: RenderEnvOptions = {}): Promise<RenderEnv> {
  envPromise ??= createRenderEnv(opts);
  return envPromise;
}

async function createRenderEnv(opts: RenderEnvOptions): Promise<RenderEnv> {
  const cacheDir = opts.cacheDir ?? path.join(REPO_ROOT, ".data/cache/remotion");
  const files: string[] = [];
  for (const d of SOURCE_DIRS) walk(d, files);
  files.sort();
  const fonts = allFontFiles();
  const h = createHash("sha256");
  for (const f of files) h.update(f.slice(REPO_ROOT.length)).update(fs.readFileSync(f));
  for (const f of fonts) h.update(f.file);
  h.update(
    JSON.stringify(
      Object.keys(JSON.parse(fs.readFileSync(path.join(HERE, "../package.json"), "utf8")) as object),
    ),
  );
  const key = h.digest("hex").slice(0, 16);
  const outDir = path.join(cacheDir, `bundle-${key}`);
  const started = Date.now();
  let cached = true;
  if (!fs.existsSync(path.join(outDir, "index.html"))) {
    cached = false;
    const publicDir = path.join(cacheDir, `public-${key}`);
    fs.mkdirSync(path.join(publicDir, "fonts"), { recursive: true });
    for (const f of fonts) fs.copyFileSync(f.path, path.join(publicDir, "fonts", f.file));
    await bundle({ entryPoint: ENTRY, outDir, publicDir, enableCaching: true });
  }
  const cpus = (await import("node:os")).availableParallelism();
  return {
    serveUrl: outDir,
    browserExecutable: opts.browserExecutable ?? detectBrowserExecutable(),
    concurrency: opts.concurrency ?? Math.max(1, Math.min(6, cpus)),
    bundleMs: Date.now() - started,
    bundleCached: cached,
  };
}

export interface ReelRenderResult {
  file: string;
  frames: number;
  renderMs: number;
  /** frames per second of wall-clock render throughput */
  fps: number;
}

/** Render the silent master video (H.264, yuv420p). Audio is mixed and muxed afterwards (finish.ts). */
export async function renderReelVideo(
  plan: RenderPlan,
  outFile: string,
  opts: RenderEnvOptions & { crf?: number; onProgress?: (p: number) => void } = {},
): Promise<ReelRenderResult> {
  const env = await getRenderEnv(opts);
  const inputProps = { plan };
  const common = {
    serveUrl: env.serveUrl,
    inputProps,
    logLevel: "error" as const,
    ...(env.browserExecutable ? { browserExecutable: env.browserExecutable } : {}),
  };
  const composition = await selectComposition({ ...common, id: "CreativeReel" });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const started = Date.now();
  await renderMedia({
    ...common,
    composition,
    codec: "h264",
    outputLocation: outFile,
    muted: true,
    crf: opts.crf ?? 17,
    x264Preset: "medium",
    pixelFormat: "yuv420p",
    colorSpace: "bt709",
    imageFormat: "jpeg",
    jpegQuality: 94,
    concurrency: env.concurrency,
    overwrite: true,
    onProgress: ({ progress }) => opts.onProgress?.(progress),
  });
  const renderMs = Date.now() - started;
  return {
    file: outFile,
    frames: composition.durationInFrames,
    renderMs,
    fps: composition.durationInFrames / (renderMs / 1000),
  };
}

/** Review stills (JPEG) at the given frames — one browser for all of them. */
export async function renderReelStills(
  plan: RenderPlan,
  frames: number[],
  outDir: string,
  opts: RenderEnvOptions = {},
): Promise<string[]> {
  const env = await getRenderEnv(opts);
  const browser = await openBrowser("chrome", {
    ...(env.browserExecutable ? { browserExecutable: env.browserExecutable } : {}),
    logLevel: "error",
  });
  try {
    const inputProps = { plan };
    const composition = await selectComposition({
      serveUrl: env.serveUrl,
      id: "CreativeReel",
      inputProps,
      puppeteerInstance: browser,
      logLevel: "error",
    });
    fs.mkdirSync(outDir, { recursive: true });
    const out: string[] = [];
    for (const frame of frames) {
      const f = Math.max(0, Math.min(composition.durationInFrames - 1, frame));
      const file = path.join(outDir, `${plan.storyboardId}-f${String(f).padStart(4, "0")}.jpg`);
      await renderStill({
        composition,
        serveUrl: env.serveUrl,
        output: file,
        frame: f,
        inputProps,
        imageFormat: "jpeg",
        jpegQuality: 88,
        puppeteerInstance: browser,
        logLevel: "error",
        overwrite: true,
      });
      out.push(file);
    }
    return out;
  } finally {
    await browser.close({ silent: true });
  }
}

/** Review sheet of one illustration with its anchors (keeps callout targets aligned with the drawing). */
export async function renderMediaSheets(
  items: { media: MediaRef; palette: Palette; fonts: RenderPlan["fonts"]; frame?: number }[],
  outDir: string,
  opts: RenderEnvOptions = {},
): Promise<string[]> {
  const env = await getRenderEnv(opts);
  const browser = await openBrowser("chrome", {
    ...(env.browserExecutable ? { browserExecutable: env.browserExecutable } : {}),
    logLevel: "error",
  });
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const out: string[] = [];
    for (const it of items) {
      const inputProps = { media: it.media, palette: it.palette, showAnchors: true, fonts: it.fonts };
      const composition = await selectComposition({
        serveUrl: env.serveUrl,
        id: "MediaSheet",
        inputProps,
        puppeteerInstance: browser,
        logLevel: "error",
      });
      const file = path.join(outDir, `sheet-${it.media.id}.jpg`);
      await renderStill({
        composition,
        serveUrl: env.serveUrl,
        output: file,
        frame: it.frame ?? 0,
        inputProps,
        imageFormat: "jpeg",
        jpegQuality: 88,
        puppeteerInstance: browser,
        logLevel: "error",
        overwrite: true,
      });
      out.push(file);
    }
    return out;
  } finally {
    await browser.close({ silent: true });
  }
}
