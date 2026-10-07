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
}
export interface TtsPrice {
  kind: "tts";
  perMillionChars: number;
}
export interface BgRemovalPrice {
  kind: "bg_removal";
  perImage: number;
}
export type PriceEntry = (LlmPrice | ImagePrice | VideoPrice | TtsPrice | BgRemovalPrice) & {
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
};

/** Fallback used when a model is missing from the catalog — deliberately pessimistic. */
const FALLBACK: Record<PriceEntry["kind"], PriceEntry> = {
  llm: { kind: "llm", inputPerMTok: 3, cachedInputPerMTok: 3, outputPerMTok: 15, asOf: "fallback" },
  image: { kind: "image", perImage: 0.08, asOf: "fallback" },
  video: { kind: "video", perSecond: 0.5, minSeconds: 5, asOf: "fallback" },
  tts: { kind: "tts", perMillionChars: 300, asOf: "fallback" },
  bg_removal: { kind: "bg_removal", perImage: 0.02, asOf: "fallback" },
};

export function getPrice<K extends PriceEntry["kind"]>(
  provider: string,
  model: string,
  kind: K,
): Extract<PriceEntry, { kind: K }> & { isFallback: boolean } {
  const entry = PRICING[`${provider}:${model}`];
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

export function videoCostMicros(provider: string, model: string, req: { seconds: number }): Micros {
  const p = getPrice(provider, model, "video");
  const seconds = Math.max(p.minSeconds, Math.ceil(req.seconds));
  return usdToMicros(seconds * p.perSecond);
}

export function ttsCostMicros(provider: string, model: string, req: { characters: number }): Micros {
  const p = getPrice(provider, model, "tts");
  return usdToMicros((req.characters * p.perMillionChars) / 1_000_000);
}

export function bgRemovalCostMicros(provider: string, model: string, req: { count?: number } = {}): Micros {
  const p = getPrice(provider, model, "bg_removal");
  return usdToMicros(p.perImage * (req.count ?? 1));
}
