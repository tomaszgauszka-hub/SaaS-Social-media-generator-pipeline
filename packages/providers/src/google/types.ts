/**
 * One shared Google AI client for every Google capability (Gemini, Gemini image, Lyria, Gemini TTS, Cloud TTS,
 * transcription, embeddings, Veo). It owns authentication, retries (honouring Retry-After), a process-wide
 * request-rate limit, logging and cost accounting, so capability wrappers stay thin and swappable.
 *
 * Model ids are always passed in from configuration (@cre/config GOOGLE_*_MODEL) — never hard-coded in callers.
 * Every method returns `costMicros` computed from the provider-reported usage (tokens / units) and the pricing
 * catalog; `estimate*` helpers return a pre-call estimate for the budget gate.
 */

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";
export type MediaResolution = "low" | "medium" | "high";

export type GeminiPart =
  | { text: string }
  /** a local file (image/audio/video/pdf); the client reads and inlines it (size-limited) */
  | { file: string; mimeType?: string };

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  cachedTokens: number;
}

export interface GeminiGenerateRequest {
  model: string;
  /** system instruction */
  system?: string;
  parts: GeminiPart[];
  /** JSON Schema for structured output (responseMimeType application/json + responseJsonSchema) */
  jsonSchema?: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
  mediaResolution?: MediaResolution;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** logging / metrics label, e.g. "reel.director" */
  label?: string;
}

export interface GeminiGenerateResult {
  text: string;
  /** parsed JSON when jsonSchema was set (still validate it with zod in the caller) */
  json?: unknown;
  usage: GeminiUsage;
  model: string;
  latencyMs: number;
  finishReason?: string;
  costMicros: number;
}

export interface GoogleImageRequest {
  model: string;
  prompt: string;
  /** reference images (local paths) */
  references?: string[];
  aspectRatio: "9:16" | "1:1" | "16:9" | "4:5" | "3:4";
  imageSize?: "1K" | "2K" | "4K";
  signal?: AbortSignal;
}

export interface GoogleMusicRequest {
  model: string;
  /** full prompt incl. genre, mood, BPM, timestamped sections and "Instrumental only, no vocals." */
  prompt: string;
  /** reference images (local paths), optional */
  references?: string[];
  signal?: AbortSignal;
}

export interface GoogleSpeechRequest {
  model: string;
  /** spoken verbatim */
  text: string;
  voice: string;
  /** delivery direction (speech metadata / style prompt) */
  style?: string;
  languageCode: string;
  signal?: AbortSignal;
}

export interface CloudTtsMarkRequest {
  /** Cloud TTS voice name (Standard / WaveNet / Neural2 — voices that support SSML <mark>) */
  voiceName: string;
  languageCode: string;
  /** words in order; the client wraps them in SSML with a <mark> before each word */
  words: string[];
  speakingRate?: number;
  signal?: AbortSignal;
}

export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface GoogleTranscriptionRequest {
  model: string;
  audioPath: string;
  languageCode: string;
  /** known script (TTS) — improves alignment when the API supports a prompt / phrase hints */
  expectedText?: string;
  signal?: AbortSignal;
}

export type GoogleEmbedItem = {
  id: string;
  text?: string;
  imagePath?: string;
  audioPath?: string;
  videoPath?: string;
};

export interface GoogleVideoRequest {
  model: string;
  prompt: string;
  seconds: number;
  aspectRatio: "9:16" | "16:9";
  /** first frame image (local path) for image-to-video */
  firstFramePath?: string;
  generateAudio?: boolean;
  signal?: AbortSignal;
  /** long-running operation name, to resume polling after a crash instead of paying twice */
  operationName?: string;
  onOperation?: (name: string) => Promise<void> | void;
}

export interface GoogleAI {
  /** true when an API key is configured (Gemini API surface) */
  readonly hasApiKey: boolean;
  /** true when an OAuth access token is configured (Cloud TTS / Speech-to-Text / Agent Platform) */
  readonly hasCloudToken: boolean;

  generate(req: GeminiGenerateRequest): Promise<GeminiGenerateResult>;
  generateImage(
    req: GoogleImageRequest,
  ): Promise<{
    bytes: Buffer;
    mimeType: string;
    width?: number;
    height?: number;
    costMicros: number;
    model: string;
  }>;
  generateMusic(
    req: GoogleMusicRequest,
  ): Promise<{ bytes: Buffer; mimeType: string; text?: string; costMicros: number; model: string }>;
  /** Gemini TTS — returns WAV (PCM 16-bit). No word timings (Google TTS models do not return them). */
  synthesizeSpeech(
    req: GoogleSpeechRequest,
  ): Promise<{ wav: Buffer; sampleRate: number; costMicros: number; model: string }>;
  /** Cloud Text-to-Speech v1beta1 with SSML <mark> per word → word start times (the only Google TTS with timing) */
  synthesizeWithMarks(
    req: CloudTtsMarkRequest,
  ): Promise<{ audio: Buffer; mimeType: string; words: TimedWord[]; costMicros: number }>;
  transcribe(
    req: GoogleTranscriptionRequest,
  ): Promise<{ words: TimedWord[]; text: string; costMicros: number; model: string }>;
  embed(req: {
    model: string;
    dimensions: number;
    items: GoogleEmbedItem[];
    /** "query" or "document" — mapped to the model's task prefix */
    role?: "query" | "document";
    signal?: AbortSignal;
  }): Promise<{ vectors: { id: string; vector: number[] }[]; costMicros: number }>;
  generateVideo(
    req: GoogleVideoRequest,
  ): Promise<{ bytes: Buffer; durationMs: number; costMicros: number; model: string }>;

  /* pre-call estimates (micro-USD) for the budget gate */
  estimateGenerateMicros(model: string, inputTokens: number, outputTokens: number): number;
  estimateImageMicros(model: string, imageSize: "1K" | "2K" | "4K"): number;
  estimateMusicMicros(model: string): number;
  estimateSpeechMicros(model: string, characters: number): number;
  estimateTranscriptionMicros(model: string, audioMs: number): number;
  estimateEmbedMicros(model: string, items: GoogleEmbedItem[]): number;
  estimateVideoMicros(model: string, seconds: number, withAudio: boolean): number;
}
