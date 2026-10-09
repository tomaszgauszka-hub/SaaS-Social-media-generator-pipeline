import fs from "node:fs";
import {
  getPrice,
  musicCostMicros,
  sttCostMicros,
  tokenCostMicros,
  ttsCostMicros,
  videoCostMicros,
  type ImageSizeTier,
  type TokenModality,
  type TokenUsageForCost,
} from "@cre/config";
import { GOOGLE_PROVIDER } from "./transport.ts";
import type { GeminiUsage, GoogleEmbedItem } from "./types.ts";

/*
 * Cost accounting for every Google surface, from REPORTED usage where the API returns it (usageMetadata
 * tokens per modality incl. thoughtsTokenCount at the output rate, STT billed duration, characters billed by
 * Cloud TTS) and from the pricing catalog ('google:<model>' in @cre/config) for per-song / per-second units.
 * Estimates are deliberately on the high side: they gate the budget BEFORE a call. Unknown models use the
 * catalog's pessimistic fallback — never 0.
 */

/** usageMetadata of generateContent / embedContent (only the fields the cost needs). */
export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
  promptTokensDetails?: ModalityTokenCount[];
  candidatesTokensDetails?: ModalityTokenCount[];
  /** embeddings use the singular "promptTokenDetails" */
  promptTokenDetails?: ModalityTokenCount[];
}

export interface ModalityTokenCount {
  modality?: string;
  tokenCount?: number;
}

const MODALITY: Record<string, TokenModality> = {
  TEXT: "text",
  IMAGE: "image",
  AUDIO: "audio",
  VIDEO: "video",
  DOCUMENT: "document",
};

function byModality(details: ModalityTokenCount[] | undefined): {
  map: Partial<Record<TokenModality, number>>;
  total: number;
} {
  const map: Partial<Record<TokenModality, number>> = {};
  let total = 0;
  for (const d of details ?? []) {
    const m = MODALITY[(d.modality ?? "").toUpperCase()];
    const n = Math.max(0, d.tokenCount ?? 0);
    if (!m || !n) continue;
    map[m] = (map[m] ?? 0) + n;
    total += n;
  }
  return { map, total };
}

/** usageMetadata → pricing usage; anything without a modality split is billed at the highest rate. */
export function usageForCost(u: UsageMetadata): TokenUsageForCost {
  const prompt = (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0);
  const inDetails = byModality(u.promptTokensDetails ?? u.promptTokenDetails);
  const candidates = u.candidatesTokenCount ?? 0;
  const outDetails = byModality(u.candidatesTokensDetails);
  const output: TokenUsageForCost["output"] = {};
  for (const [m, n] of Object.entries(outDetails.map)) {
    if (m === "text" || m === "image" || m === "audio") output[m] = n;
    else output.text = (output.text ?? 0) + n;
  }
  return {
    input: inDetails.map,
    inputUnspecified: Math.max(0, prompt - inDetails.total),
    cachedInput: u.cachedContentTokenCount ?? 0,
    output,
    outputUnspecified: Math.max(0, candidates - outDetails.total),
    thoughts: u.thoughtsTokenCount ?? 0,
  };
}

export function geminiUsage(u: UsageMetadata | undefined): GeminiUsage {
  return {
    inputTokens: (u?.promptTokenCount ?? 0) + (u?.toolUsePromptTokenCount ?? 0),
    outputTokens: u?.candidatesTokenCount ?? 0,
    thoughtsTokens: u?.thoughtsTokenCount ?? 0,
    cachedTokens: u?.cachedContentTokenCount ?? 0,
  };
}

export function hasUsage(u: UsageMetadata | undefined): u is UsageMetadata {
  return Boolean(u && ((u.promptTokenCount ?? 0) > 0 || (u.candidatesTokenCount ?? 0) > 0));
}

/** Cost of one generateContent / embedContent call from its usageMetadata. */
export function usageCostMicros(model: string, u: UsageMetadata, at?: Date): number {
  return tokenCostMicros(GOOGLE_PROVIDER, model, usageForCost(u), at);
}

/* ---------------------------------------------------------------- estimates ----------------------- */

/** Rough text tokens of a string (≈ 4 characters per token for Latin scripts; rounded up). */
export function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateGenerateMicros(model: string, inputTokens: number, outputTokens: number): number {
  // thinking is billed as output; the estimate assumes the caller's output budget covers it
  return tokenCostMicros(GOOGLE_PROVIDER, model, {
    inputUnspecified: Math.max(0, inputTokens),
    output: { text: Math.max(0, outputTokens) },
  });
}

/** prompt + thinking allowance for image calls (thinking is billed at the text output rate) */
const IMAGE_PROMPT_TOKENS = 1_200;
const IMAGE_THINKING_TOKENS = 1_000;
/** Gemini 3 default image input resolution when none is set (high = 1 120 tokens) */
const REFERENCE_IMAGE_TOKENS = 1_120;

export function estimateImageMicros(model: string, imageSize: ImageSizeTier, referenceCount = 0): number {
  const p = getPrice(GOOGLE_PROVIDER, model, "tokens");
  const imageTokens = p.imageTokens?.[imageSize] ?? Math.max(...Object.values(p.imageTokens ?? { x: 2000 }));
  return tokenCostMicros(GOOGLE_PROVIDER, model, {
    input: { text: IMAGE_PROMPT_TOKENS, image: referenceCount * REFERENCE_IMAGE_TOKENS },
    output: { image: imageTokens },
    thoughts: IMAGE_THINKING_TOKENS,
  });
}

export function estimateMusicMicros(model: string): number {
  return musicCostMicros(GOOGLE_PROVIDER, model, { count: 1, seconds: 180 });
}

