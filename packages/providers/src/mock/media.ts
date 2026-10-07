import fs from "node:fs";
import path from "node:path";
import {
  bgRemovalCostMicros,
  imageCostMicros,
  MOCK_SIMULATES,
  ttsCostMicros,
  videoCostMicros,
  type ModelCatalog,
} from "@cre/config";
import {
  colorKeyCutout,
  estimateWordTimings,
  generateGradientImage,
  generateMotionClip,
  generateMusicBed,
  generateSilence,
  generateSpeech,
  mixHex,
  probeMedia,
} from "@cre/media";
import { seededRandom, sha256Hex, truncate } from "@cre/shared";
import type {
  BackgroundRemovalProvider,
  BgRemovalRequest,
  BgRemovalResult,
  CostEstimate,
  ExecContext,
  ImageProvider,
  ImageRequest,
  ImageResult,
  MusicProvider,
  MusicRequest,
  MusicResult,
  ProviderHealth,
  TTSProvider,
  TTSRequest,
  TTSResult,
  VideoGenerationProvider,
  VideoRequest,
  VideoResult,
} from "../types.ts";

/**
 * Mock media providers (MOCK_MEDIA=true): real files produced locally by FFmpeg, zero spend.
 * In MOCK_COST_MODE=simulate the estimate equals what the real provider would charge, so budgets,
 * dashboards and the router behave exactly as in production.
 */
export interface MockOptions {
  costMode: "simulate" | "zero";
  models: ModelCatalog;
}

function health(kind: ProviderHealth["kind"]): Promise<ProviderHealth> {
  return Promise.resolve({
    ok: true,
    provider: "mock",
    kind,
    isMock: true,
    message: "mock provider (no external calls)",
  });
}

const BRIGHT_PALETTES: [string, string][] = [
  ["#6A9BC3", "#2E4A7A"],
  ["#E8A15C", "#8A4B2C"],
  ["#7FB89A", "#2F5D4A"],
  ["#C98BB9", "#5B2E63"],
  ["#D9C27A", "#6B5A2A"],
];

export class MockImageProvider implements ImageProvider {
  readonly name = "mock";
  readonly kind = "image" as const;
  readonly isMock = true;

  constructor(private readonly opts: MockOptions) {}

  healthCheck() {
    return health("image");
  }

  estimateCost(req: ImageRequest): CostEstimate {
    const model = req.model ?? this.opts.models.image[req.modelClass];
    return {
      provider: this.name,
      model: `mock:${model}`,
      operation: "IMAGE_GENERATION",
      estimatedMicros:
        this.opts.costMode === "zero" ? 0 : imageCostMicros(MOCK_SIMULATES.image.provider, model, req),
      units: { images: 1 },
      isMock: true,
    };
  }

