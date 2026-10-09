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
  | { file: string; mimeType?: string }
  /** in-memory bytes (size-limited like files) */
  | { bytes: Buffer; mimeType: string };

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
  /** true when the response carried no usage metadata and `costMicros` is the pre-call estimate */
  costEstimated?: boolean;
}

/** Fields every non-generate result may add (all optional, for cost records). */
export interface GoogleCallMeta {
  usage?: GeminiUsage;
  latencyMs?: number;
  /** true when `costMicros` is an estimate (the API reported no usage) */
  costEstimated?: boolean;
}

export interface GoogleImageRequest {
  model: string;
  prompt: string;
  /** reference images (local paths) */
  references?: string[];
  aspectRatio: "9:16" | "1:1" | "16:9" | "4:5" | "3:4";
  imageSize?: "1K" | "2K" | "4K";
  signal?: AbortSignal;
  timeoutMs?: number;
  label?: string;
}

export interface GoogleMusicRequest {
  model: string;
  /** full prompt incl. genre, mood, BPM, timestamped sections and "Instrumental only, no vocals." */
  prompt: string;
  /** reference images (local paths), optional */
  references?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  label?: string;
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
  timeoutMs?: number;
  label?: string;
}

export interface CloudTtsMarkRequest {
  /** Cloud TTS voice name (Standard / WaveNet / Neural2 — voices that support SSML <mark>) */
  voiceName: string;
  languageCode: string;
  /** words in order; the client wraps them in SSML with a <mark> before each word */
  words: string[];
  speakingRate?: number;
  /** LINEAR16 output rate (default 48 000 Hz — the reel's audio rate, no resampling needed) */
  sampleRateHertz?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  label?: string;
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
  /** audio duration when known (cost when the API reports no billed duration / usage) */
  durationMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  label?: string;
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
  /** what must not appear / change (Veo negativePrompt) */
  negativePrompt?: string;
  resolution?: "720p" | "1080p";
  /** Agent Platform only (the Gemini API rejects seeds) */
  seed?: number;
  /** max wait for the long-running operation (default 10 min) */
  timeoutMs?: number;
  label?: string;
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
  /** true when GOOGLE_CLOUD_PROJECT is set (Speech-to-Text v2 and Agent Platform URLs need it) */
  readonly hasCloudProject?: boolean;

  generate(req: GeminiGenerateRequest): Promise<GeminiGenerateResult>;
  generateImage(req: GoogleImageRequest): Promise<
    {
      bytes: Buffer;
      mimeType: string;
      width?: number;
      height?: number;
      costMicros: number;
      model: string;
      /** text the model returned next to the image, if any */
      text?: string;
    } & GoogleCallMeta
  >;
  generateMusic(
    req: GoogleMusicRequest,
  ): Promise<
    { bytes: Buffer; mimeType: string; text?: string; costMicros: number; model: string } & GoogleCallMeta
  >;
  /** Gemini TTS — returns WAV (PCM 16-bit). No word timings (Google TTS models do not return them). */
  synthesizeSpeech(
    req: GoogleSpeechRequest,
  ): Promise<{ wav: Buffer; sampleRate: number; costMicros: number; model: string } & GoogleCallMeta>;
  /** Cloud Text-to-Speech v1beta1 with SSML <mark> per word → word start times (the only Google TTS with timing) */
  synthesizeWithMarks(req: CloudTtsMarkRequest): Promise<
    {
      audio: Buffer;
      mimeType: string;
      words: TimedWord[];
      costMicros: number;
      /** billed characters (SSML without <mark> tags) */
      characters?: number;
      sampleRate?: number;
      durationMs?: number;
    } & GoogleCallMeta
  >;
  transcribe(
    req: GoogleTranscriptionRequest,
  ): Promise<{ words: TimedWord[]; text: string; costMicros: number; model: string } & GoogleCallMeta>;
  embed(req: {
    model: string;
    dimensions: number;
    items: GoogleEmbedItem[];
    /** "query" or "document" — mapped to the model's task prefix */
    role?: "query" | "document";
    signal?: AbortSignal;
    timeoutMs?: number;
    label?: string;
  }): Promise<{ vectors: { id: string; vector: number[] }[]; costMicros: number } & GoogleCallMeta>;
  generateVideo(req: GoogleVideoRequest): Promise<
    {
      bytes: Buffer;
      durationMs: number;
      costMicros: number;
      model: string;
      mimeType?: string;
      operationName?: string;
    } & GoogleCallMeta
  >;

  /* pre-call estimates (micro-USD) for the budget gate */
  estimateGenerateMicros(model: string, inputTokens: number, outputTokens: number): number;
  /** `referenceCount` adds the input tokens of reference images */
  estimateImageMicros(model: string, imageSize: "1K" | "2K" | "4K", referenceCount?: number): number;
  estimateMusicMicros(model: string): number;
  /** Gemini TTS model (tokens) or a Cloud TTS voice name like "pl-PL-Wavenet-A" (per character) */
  estimateSpeechMicros(model: string, characters: number): number;
  estimateTranscriptionMicros(model: string, audioMs: number): number;
  estimateEmbedMicros(model: string, items: GoogleEmbedItem[]): number;
  estimateVideoMicros(model: string, seconds: number, withAudio: boolean): number;
}
