import fs from "node:fs";
import path from "node:path";
import { buildAssDocument, shapeEvent, textOverlayEvent } from "./ass.ts";
import { filterQuote, getFfmpegConfig, probeMedia, runFfmpeg, type MediaInfo } from "./ffmpeg.ts";
import { buildSceneGraph } from "./scene.ts";
import { StillProject, type Scene } from "./schema.ts";

/**
 * Static post / carousel slide rendering: the same scene primitives (background, layers, typography)
 * composed into a single frame.
 */
export async function renderStill(
  input: StillProject,
  opts: { resolveSrc: (src: string) => string; workDir: string; outputPath: string; signal?: AbortSignal },
): Promise<{ outputPath: string; info: MediaInfo }> {
  const still = StillProject.parse(input);
  await fs.promises.mkdir(opts.workDir, { recursive: true });
  await fs.promises.mkdir(path.dirname(opts.outputPath), { recursive: true });

  const background =
    still.background.type === "image"
      ? { ...still.background, motion: { type: "static" as const, intensity: 0 } }
      : still.background;
  const scene: Scene = {
    id: "still",
    kind: "STILL",
    durationMs: Math.ceil(1000 / still.format.fps) + 1,
    background,
    layers: still.layers.map((l) => ({ ...l, enter: "none" as const, float: false, driftX: 0 })),
    transitionIn: { type: "cut", durationMs: 0 },
    vignette: false,
  };
  const graph = await buildSceneGraph(scene, {
    format: still.format,
    resolveSrc: opts.resolveSrc,
    cacheDir: opts.workDir,
    oversample: 1,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const assPath = path.join(opts.workDir, "still.ass");
  const events = [
    ...still.shapes.map((s) => shapeEvent({ ...s, animation: "none", startMs: 0, endMs: 10_000 })),
    ...still.texts.map((t) => textOverlayEvent({ ...t, animation: "none", startMs: 0, endMs: 10_000 })),
  ];
  await fs.promises.writeFile(
    assPath,
    buildAssDocument({
      width: still.format.width,
      height: still.format.height,
      styles: [
        { name: "Heading", font: still.brand.headingFont, size: 64, bold: true },
        { name: "Body", font: still.brand.bodyFont, size: 48, bold: false },
      ],
      events,
    }),
    "utf8",
  );
  const fontsDir = getFfmpegConfig().fontsDir;
  const fontsOpt = fontsDir ? `:fontsdir=${filterQuote(fontsDir)}` : "";
  const isPng = still.output.format === "png";
  await runFfmpeg(
    [
      ...graph.inputs.flat(),
      "-filter_complex",
      `${graph.filter};[${graph.outLabel}]ass=filename=${filterQuote(assPath)}${fontsOpt}${isPng ? "" : ",format=yuvj420p"}[out]`,
      "-map",
      "[out]",
      "-frames:v",
      "1",
      ...(isPng ? [] : ["-q:v", String(still.output.quality)]),
      opts.outputPath,
    ],
    opts.signal ? { signal: opts.signal } : {},
  );
  return { outputPath: opts.outputPath, info: await probeMedia(opts.outputPath) };
}
