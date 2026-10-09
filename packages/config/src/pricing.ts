import { usdToMicros, type Micros } from "@cre/shared";

/**
 * Pricing catalog used for PRE-CALL cost estimates and for valuing mock operations ("what this would cost").
 *
 * These are estimates. Providers change prices; verify against current price pages and invoices
 * (see docs/COST_MODEL.md). When a provider reports the real cost, it is stored as `actualCostUsd`
 * and always takes precedence over the estimate.
 */
export interface LlmPrice {
  kind: "llm";
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}
export interface ImagePrice {
  kind: "image";
  perMegapixel?: number;
  perImage?: number;
}
export interface VideoPrice {
  kind: "video";
  perSecond: number;
  minSeconds: number;
  /** cheaper video-only rate where the API can switch generated audio off (Veo on Agent Platform) */
  perSecondNoAudio?: number;
  /** rates for non-default output resolutions ("1080p", "4k" …) */
  byResolution?: Record<string, { perSecond: number; perSecondNoAudio?: number }>;
}
export interface TtsPrice {
  kind: "tts";
  perMillionChars: number;
}
export interface BgRemovalPrice {
  kind: "bg_removal";
  perImage: number;
}
/**
 * Multimodal token pricing (Gemini family: text, image generation, TTS, transcription, embeddings). USD per 1M
 * tokens; a modality without its own rate is billed at the `text` rate. Thinking tokens are billed at the text
 * OUTPUT rate.
 */
export interface TokenPrice {
  kind: "tokens";
  input: { text: number; image?: number; audio?: number; video?: number };
  cachedInputPerMTok?: number;
  output: { text: number; image?: number; audio?: number };
  /** output tokens billed per generated image by size tier (image models) */
  imageTokens?: Partial<Record<ImageSizeTier, number>>;
  /** audio tokens per second of audio (TTS output, transcription input) */
  audioTokensPerSecond?: number;
}
export type ImageSizeTier = "512" | "1K" | "2K" | "4K";
/** Music generation, per generated song / clip or per second of output. */
export interface MusicPrice {
  kind: "music";
  perSong?: number;
  perSecond?: number;
}
/** Speech-to-text billed per audio minute in increments of `billingIncrementSeconds`. */
export interface SttPrice {
  kind: "stt";
  perMinute: number;
  billingIncrementSeconds: number;
}
export type PriceEntry = (
  LlmPrice | ImagePrice | VideoPrice | TtsPrice | BgRemovalPrice | TokenPrice | MusicPrice | SttPrice
) & {
  asOf: string;
  note?: string;
};

