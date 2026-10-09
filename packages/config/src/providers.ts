import type { Env } from "./env.ts";

/**
 * Provider configuration — the ONLY place that maps "which implementation / which model" to settings.
 * Business code asks for "the image provider" and "the cheap image model", never for "fal" by name.
 */

export type LlmProviderName = "deepseek" | "openai" | "mock";
export type ImageProviderName = "fal" | "mock";
export type VideoProviderName = "fal" | "mock";
export type BgRemovalProviderName = "fal" | "mock";
export type TtsProviderName = "openai" | "elevenlabs" | "flite" | "mock";
export type StorageDriverName = "local" | "s3";
export type SocialProviderName = "meta" | "tiktok" | "mock";
export type SocialPlatformKey = "INSTAGRAM" | "FACEBOOK" | "TIKTOK";
export type ModelClass = "cheap" | "standard" | "premium";

export interface ProviderSelection {
  llm: LlmProviderName;
  image: ImageProviderName;
  video: VideoProviderName;
  bgRemoval: BgRemovalProviderName;
  tts: TtsProviderName;
  storage: StorageDriverName;
  social: Record<SocialPlatformKey, SocialProviderName>;
  mock: { ai: boolean; media: boolean; social: boolean; costMode: "simulate" | "zero" };
}

export interface ModelCatalog {
  llm: { default: string; reasoning: string };
  image: Record<ModelClass, string>;
  video: Record<ModelClass, string>;
  bgRemoval: string;
  tts: string;
}

export function resolveProviderSelection(env: Env): ProviderSelection {
  return {
    llm: env.MOCK_AI ? "mock" : env.LLM_PROVIDER,
    image: env.MOCK_MEDIA ? "mock" : env.IMAGE_PROVIDER,
    video: env.MOCK_MEDIA ? "mock" : env.VIDEO_PROVIDER,
    bgRemoval: env.MOCK_MEDIA ? "mock" : env.BG_REMOVAL_PROVIDER,
    tts: env.MOCK_MEDIA ? "mock" : env.TTS_PROVIDER,
    storage: env.STORAGE_DRIVER,
    social: env.MOCK_SOCIAL
      ? { INSTAGRAM: "mock", FACEBOOK: "mock", TIKTOK: "mock" }
      : { INSTAGRAM: "meta", FACEBOOK: "meta", TIKTOK: "tiktok" },
    mock: { ai: env.MOCK_AI, media: env.MOCK_MEDIA, social: env.MOCK_SOCIAL, costMode: env.MOCK_COST_MODE },
  };
}

/** Model identifiers per provider. Overridable via env (IMAGE_MODEL_CHEAP, VIDEO_MODEL_STANDARD, …). */
export function resolveModelCatalog(
  env: Env,
  selection: ProviderSelection = resolveProviderSelection(env),
): ModelCatalog {
  const llmDefault =
    selection.llm === "deepseek"
      ? env.DEEPSEEK_MODEL
      : selection.llm === "openai"
        ? env.OPENAI_MODEL
        : "mock-llm";
  return {
    llm: {
      default: llmDefault,
      reasoning: selection.llm === "deepseek" ? "deepseek-reasoner" : llmDefault,
    },
    image: {
      cheap: env.IMAGE_MODEL_CHEAP ?? "fal-ai/flux/schnell",
      standard: env.IMAGE_MODEL_STANDARD ?? "fal-ai/flux/dev",
      premium: env.IMAGE_MODEL_PREMIUM ?? "fal-ai/flux-pro/v1.1",
    },
    video: {
      cheap: env.VIDEO_MODEL_CHEAP ?? "fal-ai/kling-video/v2.1/standard/image-to-video",
      standard: env.VIDEO_MODEL_STANDARD ?? "fal-ai/kling-video/v2.1/pro/image-to-video",
      premium: env.VIDEO_MODEL_PREMIUM ?? "fal-ai/kling-video/v2.1/master/image-to-video",
    },
    bgRemoval: "fal-ai/birefnet",
    tts: selection.tts === "elevenlabs" ? "eleven_flash_v2_5" : selection.tts === "flite" ? "flite" : "tts-1",
  };
}

/**
 * Which real provider/model a mock stands in for. In MOCK_COST_MODE=simulate, mock operations are valued at
 * the price of the provider they simulate, so dashboards show realistic "would have cost" numbers.
 */
export const MOCK_SIMULATES = {
  llm: { provider: "deepseek", model: "deepseek-chat" },
  image: { provider: "fal" },
  video: { provider: "fal" },
  bgRemoval: { provider: "fal", model: "fal-ai/birefnet" },
  tts: { provider: "openai", model: "tts-1" },
} as const;

/** Human readable summary for the settings page / health endpoint (no secrets). */
export function describeProviderConfig(env: Env): Record<string, unknown> {
  const selection = resolveProviderSelection(env);
  const models = resolveModelCatalog(env, selection);
  return {
    selection,
    models,
    credentials: {
      deepseek: Boolean(env.DEEPSEEK_API_KEY),
      openai: Boolean(env.OPENAI_API_KEY),
      fal: Boolean(env.FAL_KEY),
      elevenlabs: Boolean(env.ELEVENLABS_API_KEY),
      meta: Boolean(env.META_APP_ID && env.META_APP_SECRET),
      tiktok: Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET),
      s3: Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID),
      /** Gemini API key (director, image, Lyria, Gemini TTS, transcription, embeddings) */
      google: Boolean(env.GOOGLE_API_KEY),
      /** OAuth access token for Cloud TTS / Speech-to-Text / Agent Platform (Veo) */
      googleCloud: Boolean(env.GOOGLE_CLOUD_ACCESS_TOKEN),
      googleCloudProject: Boolean(env.GOOGLE_CLOUD_PROJECT),
    },
    google: {
      models: {
        director: env.GOOGLE_DIRECTOR_MODEL,
        directorFallback: env.GOOGLE_DIRECTOR_FALLBACK_MODEL,
        image: env.GOOGLE_IMAGE_MODEL,
        music: env.GOOGLE_MUSIC_MODEL,
        tts: env.GOOGLE_TTS_MODEL,
        transcription: env.GOOGLE_TRANSCRIPTION_MODEL,
        embedding: env.GOOGLE_EMBEDDING_MODEL,
        video: env.GOOGLE_VIDEO_MODEL,
      },
      ttsVoice: env.GOOGLE_TTS_VOICE,
      embeddingDimensions: env.GOOGLE_EMBEDDING_DIMENSIONS,
      cloudLocation: env.GOOGLE_CLOUD_LOCATION,
      maxRpm: env.GOOGLE_MAX_RPM,
      musicCommercialUse: env.GOOGLE_MUSIC_COMMERCIAL_USE,
      generativeVideoEnabled: env.GENERATIVE_VIDEO_ENABLED,
      maxGenerativeVideoSeconds: env.REEL_MAX_GENERATIVE_VIDEO_SECONDS,
    },
    publishingEnabled: env.PUBLISHING_ENABLED,
    tiktokPrivacyLevel: env.TIKTOK_PRIVACY_LEVEL,
  };
}
