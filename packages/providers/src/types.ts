import type { ModelClass } from "@cre/config";
import type { Logger, Micros } from "@cre/shared";

/**
 * Provider contracts. Business code depends only on these interfaces; concrete implementations are chosen
 * by configuration (see registry.ts). Every provider exposes healthCheck / estimateCost / execute.
 */

export type ProviderKind = "llm" | "image" | "video" | "tts" | "bg_removal" | "music" | "storage" | "social";

export type UsageOperationName =
  "LLM_COMPLETION" | "IMAGE_GENERATION" | "BACKGROUND_REMOVAL" | "VIDEO_GENERATION" | "TTS" | "OTHER";

export interface CostEstimate {
  provider: string;
  model: string;
  operation: UsageOperationName;
  /** estimated cost of the call in micro-USD (what the real provider would charge) */
  estimatedMicros: Micros;
  units: {
    images?: number;
    videoSeconds?: number;
    audioSeconds?: number;
    characters?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  isMock: boolean;
  isAiVideo?: boolean;
}

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  kind: ProviderKind;
  isMock: boolean;
  message?: string;
  latencyMs?: number;
}

export interface ExecContext {
  signal?: AbortSignal;
  /** scratch directory for temporary/output files of this call */
  workDir: string;
  logger?: Logger;
  /**
   * Async providers: request id from a previous (interrupted) attempt. When present the provider polls it
   * instead of submitting a new — paid — request.
   */
  externalJobId?: string | null;
  /** called as soon as an async provider has a request id, so it can be persisted before polling */
  onExternalJobId?: (id: string) => Promise<void>;
}

export interface BaseProvider<Req, Res> {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly isMock: boolean;
  healthCheck(): Promise<ProviderHealth>;
  estimateCost(req: Req): CostEstimate;
  execute(req: Req, ctx: ExecContext): Promise<Res>;
}

/** Common result fields for media-producing providers. */
export interface MediaResultBase {
  filePath: string;
  mimeType: string;
  model: string;
  /** real cost when the provider reports it */
  actualCostMicros?: Micros;
  externalJobId?: string;
  /** licence / provenance tag stored on the Asset */
  license: string;
  providerMeta?: Record<string, unknown>;
}

/* ---------------------------------------------------------------- image ------------------------- */

export interface ImageRequest {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  modelClass: ModelClass;
  /** explicit model id (overrides modelClass) */
  model?: string;
  seed?: number;
  /** palette hint (mock provider uses it; real providers get it via the prompt) */
  paletteHint?: [string, string];
}

export interface ImageResult extends MediaResultBase {
  width: number;
  height: number;
  seed?: number;
}

export type ImageProvider = BaseProvider<ImageRequest, ImageResult>;

/* ---------------------------------------------------------------- background removal ------------ */

export interface BgRemovalRequest {
  imagePath: string;
  /** public URL of the image when the provider needs one (remote APIs) */
  imageUrl?: string;
}

export type BgRemovalResult = MediaResultBase;

export type BackgroundRemovalProvider = BaseProvider<BgRemovalRequest, BgRemovalResult>;

/* ---------------------------------------------------------------- image-to-video ---------------- */

export interface VideoRequest {
  imagePath: string;
  imageUrl?: string;
  prompt: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  modelClass: ModelClass;
  model?: string;
}

export interface VideoResult extends MediaResultBase {
  durationMs: number;
  width: number;
  height: number;
}

export type VideoGenerationProvider = BaseProvider<VideoRequest, VideoResult>;

/* ---------------------------------------------------------------- text-to-speech ---------------- */

export interface TTSRequest {
  text: string;
  voice?: string;
  language: string;
  speed?: number;
}

export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TTSResult extends MediaResultBase {
  durationMs: number;
  words: WordTiming[];
  /** true when word timings come from the provider, false when estimated */
  timingsExact: boolean;
  characters: number;
  voice: string;
}

export type TTSProvider = BaseProvider<TTSRequest, TTSResult>;

/* ---------------------------------------------------------------- music -------------------------- */

export interface MusicRequest {
  durationSec: number;
  mood: "upbeat" | "chill" | "tech";
  seed: string;
}

export interface MusicResult extends MediaResultBase {
  durationMs: number;
}

export type MusicProvider = BaseProvider<MusicRequest, MusicResult>;
