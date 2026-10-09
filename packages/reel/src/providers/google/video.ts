import fsp from "node:fs/promises";
import path from "node:path";
import type { Env } from "@cre/config";
import { extensionForMime, videoSurface, type GoogleAI } from "@cre/providers";
import { FatalError, ProviderError } from "@cre/shared";
import type {
  CallContext,
  GenerativeVideoProvider,
  GenerativeVideoRequest,
} from "../../capabilities/types.ts";
import { FileCache, cacheKey, fileSha256 } from "../../util/cache.ts";
import { cachedCall, numericSeed, paid, recordCall, trimClip } from "./common.ts";

/*
 * Veo — the LAST resort of the factory (off unless GENERATIVE_VIDEO_ENABLED and REEL_MAX_GENERATIVE_VIDEO_SECONDS
 * > 0; the tier and the job budget gate it again). Veo generates ≥ 4 s; the clip is trimmed to the requested
 * length and its audio dropped. The long-running operation name is persisted in the cache entry before
 * polling, so a crashed worker resumes the same (already paid) generation instead of starting a second one.
 */

export const VEO_VERSION = "veo/1";
const NS = "google.veo";

/** Animate camera / light / environment only — never redesign the product in the first frame. */
export function veoPrompt(req: Pick<GenerativeVideoRequest, "prompt" | "firstFramePath">): string {
  const guard = req.firstFramePath
    ? "Animate ONLY the camera, the light and the environment. The product in the first frame must stay exactly " +
      "as it is — same shape, proportions, colours, materials, logo, buttons and text; do not add, remove or " +
      "redesign any part of it. No new text, captions, logos or people."
    : "Show only environment, light and abstract motion — no product, no packaging, no logos, no text, no people.";
  return `${guard}\n\nShot: ${req.prompt.trim()}`;
}

export const VEO_NEGATIVE_PROMPT =
  "altered product, changed logo, extra buttons, distorted shape, different colour, warped text, captions, " +
  "watermark, people, hands";

interface VeoMeta {
  durationMs: number;
  operationName?: string;
}

export class GoogleVeoProvider implements GenerativeVideoProvider {
  readonly name = "veo";
  readonly capability = "generative_video" as const;
  readonly local = false;
  readonly model: string;
  private readonly enabled: boolean;
  private readonly maxSeconds: number;

  constructor(
    env: Pick<Env, "GOOGLE_VIDEO_MODEL" | "GENERATIVE_VIDEO_ENABLED" | "REEL_MAX_GENERATIVE_VIDEO_SECONDS">,
    private readonly ai: GoogleAI,
  ) {
    this.model = env.GOOGLE_VIDEO_MODEL;
    this.enabled = env.GENERATIVE_VIDEO_ENABLED;
    this.maxSeconds = env.REEL_MAX_GENERATIVE_VIDEO_SECONDS;
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    const no = (reason: string) => Promise.resolve({ ok: false, reason });
    if (!this.enabled) return no("GENERATIVE_VIDEO_ENABLED=false");
    if (this.maxSeconds <= 0) return no("REEL_MAX_GENERATIVE_VIDEO_SECONDS=0");
    if (videoSurface(this.model) === "agent_platform") {
      if (!this.ai.hasCloudToken)
        return no("GOOGLE_CLOUD_ACCESS_TOKEN is not configured (Agent Platform Veo)");
      if (!this.ai.hasCloudProject) return no("GOOGLE_CLOUD_PROJECT is not configured (Agent Platform Veo)");
    } else if (!this.ai.hasApiKey) {
      return no("GOOGLE_API_KEY is not configured");
    }
    return Promise.resolve({ ok: true });
  }

  estimateMicros(req: GenerativeVideoRequest): number {
    return this.ai.estimateVideoMicros(this.model, req.seconds, false);
  }

  async generate(
    req: GenerativeVideoRequest,
    ctx: CallContext,
  ): Promise<{ path: string; durationMs: number; cached: boolean }> {
    if (!(req.seconds > 0)) throw new FatalError("generative video: seconds must be > 0");
    if (req.seconds > this.maxSeconds) {
      throw new FatalError(
        `generative video: ${req.seconds} s exceeds REEL_MAX_GENERATIVE_VIDEO_SECONDS=${this.maxSeconds}`,
      );
    }
    const prompt = veoPrompt(req);
    const firstFrameSha = req.firstFramePath ? await fileSha256(req.firstFramePath) : null;
    const key = cacheKey(NS, VEO_VERSION, {
      model: this.model,
      prompt,
      negative: VEO_NEGATIVE_PROMPT,
      seconds: req.seconds,
      aspect: req.aspect,
      firstFrameSha,
      seed: req.seed,
    });
    const cache = new FileCache(ctx.cacheDir);
    const res = await cachedCall<VeoMeta>({
      ctx,
      namespace: NS,
      key,
      required: ["clip.mp4"],
      capability: "generative_video",
      model: this.model,
      hitUnits: { videoSeconds: req.seconds },
      produce: async (dir) => {
        const pending = await cache.readJson<{ operationName?: string }>(NS, key, "operation.json");
        const operationName = typeof pending?.operationName === "string" ? pending.operationName : undefined;
        let video;
        try {
          video = await paid(ctx, "generative_video", this.model, () =>
            this.ai.generateVideo({
              model: this.model,
              prompt,
              seconds: req.seconds,
              aspectRatio: req.aspect,
              generateAudio: false,
              negativePrompt: VEO_NEGATIVE_PROMPT,
              seed: numericSeed(req.seed),
              label: "reel.generative_video",
              ...(req.firstFramePath ? { firstFramePath: req.firstFramePath } : {}),
              ...(operationName ? { operationName } : {}),
              ...(ctx.signal ? { signal: ctx.signal } : {}),
              onOperation: async (name) => {
                await cache.writeJson(
                  NS,
                  key,
                  { operationName: name, startedAt: new Date().toISOString() },
                  "operation.json",
                );
              },
            }),
          );
        } catch (err) {
          // a stale / unknown operation must not block the next attempt forever
          if (operationName && err instanceof ProviderError && !err.retryable) {
            await fsp.rm(path.join(dir, "operation.json"), { force: true });
          }
          throw err;
        }
        recordCall(ctx, {
          capability: "generative_video",
          model: this.model,
          costMicros: video.costMicros,
          estimated: video.costEstimated,
          units: { videoSeconds: video.durationMs / 1000 },
          latencyMs: video.latencyMs,
          ...(operationName ? { note: `resumed ${operationName}` } : {}),
        });
        const raw = path.join(dir, `raw${extensionForMime(video.mimeType ?? "video/mp4")}`);
        await fsp.writeFile(raw, video.bytes);
        const durationMs = await trimClip(raw, path.join(dir, "clip.mp4"), req.seconds, ctx.signal);
        return { durationMs, ...(video.operationName ? { operationName: video.operationName } : {}) };
      },
    });
    return { path: path.join(res.dir, "clip.mp4"), durationMs: res.meta.durationMs, cached: res.cached };
  }
}
