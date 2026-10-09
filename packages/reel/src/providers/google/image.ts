import fsp from "node:fs/promises";
import path from "node:path";
import type { Env } from "@cre/config";
import { extensionForMime, type GoogleAI } from "@cre/providers";
import { FatalError } from "@cre/shared";
import type {
  CallContext,
  ImageGenProvider,
  ImageGenRequest,
  ImagePurpose,
} from "../../capabilities/types.ts";
import { cacheKey, fileSha256 } from "../../util/cache.ts";
import { cachedCall, paid, recordCall } from "./common.ts";

/*
 * Gemini image generation for background plates, storyboards and stylised elements ONLY. Google gives no
 * guarantee that an image model keeps a real product unchanged, so every prompt starts with an instruction
 * never to depict, redraw or alter the product (or any logo / label / text); the real product is composited
 * from its own photos or the Blender render. Any purpose outside the four ImagePurpose values is refused.
 */

export const GEMINI_IMAGE_VERSION = "gemini-image/1";
const NS = "google.image";

export const PRODUCT_GUARD =
  "STRICT RULE: do not depict, draw, redraw, recreate or alter the product itself — or any product, " +
  "packaging, logo, label, brand mark or text. The real product is composited later from its own photos, so " +
  "leave a clean, empty, well-lit area for it. Reference images, if any, only define style, palette, " +
  "materials and lighting; never copy objects from them.";

const PURPOSE_INSTRUCTION: Record<ImagePurpose, string> = {
  background_plate:
    "Create an empty photographic background plate for a product shot: environment only, nothing in the " +
    "foreground centre, a natural surface in the lower middle where the product will stand, in focus.",
  storyboard:
    "Create a simple storyboard frame (rough sketch style) showing composition and camera framing only; " +
    "any product appears as a plain neutral placeholder shape, never its real design.",
  graphic_element:
    "Create a stylised abstract graphic element (shapes, light streaks, textures) on a plain background, " +
    "with no text, no logos and no product.",
  scene_reference:
    "Create a mood reference of the environment and lighting only, with no product, no text and no logos.",
};

export function isImagePurpose(purpose: unknown): purpose is ImagePurpose {
  return typeof purpose === "string" && Object.hasOwn(PURPOSE_INSTRUCTION, purpose);
}

export function buildImagePrompt(req: Pick<ImageGenRequest, "purpose" | "prompt">): string {
  if (!isImagePurpose(req.purpose)) {
    throw new FatalError(`image generation refused: purpose ${JSON.stringify(req.purpose)} is not allowed`);
  }
  return `${PRODUCT_GUARD}\n\n${PURPOSE_INSTRUCTION[req.purpose]}\n\nScene: ${req.prompt.trim()}`;
}

interface ImageMeta {
  file: string;
  width: number;
  height: number;
}

export class GoogleImageProvider implements ImageGenProvider {
  readonly name = "gemini-image";
  readonly capability = "image" as const;
  readonly local = false;
  readonly model: string;
  private readonly imageSize: "1K" | "2K" | "4K";

  constructor(
    env: Pick<Env, "GOOGLE_IMAGE_MODEL">,
    private readonly ai: GoogleAI,
    /** 2K (1536×2752 at 9:16) covers a 1080×1920 reel; 1K is cheaper */
    opts: { imageSize?: "1K" | "2K" | "4K" } = {},
  ) {
    this.model = env.GOOGLE_IMAGE_MODEL;
    this.imageSize = opts.imageSize ?? "2K";
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve(
      this.ai.hasApiKey ? { ok: true } : { ok: false, reason: "GOOGLE_API_KEY is not configured" },
    );
  }

  estimateMicros(req: ImageGenRequest): number {
    return this.ai.estimateImageMicros(this.model, this.imageSize, req.references?.length ?? 0);
  }

  async generate(
    req: ImageGenRequest,
    ctx: CallContext,
  ): Promise<{ path: string; width: number; height: number; cached: boolean }> {
    const prompt = buildImagePrompt(req);
    const refs = req.references ?? [];
    const referenceShas = await Promise.all(refs.map((r) => fileSha256(r)));
    const key = cacheKey(NS, GEMINI_IMAGE_VERSION, {
      model: this.model,
      purpose: req.purpose,
      prompt,
      aspect: req.aspect,
      imageSize: this.imageSize,
      referenceShas,
      seed: req.seed,
    });
    const res = await cachedCall<ImageMeta>({
      ctx,
      namespace: NS,
      key,
      required: (meta) => [meta.file],
      capability: "image",
      model: this.model,
      hitUnits: { images: 1 },
      produce: async (dir) => {
        const image = await paid(ctx, "image", this.model, () =>
          this.ai.generateImage({
            model: this.model,
            prompt,
            references: refs,
            aspectRatio: req.aspect,
            imageSize: this.imageSize,
            label: `reel.image.${req.purpose}`,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        );
        recordCall(ctx, {
          capability: "image",
          model: this.model,
          costMicros: image.costMicros,
          estimated: image.costEstimated,
          usage: image.usage,
          units: { images: 1 },
          latencyMs: image.latencyMs,
        });
        const file = `image${extensionForMime(image.mimeType)}`;
        await fsp.writeFile(path.join(dir, file), image.bytes);
        return { file, width: image.width ?? 0, height: image.height ?? 0 };
      },
    });
    return {
      path: path.join(res.dir, res.meta.file),
      width: res.meta.width,
      height: res.meta.height,
      cached: res.cached,
    };
  }
}