export const PRICING: Record<string, PriceEntry> = {
  // --- LLM ---------------------------------------------------------------------------------------
  "deepseek:deepseek-chat": {
    kind: "llm",
    inputPerMTok: 0.28,
    cachedInputPerMTok: 0.028,
    outputPerMTok: 0.42,
    asOf: "2025-09-29",
    note: "DeepSeek V3.2 list price (cache miss / cache hit / output)",
  },
  "deepseek:deepseek-reasoner": {
    kind: "llm",
    inputPerMTok: 0.28,
    cachedInputPerMTok: 0.028,
    outputPerMTok: 0.42,
    asOf: "2025-09-29",
  },
  "openai:gpt-4o-mini": {
    kind: "llm",
    inputPerMTok: 0.15,
    cachedInputPerMTok: 0.075,
    outputPerMTok: 0.6,
    asOf: "2025-06-01",
  },
  // --- Images (fal.ai) ------------------------------------------------------------------------------
  "fal:fal-ai/flux/schnell": { kind: "image", perMegapixel: 0.003, asOf: "2025-06-01" },
  "fal:fal-ai/flux/dev": { kind: "image", perMegapixel: 0.025, asOf: "2025-06-01" },
  "fal:fal-ai/flux-pro/v1.1": { kind: "image", perMegapixel: 0.04, asOf: "2025-06-01" },
  "fal:fal-ai/birefnet": { kind: "bg_removal", perImage: 0.002, asOf: "2025-06-01", note: "estimate" },
  // --- Image-to-video (fal.ai) --------------------------------------------------------------------
  "fal:fal-ai/kling-video/v2.1/standard/image-to-video": {
    kind: "video",
    perSecond: 0.05,
    minSeconds: 5,
    asOf: "2025-06-01",
  },
  "fal:fal-ai/kling-video/v2.1/pro/image-to-video": {
    kind: "video",
    perSecond: 0.09,
    minSeconds: 5,
    asOf: "2025-06-01",
  },
  "fal:fal-ai/kling-video/v2.1/master/image-to-video": {
    kind: "video",
    perSecond: 0.28,
    minSeconds: 5,
    asOf: "2025-06-01",
  },
  // --- TTS -------------------------------------------------------------------------------------------
  "openai:tts-1": { kind: "tts", perMillionChars: 15, asOf: "2025-06-01" },
  "openai:gpt-4o-mini-tts": { kind: "tts", perMillionChars: 12, asOf: "2025-06-01", note: "approximation" },
  "elevenlabs:eleven_flash_v2_5": {
    kind: "tts",
    perMillionChars: 100,
    asOf: "2025-06-01",
    note: "depends on plan; conservative",
  },
  "flite:flite": { kind: "tts", perMillionChars: 0, asOf: "2025-06-01", note: "local, free" },
  // --- Google (Gemini API / Cloud TTS / Speech-to-Text / Agent Platform) -------------------------------
  // Prices from ai.google.dev/gemini-api/docs/pricing, cloud.google.com/text-to-speech/pricing,
  // cloud.google.com/speech-to-text/pricing and the Agent Platform pricing page as read on 2026-10-08.
  // A key "google:<model>@YYYY-MM-DD" is a scheduled price change that applies from that date on.
  "google:gemini-3.5-flash-lite": {
    kind: "tokens",
    input: { text: 0.3 },
    cachedInputPerMTok: 0.03,
    output: { text: 2.5 },
    asOf: "2026-10-08",
    note: "one input rate for text/image/video/audio; output includes thinking",
  },
  "google:gemini-3.8-flash": {
    kind: "tokens",
    input: { text: 0.75 },
    cachedInputPerMTok: 0.075,
    output: { text: 3.75 },
    asOf: "2026-10-08",
    note: "introductory price through 2026-12-31",
  },
  "google:gemini-3.8-flash@2027-01-01": {
    kind: "tokens",
    input: { text: 1.5 },
    cachedInputPerMTok: 0.15,
    output: { text: 7.5 },
    asOf: "2026-10-08",
  },
  "google:gemini-3.7-flash": {
    kind: "tokens",
    input: { text: 0.75 },
    cachedInputPerMTok: 0.075,
    output: { text: 3.75 },
    asOf: "2026-10-08",
    note: "introductory price through 2026-12-31",
  },
  "google:gemini-3.7-flash@2027-01-01": {
    kind: "tokens",
    input: { text: 1.5 },
    cachedInputPerMTok: 0.15,
    output: { text: 7.5 },
    asOf: "2026-10-08",
  },
  "google:gemini-3.6-flash": {
    kind: "tokens",
    input: { text: 1.5 },
    output: { text: 7.5 },
    asOf: "2026-10-08",
    note: "sources conflict ($0.75/$3.75 intro vs $1.50/$7.50) — the higher rate is used",
  },
  "google:gemini-3.5-flash": {
    kind: "tokens",
    input: { text: 1.5 },
    output: { text: 9 },
    asOf: "2026-10-08",
  },
  "google:gemini-3.1-flash-lite": {
    kind: "tokens",
    input: { text: 0.25, audio: 0.5 },
    output: { text: 1.5 },
    asOf: "2026-10-08",
  },
  // image generation: output image tokens are fixed per size tier (4K: pricing page 3,780 vs docs 2,520 → higher)
  "google:gemini-nano-banana-2.1": {
    kind: "tokens",
    input: { text: 1.5 },
    output: { text: 7.5, image: 30 },
    imageTokens: { "1K": 1120, "2K": 1680, "4K": 3780 },
    asOf: "2026-10-08",
  },
  "google:gemini-3-pro-image": {
    kind: "tokens",
    input: { text: 2 },
    output: { text: 12, image: 120 },
    imageTokens: { "1K": 1120, "2K": 1120, "4K": 2000 },
    asOf: "2026-10-08",
    note: "text input/output rates not seen verbatim; image output $120/1M is",
  },
  "google:gemini-3.1-flash-lite-image": {
    kind: "tokens",
    input: { text: 0.25 },
    output: { text: 1.5, image: 30 },
    imageTokens: { "1K": 1120 },
    asOf: "2026-10-08",
  },
  "google:gemini-3.1-flash-image": {
    kind: "tokens",
    input: { text: 0.5 },
    output: { text: 3, image: 60 },
    imageTokens: { "512": 750, "1K": 1120, "2K": 1680, "4K": 2520 },
    asOf: "2026-10-08",
    note: "deprecated 2026-10-06 (shutdown 2026-10-29); text output rate not seen verbatim",
  },
  // music
  "google:lyria-3.5": { kind: "music", perSong: 0.08, asOf: "2026-10-08", note: "per generated song" },
  "google:lyria-3-pro-preview": { kind: "music", perSong: 0.08, asOf: "2026-10-08" },
  "google:lyria-3-clip-preview": {
    kind: "music",
    perSong: 0.04,
    asOf: "2026-10-08",
    note: "fixed 30 s clip",
  },
  // Gemini TTS: 25 audio tokens per second of output
  "google:gemini-3.8-flash-tts": {
    kind: "tokens",
    input: { text: 0.5 },
    output: { text: 9, audio: 9 },
    audioTokensPerSecond: 25,
    asOf: "2026-10-08",
    note: "Preview; promotional price through 2026-12-31",
  },
  "google:gemini-3.8-flash-tts@2027-01-01": {
    kind: "tokens",
    input: { text: 1 },
    output: { text: 18, audio: 18 },
    audioTokensPerSecond: 25,
    asOf: "2026-10-08",
  },
  "google:gemini-3.8-flash-lite-tts": {
    kind: "tokens",
    input: { text: 0.5 },
    output: { text: 6, audio: 6 },
    audioTokensPerSecond: 25,
    asOf: "2026-10-08",
    note: "Preview; promotional price through 2026-12-31",
  },
  "google:gemini-3.8-flash-lite-tts@2027-01-01": {
    kind: "tokens",
    input: { text: 1 },
    output: { text: 12, audio: 12 },
    audioTokensPerSecond: 25,
    asOf: "2026-10-08",
  },
  "google:gemini-3.1-flash-tts-preview": {
    kind: "tokens",
    input: { text: 1 },
    output: { text: 20, audio: 20 },
    audioTokensPerSecond: 25,
    asOf: "2026-10-08",
    note: "deprecated, shutdown 2026-11-17",
  },
  // Cloud Text-to-Speech per character (monthly free tiers are ignored → never under-estimates)
  "google:cloudtts-standard": { kind: "tts", perMillionChars: 4, asOf: "2026-10-08" },
  "google:cloudtts-wavenet": { kind: "tts", perMillionChars: 4, asOf: "2026-10-08" },
  "google:cloudtts-neural2": { kind: "tts", perMillionChars: 16, asOf: "2026-10-08" },
  "google:cloudtts-polyglot": { kind: "tts", perMillionChars: 16, asOf: "2026-10-08" },
  "google:cloudtts-chirp3-hd": { kind: "tts", perMillionChars: 30, asOf: "2026-10-08" },
  "google:cloudtts-studio": { kind: "tts", perMillionChars: 160, asOf: "2026-10-08" },
  // transcription
  "google:gemini-3.5-transcribe": {
    kind: "tokens",
    input: { text: 2, audio: 2 },
    output: { text: 12 },
    audioTokensPerSecond: 25,
    asOf: "2026-10-08",
    note: "Agent Platform rate; Gemini API rate not seen verbatim",
  },
  "google:gemini-3.5-transcribe-preview": {
    kind: "tokens",
    input: { text: 2, audio: 2 },
    output: { text: 12 },
    audioTokensPerSecond: 25,
    asOf: "2026-10-08",
  },
  "google:chirp_3": { kind: "stt", perMinute: 0.016, billingIncrementSeconds: 1, asOf: "2026-10-08" },
  "google:chirp_2": { kind: "stt", perMinute: 0.016, billingIncrementSeconds: 1, asOf: "2026-10-08" },
  "google:long": { kind: "stt", perMinute: 0.016, billingIncrementSeconds: 1, asOf: "2026-10-08" },
  "google:short": { kind: "stt", perMinute: 0.016, billingIncrementSeconds: 1, asOf: "2026-10-08" },
  // embeddings (input only, no output charge)
  "google:gemini-embedding-2": {
    kind: "tokens",
    input: { text: 0.2, image: 0.45, audio: 6.5, video: 12 },
    output: { text: 0 },
    asOf: "2026-10-08",
  },
  "google:gemini-embedding-001": {
    kind: "tokens",
    input: { text: 0.15 },
    output: { text: 0 },
    asOf: "2026-10-08",
  },
  // Veo — Agent Platform (Vertex) GA ids: 720p default, video-only rate when generateAudio=false
  "google:veo-3.1-fast-generate-001": {
    kind: "video",
    perSecond: 0.1,
    perSecondNoAudio: 0.08,
    minSeconds: 4,
    byResolution: {
      "1080p": { perSecond: 0.12, perSecondNoAudio: 0.1 },
      "4k": { perSecond: 0.3, perSecondNoAudio: 0.25 },
    },
    asOf: "2026-10-08",
    note: "Agent Platform; retirement on or after 2026-11-17",
  },
  "google:veo-3.1-generate-001": {
    kind: "video",
    perSecond: 0.4,
    perSecondNoAudio: 0.2,
    minSeconds: 4,
    byResolution: {
      "1080p": { perSecond: 0.4, perSecondNoAudio: 0.2 },
      "4k": { perSecond: 0.6, perSecondNoAudio: 0.4 },
    },
    asOf: "2026-10-08",
  },
  "google:veo-3.1-lite-generate-001": {
    kind: "video",
    perSecond: 0.05,
    perSecondNoAudio: 0.03,
    minSeconds: 4,
    byResolution: { "1080p": { perSecond: 0.08, perSecondNoAudio: 0.05 } },
    asOf: "2026-10-08",
    note: "Preview",
  },
  // Veo — Gemini API previews (audio always on; shutdown 2026-10-22)
  "google:veo-3.1-fast-generate-preview": {
    kind: "video",
    perSecond: 0.1,
    minSeconds: 4,
    byResolution: { "1080p": { perSecond: 0.12 }, "4k": { perSecond: 0.3 } },
    asOf: "2026-10-08",
  },
  "google:veo-3.1-generate-preview": {
    kind: "video",
    perSecond: 0.4,
    minSeconds: 4,
    byResolution: { "1080p": { perSecond: 0.4 }, "4k": { perSecond: 0.6 } },
    asOf: "2026-10-08",
  },
  "google:veo-3.1-lite-generate-preview": {
    kind: "video",
    perSecond: 0.05,
    minSeconds: 4,
    byResolution: { "1080p": { perSecond: 0.08 } },
    asOf: "2026-10-08",
  },
};

