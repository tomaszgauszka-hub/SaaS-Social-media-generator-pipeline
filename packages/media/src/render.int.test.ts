import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderVideoProject } from "./compositor.ts";
import { probeMedia } from "./ffmpeg.ts";
import {
  colorKeyCutout,
  generateGradientImage,
  generateMusicBed,
  generateProductPackshot,
  generateSpeech,
  generateWhoosh,
} from "./generators.ts";
import { inspectVideo } from "./inspect.ts";
import { layoutStoryboard, type Storyboard } from "./layout.ts";
import { renderStill } from "./still.ts";

/** Real FFmpeg renders at low resolution (fast) — proves the full compositor path works. */
let dir: string;
const W = 360;
const H = 640;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cre-media-"));
  await generateGradientImage(path.join(dir, "bg.png"), {
    width: W,
    height: H,
    colors: ["#6A9BC3", "#3D6E96"],
    seed: "x",
    label: "MOCK",
  });
  await generateProductPackshot(path.join(dir, "product.png"), {
    title: "Test Product",
    primary: "#E8547A",
    accent: "#7A2E8E",
  });
  await generateMusicBed(path.join(dir, "music.wav"), { durationSec: 6, seed: "m" });
  await generateWhoosh(path.join(dir, "whoosh.wav"));
});

afterAll(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

function storyboard(
  withVoice: { src: string; words: { text: string; startMs: number; endMs: number }[] } | null,
): Storyboard {
  return {
    templateKey: "vertical-bold",
    format: { aspect: "9:16", width: W, height: H, fps: 15 },
    safeArea: { top: 220, bottom: 440, left: 70, right: 150 },
    brand: {
      name: "Test",
      primary: "#E8547A",
      secondary: "#FFE4EC",
      accent: "#7A2E8E",
      text: "#1F1A24",
      background: "#FFF7FA",
      headingFont: "Inter",
      bodyFont: "Inter",
    },
    scenes: [
      {
        id: "a",
        kind: "HOOK",
        durationMs: 1500,
        headline: "Hook *text*",
        visual: { type: "image", src: path.join(dir, "bg.png"), motion: "zoom_in" },
      },
      {
        id: "b",
        kind: "PRODUCT",
        durationMs: 2000,
        headline: "The product",
        visual: { type: "product", productSrc: path.join(dir, "product.png") },
      },
      { id: "c", kind: "CTA", durationMs: 1500, visual: { type: "card" } },
    ],
    cta: { headline: "Link in *bio*", button: "Shop now" },
    disclosure: { text: "#ad" },
    productLabel: "Test Product",
    ...(withVoice ? { subtitles: { words: withVoice.words } } : {}),
    audio: {
      musicSrc: path.join(dir, "music.wav"),
      transitionSfxSrc: path.join(dir, "whoosh.wav"),
      ...(withVoice ? { voiceover: { src: withVoice.src, startMs: 200 } } : {}),
    },
    progressBar: true,
    output: { crf: 28, preset: "ultrafast" },
  };
}

describe("FFmpeg compositor (real render)", () => {
  it("renders a vertical video with audio, transitions, text and a cover image", async () => {
    const speech = await generateSpeech(path.join(dir, "vo.wav"), {
      text: "Hook text. This is the product. Link in bio.",
    });
    const project = layoutStoryboard(storyboard({ src: path.join(dir, "vo.wav"), words: speech.words }));
    const result = await renderVideoProject(project, {
      resolveSrc: (s) => s,
      workDir: path.join(dir, "work"),
      cacheDir: path.join(dir, "cache"),
      outputPath: path.join(dir, "out.mp4"),
      coverPath: path.join(dir, "cover.jpg"),
      preset: "ultrafast",
    });
    expect(result.info.width).toBe(W);
    expect(result.info.height).toBe(H);
    expect(result.info.videoCodec).toBe("h264");
    expect(result.info.pixFmt).toBe("yuv420p");
    expect(result.info.hasAudio).toBe(true);
    expect(result.info.audioSampleRate).toBe(48000);
    // 1.5 + 2 + 1.5 minus two transitions (40% clamp of 1.5s scenes → ≤ 280ms each)
    expect(Math.abs(result.durationMs - result.timeline.totalMs)).toBeLessThan(150);
    expect(fs.existsSync(path.join(dir, "cover.jpg"))).toBe(true);
    expect(result.scenes.every((s) => !s.cached)).toBe(true);

    const inspection = await inspectVideo(result.outputPath);
    expect(inspection.blackSegments).toEqual([]);
    expect(inspection.integratedLufs).not.toBeNull();
  });

  it("reuses cached scene clips when only text/audio changes (cheap hook edits)", async () => {
    const sb = storyboard(null);
    sb.scenes[0]!.headline = "A different *hook*";
    const result = await renderVideoProject(layoutStoryboard(sb), {
      resolveSrc: (s) => s,
      workDir: path.join(dir, "work2"),
      cacheDir: path.join(dir, "cache"),
      outputPath: path.join(dir, "out2.mp4"),
      preset: "ultrafast",
    });
    expect(result.scenes.every((s) => s.cached)).toBe(true);
    expect(result.info.hasAudio).toBe(true);
  });

  it("renders static posts and colour-key cutouts", async () => {
    const still = await renderStill(
      {
        version: 1,
        format: { aspect: "4:5", width: 540, height: 675, fps: 30 },
        safeArea: { top: 30, bottom: 30, left: 30, right: 30 },
        brand: storyboard(null).brand,
        background: { type: "gradient", colors: ["#E8547A", "#7A2E8E"], animated: false },
        layers: [
          {
            type: "image",
            src: path.join(dir, "product.png"),
            x: 270,
            y: 330,
            width: 300,
            height: 360,
            enter: "none",
            enterAtMs: 0,
            enterDurationMs: 0,
            float: false,
            shadow: true,
            driftX: 0,
          },
        ],
        texts: [
          {
            id: "t",
            text: "Static post",
            style: "headline",
            x: 270,
            y: 80,
            align: "center",
            maxWidth: 480,
            fontSize: 40,
            color: "#FFFFFF",
            accentColor: "#FFFFFF",
            outlineColor: "#000000",
            outline: 3,
            shadow: 0,
            bold: true,
            uppercase: true,
            animation: "fade",
            startMs: 0,
            endMs: 1000,
            layer: 2,
          },
        ],
        shapes: [],
        output: { format: "jpg", quality: 3 },
      },
      { resolveSrc: (s) => s, workDir: path.join(dir, "still"), outputPath: path.join(dir, "still.jpg") },
    );
    expect(still.info.width).toBe(540);
    expect(still.info.height).toBe(675);

    await colorKeyCutout(path.join(dir, "bg.png"), path.join(dir, "cut.png"));
    const cut = await probeMedia(path.join(dir, "cut.png"));
    expect(cut.pixFmt).toMatch(/rgba|ya8|pal8/);
  });
});
