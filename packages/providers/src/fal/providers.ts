import path from "node:path";
import { bgRemovalCostMicros, imageCostMicros, videoCostMicros, type ModelCatalog } from "@cre/config";
import { probeMedia } from "@cre/media";
import { ProviderError, sha256Hex } from "@cre/shared";
import { downloadToFile, fileToDataUri } from "../http.ts";
import type {
  BackgroundRemovalProvider,
  BgRemovalRequest,
  BgRemovalResult,
  CostEstimate,
  ExecContext,
  ImageProvider,
  ImageRequest,
  ImageResult,
  ProviderHealth,
  VideoGenerationProvider,
  VideoRequest,
  VideoResult,
} from "../types.ts";
import { type FalClient } from "./client.ts";

function falHealth(client: FalClient, kind: ProviderHealth["kind"]): Promise<ProviderHealth> {
  return Promise.resolve(
    client.configured
      ? { ok: true, provider: "fal", kind, isMock: false, message: "FAL_KEY configured (no paid call made)" }
      : { ok: false, provider: "fal", kind, isMock: false, message: "FAL_KEY is not configured" },
  );
}

interface FalImageOutput {
  images?: { url: string; width?: number; height?: number; content_type?: string }[];
  seed?: number;
  has_nsfw_concepts?: boolean[];
}

/** FLUX text-to-image via fal.ai (schnell / dev / pro by model class). */
export class FalImageProvider implements ImageProvider {
  readonly name = "fal";
  readonly kind = "image" as const;
  readonly isMock = false;

  constructor(
    private readonly client: FalClient,
    private readonly models: ModelCatalog,
  ) {}

  healthCheck() {
    return falHealth(this.client, "image");
  }

  estimateCost(req: ImageRequest): CostEstimate {
    const model = req.model ?? this.models.image[req.modelClass];
    return {
      provider: this.name,
      model,
      operation: "IMAGE_GENERATION",
      estimatedMicros: imageCostMicros("fal", model, req),
      units: { images: 1 },
      isMock: false,
    };
  }

  async execute(req: ImageRequest, ctx: ExecContext): Promise<ImageResult> {
    const model = req.model ?? this.models.image[req.modelClass];
    const { output } = await this.client.run<FalImageOutput>(
      model,
      {
        prompt: req.prompt,
        image_size: { width: req.width, height: req.height },
        num_images: 1,
        enable_safety_checker: true,
        output_format: "jpeg",
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      },
      ctx,
      180_000,
    );
    const image = output.images?.[0];
    if (!image?.url)
      throw new ProviderError("fal", "no image in response", { retryable: true, charged: true });
    if (output.has_nsfw_concepts?.[0]) {
      throw new ProviderError("fal", "image flagged by safety checker", { retryable: false, charged: true });
    }
    const filePath = path.join(ctx.workDir, `fal-image-${sha256Hex(image.url).slice(0, 12)}.jpg`);
    await downloadToFile("fal", image.url, filePath, ctx.signal ? { signal: ctx.signal } : {});
    return {
      filePath,
      mimeType: image.content_type ?? "image/jpeg",
      model,
      width: image.width ?? req.width,
      height: image.height ?? req.height,
      ...(output.seed !== undefined ? { seed: output.seed } : {}),
      license: `generated:fal:${model}`,
      providerMeta: { sourceUrlHost: new URL(image.url).host },
    };
  }
}

interface FalSingleImageOutput {
  image?: { url: string; content_type?: string };
}

/** AI background removal (BiRefNet) — keeps real product pixels, removes the backdrop. */
export class FalBackgroundRemovalProvider implements BackgroundRemovalProvider {
  readonly name = "fal";
  readonly kind = "bg_removal" as const;
  readonly isMock = false;

  constructor(
    private readonly client: FalClient,
    private readonly model: string,
  ) {}

  healthCheck() {
    return falHealth(this.client, "bg_removal");
  }

  estimateCost(): CostEstimate {
    return {
      provider: this.name,
      model: this.model,
      operation: "BACKGROUND_REMOVAL",
      estimatedMicros: bgRemovalCostMicros("fal", this.model),
      units: { images: 1 },
      isMock: false,
    };
  }

  async execute(req: BgRemovalRequest, ctx: ExecContext): Promise<BgRemovalResult> {
    const imageUrl = req.imageUrl ?? (await fileToDataUri(req.imagePath, guessMime(req.imagePath)));
    const { output } = await this.client.run<FalSingleImageOutput>(
      this.model,
      { image_url: imageUrl, output_format: "png" },
      ctx,
      120_000,
    );
    if (!output.image?.url)
      throw new ProviderError("fal", "no image in response", { retryable: true, charged: true });
    const filePath = path.join(ctx.workDir, `cutout-${sha256Hex(output.image.url).slice(0, 12)}.png`);
    await downloadToFile("fal", output.image.url, filePath, ctx.signal ? { signal: ctx.signal } : {});
    return { filePath, mimeType: "image/png", model: this.model, license: "derived:background-removed" };
  }
}

interface FalVideoOutput {
  video?: { url: string; content_type?: string };
}

/** Image-to-video (Kling-compatible input) via fal.ai. Optional per scene; never required by the pipeline. */
export class FalVideoProvider implements VideoGenerationProvider {
  readonly name = "fal";
  readonly kind = "video" as const;
  readonly isMock = false;

  constructor(
    private readonly client: FalClient,
    private readonly models: ModelCatalog,
  ) {}

  healthCheck() {
    return falHealth(this.client, "video");
  }

  estimateCost(req: VideoRequest): CostEstimate {
    const model = req.model ?? this.models.video[req.modelClass];
    return {
      provider: this.name,
      model,
      operation: "VIDEO_GENERATION",
      estimatedMicros: videoCostMicros("fal", model, { seconds: req.durationSec }),
      units: { videoSeconds: Math.max(5, Math.ceil(req.durationSec)) },
      isMock: false,
      isAiVideo: true,
    };
  }

  async execute(req: VideoRequest, ctx: ExecContext): Promise<VideoResult> {
    const model = req.model ?? this.models.video[req.modelClass];
    const imageUrl = req.imageUrl ?? (await fileToDataUri(req.imagePath, guessMime(req.imagePath)));
    const { output } = await this.client.run<FalVideoOutput>(
      model,
      {
        prompt: req.prompt,
        image_url: imageUrl,
        duration: req.durationSec > 5 ? "10" : "5",
        aspect_ratio: req.width < req.height ? "9:16" : req.width === req.height ? "1:1" : "16:9",
        negative_prompt: "blur, distort, low quality, text, watermark, logo",
      },
      ctx,
      900_000,
    );
    if (!output.video?.url)
      throw new ProviderError("fal", "no video in response", { retryable: true, charged: true });
    const filePath = path.join(ctx.workDir, `fal-video-${sha256Hex(output.video.url).slice(0, 12)}.mp4`);
    await downloadToFile("fal", output.video.url, filePath, ctx.signal ? { signal: ctx.signal } : {});
    const info = await probeMedia(filePath);
    return {
      filePath,
      mimeType: "video/mp4",
      model,
      durationMs: info.durationMs,
      width: info.width ?? req.width,
      height: info.height ?? req.height,
      license: `generated:fal:${model}`,
    };
  }
}

function guessMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
}