/** Fallback used when a model is missing from the catalog — deliberately pessimistic. */
const FALLBACK: Record<PriceEntry["kind"], PriceEntry> = {
  llm: { kind: "llm", inputPerMTok: 3, cachedInputPerMTok: 3, outputPerMTok: 15, asOf: "fallback" },
  image: { kind: "image", perImage: 0.08, asOf: "fallback" },
  video: { kind: "video", perSecond: 0.5, minSeconds: 5, asOf: "fallback" },
  tts: { kind: "tts", perMillionChars: 300, asOf: "fallback" },
  bg_removal: { kind: "bg_removal", perImage: 0.02, asOf: "fallback" },
  // the most expensive rate of every modality / tier seen across the Gemini family
  tokens: {
    kind: "tokens",
    input: { text: 3, image: 3, audio: 6.5, video: 12 },
    cachedInputPerMTok: 3,
    output: { text: 15, image: 120, audio: 20 },
    imageTokens: { "512": 2000, "1K": 2000, "2K": 2000, "4K": 3780 },
    audioTokensPerSecond: 32,
    asOf: "fallback",
  },
  music: { kind: "music", perSong: 0.5, asOf: "fallback" },
  stt: { kind: "stt", perMinute: 0.05, billingIncrementSeconds: 15, asOf: "fallback" },
};

