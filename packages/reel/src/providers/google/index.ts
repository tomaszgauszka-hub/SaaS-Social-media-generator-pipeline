import type { Env } from "@cre/config";
import type { GoogleAI } from "@cre/providers";
import { GoogleEmbeddingProvider } from "./embedding.ts";
import { GoogleImageProvider } from "./image.ts";
import { GoogleLyriaMusicProvider } from "./music.ts";
import { GoogleTranscriptionProvider } from "./transcription.ts";
import { GoogleVeoProvider } from "./video.ts";
import { GoogleCloudTtsMarksVoiceProvider, GoogleGeminiTtsVoiceProvider } from "./voice.ts";

/*
 * Google capability wrappers of the reel factory. Each implements a capability interface from
 * capabilities/types.ts on top of ONE shared GoogleAI client (@cre/providers createGoogleAI), reports
 * `available()` without spending money (key / token / project present AND the enabling flags), estimates
 * before the call, records every call (or cost-0 cache hit) in ctx.tracker and caches its result in ctx.cacheDir.
 * The director / product analysis / transcreation / visual QA providers call `googleAI.generate` themselves.
 */

export * from "./common.ts";
export * from "./embedding.ts";
export * from "./image.ts";
export * from "./music.ts";
export * from "./transcription.ts";
export * from "./video.ts";
export * from "./voice.ts";

export type GoogleProvidersEnv = Pick<
  Env,
  | "GOOGLE_MUSIC_MODEL"
  | "GOOGLE_MUSIC_COMMERCIAL_USE"
  | "GOOGLE_TTS_MODEL"
  | "GOOGLE_TTS_VOICE"
  | "GOOGLE_TRANSCRIPTION_MODEL"
  | "GOOGLE_IMAGE_MODEL"
  | "GOOGLE_EMBEDDING_MODEL"
  | "GOOGLE_EMBEDDING_DIMENSIONS"
  | "GOOGLE_VIDEO_MODEL"
  | "GENERATIVE_VIDEO_ENABLED"
  | "REEL_MAX_GENERATIVE_VIDEO_SECONDS"
>;

export interface GoogleProvidersOptions {
  /** the reel is declared non-commercial: Lyria may run without GOOGLE_MUSIC_COMMERCIAL_USE */
  nonCommercialUse?: boolean;
  /** Gemini image size tier (default 2K) */
  imageSize?: "1K" | "2K" | "4K";
  /** Cloud TTS voices per locale, merged over DEFAULT_CLOUD_TTS_VOICES */
  cloudTtsVoices?: Record<string, string | { female: string; male: string }>;
}

export interface GoogleProviders {
  music: GoogleLyriaMusicProvider;
  /** Gemini TTS — natural voice, no word timings */
  geminiTts: GoogleGeminiTtsVoiceProvider;
  /** Cloud TTS with SSML marks — exact word timings */
  cloudTts: GoogleCloudTtsMarksVoiceProvider;
  transcription: GoogleTranscriptionProvider;
  image: GoogleImageProvider;
  /** asset / document embeddings */
  embedding: GoogleEmbeddingProvider;
  /** query embeddings (same space, query task prefix) */
  embeddingQuery: GoogleEmbeddingProvider;
  video: GoogleVeoProvider;
}

export function createGoogleProviders(
  env: GoogleProvidersEnv,
  googleAI: GoogleAI,
  opts: GoogleProvidersOptions = {},
): GoogleProviders {
  const embedding = new GoogleEmbeddingProvider(env, googleAI);
  return {
    music: new GoogleLyriaMusicProvider(env, googleAI, {
      ...(opts.nonCommercialUse !== undefined ? { nonCommercialUse: opts.nonCommercialUse } : {}),
    }),
    geminiTts: new GoogleGeminiTtsVoiceProvider(env, googleAI),
    cloudTts: new GoogleCloudTtsMarksVoiceProvider(googleAI, {
      ...(opts.cloudTtsVoices ? { voices: opts.cloudTtsVoices } : {}),
    }),
    transcription: new GoogleTranscriptionProvider(env, googleAI),
    image: new GoogleImageProvider(env, googleAI, {
      ...(opts.imageSize ? { imageSize: opts.imageSize } : {}),
    }),
    embedding,
    embeddingQuery: embedding.forQueries(),
    video: new GoogleVeoProvider(env, googleAI),
  };
}