  async execute(req: ImageRequest, ctx: ExecContext): Promise<ImageResult> {
    const seed = req.seed ?? parseInt(sha256Hex(req.prompt).slice(0, 8), 16);
    const rnd = seededRandom(String(seed));
    const palette =
      req.paletteHint !== undefined
        ? ([mixHex(req.paletteHint[0], "#FFFFFF", 0.15), mixHex(req.paletteHint[1], "#000000", 0.1)] as [
            string,
            string,
          ])
        : BRIGHT_PALETTES[Math.floor(rnd() * BRIGHT_PALETTES.length)]!;
    const filePath = path.join(ctx.workDir, `mock-image-${seed}.png`);
    await generateGradientImage(filePath, {
      width: req.width,
      height: req.height,
      colors: palette,
      seed: String(seed),
      label: `MOCK IMAGE · ${truncate(req.prompt, 70)}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return {
      filePath,
      mimeType: "image/png",
      model: `mock:${req.model ?? this.opts.models.image[req.modelClass]}`,
      width: req.width,
      height: req.height,
      seed,
      license: "mock-generated",
    };
  }
}

export class MockVideoProvider implements VideoGenerationProvider {
  readonly name = "mock";
  readonly kind = "video" as const;
  readonly isMock = true;

  constructor(private readonly opts: MockOptions) {}

  healthCheck() {
    return health("video");
  }

  estimateCost(req: VideoRequest): CostEstimate {
    const model = req.model ?? this.opts.models.video[req.modelClass];
    return {
      provider: this.name,
      model: `mock:${model}`,
      operation: "VIDEO_GENERATION",
      estimatedMicros:
        this.opts.costMode === "zero"
          ? 0
          : videoCostMicros(MOCK_SIMULATES.video.provider, model, { seconds: req.durationSec }),
      units: { videoSeconds: req.durationSec },
      isMock: true,
      isAiVideo: true,
    };
  }

  async execute(req: VideoRequest, ctx: ExecContext): Promise<VideoResult> {
    const filePath = path.join(
      ctx.workDir,
      `mock-video-${sha256Hex(req.imagePath + req.prompt).slice(0, 12)}.mp4`,
    );
    await generateMotionClip(filePath, {
      imagePath: req.imagePath,
      durationSec: req.durationSec,
      width: req.width,
      height: req.height,
      fps: req.fps,
      motion: "kenburns",
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const info = await probeMedia(filePath);
    return {
      filePath,
      mimeType: "video/mp4",
      model: `mock:${req.model ?? this.opts.models.video[req.modelClass]}`,
      durationMs: info.durationMs,
      width: info.width ?? req.width,
      height: info.height ?? req.height,
      license: "mock-generated",
    };
  }
}

let fliteAvailable: boolean | undefined;

async function hasFlite(workDir: string): Promise<boolean> {
  if (fliteAvailable !== undefined) return fliteAvailable;
  try {
    await generateSpeech(path.join(workDir, "flite-probe.wav"), { text: "ok" });
    fliteAvailable = true;
  } catch {
    fliteAvailable = false;
  }
  return fliteAvailable;
}

/**
 * Local speech via FFmpeg flite. Used as the mock TTS (valued at the simulated provider price) and as a
 * genuinely free real provider ("flite") for budget-zero brands.
 */
export class LocalSpeechProvider implements TTSProvider {
  readonly kind = "tts" as const;
  readonly name: string;
  readonly isMock: boolean;

  constructor(private readonly opts: MockOptions & { mode: "mock" | "flite" }) {
    this.name = opts.mode;
    this.isMock = opts.mode === "mock";
  }

  healthCheck() {
    return Promise.resolve({
      ok: true,
      provider: this.name,
      kind: "tts" as const,
      isMock: this.isMock,
      message: "local FFmpeg flite speech",
    });
  }

  estimateCost(req: TTSRequest): CostEstimate {
    const simulated =
      this.isMock && this.opts.costMode === "simulate"
        ? ttsCostMicros(MOCK_SIMULATES.tts.provider, MOCK_SIMULATES.tts.model, {
            characters: req.text.length,
          })
        : 0;
    return {
      provider: this.name,
      model: this.isMock ? `mock:${MOCK_SIMULATES.tts.model}` : "flite",
      operation: "TTS",
      estimatedMicros: simulated,
      units: { characters: req.text.length },
      isMock: this.isMock,
    };
  }

  async execute(req: TTSRequest, ctx: ExecContext): Promise<TTSResult> {
    await fs.promises.mkdir(ctx.workDir, { recursive: true });
    const filePath = path.join(ctx.workDir, `speech-${sha256Hex(req.text).slice(0, 12)}.wav`);
    const voice = req.voice && ["kal", "slt", "awb", "rms"].includes(req.voice) ? req.voice : "slt";
    let durationMs: number;
    let words;
    if (await hasFlite(ctx.workDir)) {
      const res = await generateSpeech(filePath, {
        text: req.text,
        voice,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      durationMs = res.durationMs;
      words = res.words;
    } else {
      // ~150 words per minute of silence keeps timings realistic when flite is unavailable
      const wordCount = req.text.split(/\s+/).filter(Boolean).length;
      durationMs = Math.max(1000, Math.round((wordCount / 150) * 60_000));
      await generateSilence(filePath, durationMs / 1000, ctx.signal);
      words = estimateWordTimings(req.text, durationMs);
    }
    return {
      filePath,
      mimeType: "audio/wav",
      model: this.isMock ? `mock:${MOCK_SIMULATES.tts.model}` : "flite",
      durationMs,
      words,
      timingsExact: false,
      characters: req.text.length,
      voice,
      license: this.isMock ? "mock-generated" : "flite (local synthesis)",
    };
  }
}

export class MockBackgroundRemovalProvider implements BackgroundRemovalProvider {
  readonly name = "mock";
  readonly kind = "bg_removal" as const;
  readonly isMock = true;

  constructor(private readonly opts: MockOptions) {}

  healthCheck() {
    return health("bg_removal");
  }

  estimateCost(): CostEstimate {
    return {
      provider: this.name,
      model: `mock:${MOCK_SIMULATES.bgRemoval.model}`,
      operation: "BACKGROUND_REMOVAL",
      estimatedMicros:
        this.opts.costMode === "zero"
          ? 0
          : bgRemovalCostMicros(MOCK_SIMULATES.bgRemoval.provider, MOCK_SIMULATES.bgRemoval.model),
      units: { images: 1 },
      isMock: true,
    };
  }

  async execute(req: BgRemovalRequest, ctx: ExecContext): Promise<BgRemovalResult> {
    const filePath = path.join(ctx.workDir, `cutout-${sha256Hex(req.imagePath).slice(0, 12)}.png`);
    await colorKeyCutout(req.imagePath, filePath, ctx.signal ? { signal: ctx.signal } : {});
    return {
      filePath,
      mimeType: "image/png",
      model: `mock:${MOCK_SIMULATES.bgRemoval.model}`,
      license: "derived",
    };
  }
}

/** Procedural royalty-free music beds — a real, free provider (no licensing risk). */
export class ProceduralMusicProvider implements MusicProvider {
  readonly name = "procedural";
  readonly kind = "music" as const;
  readonly isMock = false;

  healthCheck() {
    return Promise.resolve({ ok: true, provider: this.name, kind: "music" as const, isMock: false });
  }

  estimateCost(req: MusicRequest): CostEstimate {
    return {
      provider: this.name,
      model: "procedural-v1",
      operation: "OTHER",
      estimatedMicros: 0,
      units: { audioSeconds: req.durationSec },
      isMock: false,
    };
  }

  async execute(req: MusicRequest, ctx: ExecContext): Promise<MusicResult> {
    const filePath = path.join(ctx.workDir, `music-${req.mood}-${sha256Hex(req.seed).slice(0, 10)}.wav`);
    await generateMusicBed(filePath, {
      durationSec: req.durationSec,
      seed: req.seed,
      mood: req.mood,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return {
      filePath,
      mimeType: "audio/wav",
      model: "procedural-v1",
      durationMs: Math.round(req.durationSec * 1000),
      license: "procedural (generated, royalty-free)",
    };
  }
}