/**
 * Catalog entry in force at `at`: the base key, replaced by the latest "<key>@YYYY-MM-DD" entry whose date has
 * been reached (scheduled price changes, e.g. the end of an introductory price).
 */
function entryAt(key: string, at: Date): PriceEntry | undefined {
  let entry = PRICING[key];
  let from = "";
  const today = at.toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(PRICING)) {
    if (!k.startsWith(`${key}@`)) continue;
    const date = k.slice(key.length + 1);
    if (date <= today && date > from) {
      entry = v;
      from = date;
    }
  }
  return entry;
}

export function getPrice<K extends PriceEntry["kind"]>(
  provider: string,
  model: string,
  kind: K,
  at: Date = new Date(),
): Extract<PriceEntry, { kind: K }> & { isFallback: boolean } {
  const entry = entryAt(`${provider}:${model}`, at);
  if (entry && entry.kind === kind)
    return { ...(entry as Extract<PriceEntry, { kind: K }>), isFallback: false };
  return { ...(FALLBACK[kind] as Extract<PriceEntry, { kind: K }>), isFallback: true };
}

export interface LlmUsageForCost {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export function llmCostMicros(provider: string, model: string, usage: LlmUsageForCost): Micros {
  const p = getPrice(provider, model, "llm");
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const usd =
    (uncached * p.inputPerMTok + cached * p.cachedInputPerMTok + usage.outputTokens * p.outputPerMTok) /
    1_000_000;
  return usdToMicros(usd);
}

export function imageCostMicros(
  provider: string,
  model: string,
  req: { width: number; height: number; count?: number },
): Micros {
  const p = getPrice(provider, model, "image");
  const count = req.count ?? 1;
  const megapixels = Math.max(1, Math.ceil((req.width * req.height) / 1_000_000));
  const perImage = p.perImage ?? (p.perMegapixel ?? 0) * megapixels;
  return usdToMicros(perImage * count);
}

export function videoCostMicros(
  provider: string,
  model: string,
  req: { seconds: number; withAudio?: boolean; resolution?: string },
): Micros {
  const p = getPrice(provider, model, "video");
  const seconds = Math.max(p.minSeconds, Math.ceil(req.seconds));
  const tier = (req.resolution && p.byResolution?.[req.resolution.toLowerCase()]) || p;
  const rate = req.withAudio === false ? (tier.perSecondNoAudio ?? tier.perSecond) : tier.perSecond;
  return usdToMicros(seconds * rate);
}

export function ttsCostMicros(provider: string, model: string, req: { characters: number }): Micros {
  const p = getPrice(provider, model, "tts");
  return usdToMicros((req.characters * p.perMillionChars) / 1_000_000);
}

export function bgRemovalCostMicros(provider: string, model: string, req: { count?: number } = {}): Micros {
  const p = getPrice(provider, model, "bg_removal");
  return usdToMicros(p.perImage * (req.count ?? 1));
}

/* ---------------------------------------------------------------- multimodal tokens / music / STT --- */

export type TokenModality = "text" | "image" | "audio" | "video" | "document";

/** Provider-reported token usage split by modality (unknown splits go to `*Unspecified`). */
export interface TokenUsageForCost {
  input?: Partial<Record<TokenModality, number>>;
  /** input tokens without a modality breakdown — billed at the highest input rate (pessimistic) */
  inputUnspecified?: number;
  /** part of the input served from the context cache */
  cachedInput?: number;
  output?: Partial<Record<"text" | "image" | "audio", number>>;
  /** output tokens without a modality breakdown — billed at the highest output rate (pessimistic) */
  outputUnspecified?: number;
  /** thinking tokens (billed at the text output rate) */
  thoughts?: number;
}

export function tokenCostMicros(
  provider: string,
  model: string,
  usage: TokenUsageForCost,
  at: Date = new Date(),
): Micros {
  const p = getPrice(provider, model, "tokens", at);
  const inRate = (m: TokenModality) =>
    m === "text" || m === "document" ? p.input.text : (p.input[m] ?? p.input.text);
  const maxIn = Math.max(p.input.text, p.input.image ?? 0, p.input.audio ?? 0, p.input.video ?? 0);
  const maxOut = Math.max(p.output.text, p.output.image ?? 0, p.output.audio ?? 0);
  const cachedRate = p.cachedInputPerMTok ?? p.input.text;
  let cached = Math.max(0, usage.cachedInput ?? 0);
  let usd = 0;
  // cached tokens are taken out of the text input first (context caches are mostly text)
  for (const [m, n] of Object.entries(usage.input ?? {}) as [TokenModality, number][]) {
    const fromCache = m === "text" || m === "document" ? Math.min(cached, n) : 0;
    cached -= fromCache;
    usd += (n - fromCache) * inRate(m) + fromCache * cachedRate;
  }
  const unspecified = Math.max(0, usage.inputUnspecified ?? 0);
  const fromCache = Math.min(cached, unspecified);
  usd += (unspecified - fromCache) * maxIn + fromCache * cachedRate;
  for (const [m, n] of Object.entries(usage.output ?? {}) as ["text" | "image" | "audio", number][]) {
    usd += n * (p.output[m] ?? p.output.text);
  }
  usd += Math.max(0, usage.outputUnspecified ?? 0) * maxOut;
  usd += Math.max(0, usage.thoughts ?? 0) * p.output.text;
  return usdToMicros(usd / 1_000_000);
}

export function musicCostMicros(
  provider: string,
  model: string,
  req: { count?: number; seconds?: number } = {},
): Micros {
  const p = getPrice(provider, model, "music");
  const count = req.count ?? 1;
  if (p.perSong !== undefined) return usdToMicros(p.perSong * count);
  return usdToMicros((p.perSecond ?? 0) * Math.ceil(req.seconds ?? 0) * count);
}

export function sttCostMicros(provider: string, model: string, req: { seconds: number }): Micros {
  const p = getPrice(provider, model, "stt");
  const inc = Math.max(1, p.billingIncrementSeconds);
  const billed = Math.ceil(Math.max(0, req.seconds) / inc) * inc;
  return usdToMicros((billed / 60) * p.perMinute);
}