/** speech rate used to size audio output: slow reads (~12 characters per second incl. spaces) */
const CHARS_PER_SECOND = 12;
const TTS_STYLE_TOKENS = 80;

/** Cloud TTS voice family of a voice name ("pl-PL-Wavenet-A" → "cloudtts-wavenet"), undefined for models. */
export function cloudTtsFamily(voiceName: string): string | undefined {
  const m = /^[a-z]{2,3}-[A-Z]{2,3}-([A-Za-z0-9]+)(?:-HD)?-/.exec(voiceName);
  if (!m) return undefined;
  const fam = (m[1] ?? "").toLowerCase();
  if (fam === "chirp3" || fam === "chirp3hd") return "cloudtts-chirp3-hd";
  if (["standard", "wavenet", "neural2", "polyglot", "studio"].includes(fam)) return `cloudtts-${fam}`;
  // News / Casual / unknown families: price as Studio (the most expensive per-character voice)
  return "cloudtts-studio";
}

export function estimateSpeechMicros(model: string, characters: number): number {
  const family = cloudTtsFamily(model);
  if (family) return ttsCostMicros(GOOGLE_PROVIDER, family, { characters });
  const p = getPrice(GOOGLE_PROVIDER, model, "tokens");
  const seconds = Math.ceil(characters / CHARS_PER_SECOND) + 1;
  return tokenCostMicros(GOOGLE_PROVIDER, model, {
    input: { text: Math.ceil(characters / 4) + TTS_STYLE_TOKENS },
    output: { audio: seconds * (p.audioTokensPerSecond ?? 32) },
  });
}

/** Cloud TTS characters billed for an SSML document: everything except <mark> tags. */
export function cloudTtsBilledCharacters(ssml: string): number {
  return ssml.replace(/<mark\b[^>]*\/>/g, "").length;
}

export function cloudTtsCostMicros(voiceName: string, characters: number): number {
  return ttsCostMicros(GOOGLE_PROVIDER, cloudTtsFamily(voiceName) ?? "cloudtts-studio", { characters });
}

/** Speech-to-Text v2 models (per audio second) vs Gemini transcription models (tokens). */
export function isCloudSttModel(model: string): boolean {
  return /^(chirp|long$|short$|telephony)/.test(model);
}

/** transcript + word-timestamp output allowance per audio second */
const TRANSCRIPT_TOKENS_PER_SECOND = 15;

export function estimateTranscriptionMicros(model: string, audioMs: number): number {
  const seconds = Math.max(1, Math.ceil(audioMs / 1000));
  if (isCloudSttModel(model)) return sttCostMicros(GOOGLE_PROVIDER, model, { seconds });
  const p = getPrice(GOOGLE_PROVIDER, model, "tokens");
  return tokenCostMicros(GOOGLE_PROVIDER, model, {
    input: { audio: seconds * (p.audioTokensPerSecond ?? 32), text: 50 },
    output: { text: seconds * TRANSCRIPT_TOKENS_PER_SECOND },
  });
}

export function transcriptionCostMicros(
  model: string,
  reported: { billedSeconds?: number; usage?: UsageMetadata },
  fallbackAudioMs: number,
): { costMicros: number; estimated: boolean } {
  if (isCloudSttModel(model)) {
    if (reported.billedSeconds !== undefined)
      return {
        costMicros: sttCostMicros(GOOGLE_PROVIDER, model, { seconds: reported.billedSeconds }),
        estimated: false,
      };
  } else if (hasUsage(reported.usage)) {
    return { costMicros: usageCostMicros(model, reported.usage), estimated: false };
  }
  return { costMicros: estimateTranscriptionMicros(model, fallbackAudioMs), estimated: true };
}

/* Gemini API embedding token sizes (official embeddings docs) */
const EMBED_IMAGE_TOKENS = 258;
const EMBED_AUDIO_TOKENS_PER_SECOND = 25;
const EMBED_AUDIO_MAX_SECONDS = 180;
/** at most 32 frames are sampled per video on the Gemini API, 66 tokens per frame */
const EMBED_VIDEO_TOKENS = 32 * 66;
/** ~128 kbit/s: a compressed upper bound for the length of an audio file of unknown format */
const AUDIO_BYTES_PER_SECOND = 16_000;
const EMBED_PREFIX_TOKENS = 12;

export function estimateEmbedMicros(model: string, items: GoogleEmbedItem[]): number {
  const input: Partial<Record<TokenModality, number>> = {};
  const add = (m: TokenModality, n: number) => (input[m] = (input[m] ?? 0) + n);
  for (const item of items) {
    if (item.text) add("text", textTokens(item.text) + EMBED_PREFIX_TOKENS);
    if (item.imagePath) add("image", EMBED_IMAGE_TOKENS);
    if (item.audioPath) {
      let seconds = EMBED_AUDIO_MAX_SECONDS;
      try {
        seconds = Math.min(seconds, Math.ceil(fs.statSync(item.audioPath).size / AUDIO_BYTES_PER_SECOND));
      } catch {
        /* unreadable → assume the maximum */
      }
      add("audio", seconds * EMBED_AUDIO_TOKENS_PER_SECOND);
    }
    if (item.videoPath) add("video", EMBED_VIDEO_TOKENS);
  }
  return tokenCostMicros(GOOGLE_PROVIDER, model, { input });
}

export function estimateVideoMicros(
  model: string,
  seconds: number,
  withAudio: boolean,
  resolution?: string,
): number {
  return videoCostMicros(GOOGLE_PROVIDER, model, {
    seconds,
    withAudio,
    ...(resolution ? { resolution } : {}),
  });
}
