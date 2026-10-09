import { FatalError, ProviderError } from "@cre/shared";
import type { UsageMetadata } from "./cost.ts";
import { type InlineBudget, readInline } from "./media.ts";
import { GOOGLE_PROVIDER } from "./transport.ts";
import type { GeminiPart, MediaResolution, ThinkingLevel } from "./types.ts";

/*
 * Gemini API generateContent (v1beta) wire format — the ONLY place its field names live. Checked against the
 * generativelanguage v1beta discovery document (revision 20261008): GenerationConfig.responseJsonSchema,
 * thinkingConfig.thinkingLevel (MINIMAL|LOW|MEDIUM|HIGH), mediaResolution (MEDIA_RESOLUTION_*), imageConfig
 * {aspectRatio, imageSize}, speechConfig {voiceConfig.voice, languageCode}, audioTranscriptionConfig
 * {wordTimestamp, languageCodes, mode}, Part.speechMetadata.style and Part.audioTranscription.words.
 *
 * Deliberately NOT sent: temperature / topP / topK / candidateCount (deprecated for Gemini 3.5+), thinkingBudget
 * (400 together with thinkingLevel), responseSchema (deprecated in favour of responseJsonSchema).
 * Not used yet: generationConfig.responseFormat (newer per-modality form; responseJsonSchema / imageConfig are
 * still documented and working — switch here if Google retires them).
 */

export const THINKING_LEVEL: Record<ThinkingLevel, string> = {
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
};

export const MEDIA_RESOLUTION: Record<MediaResolution, string> = {
  low: "MEDIA_RESOLUTION_LOW",
  medium: "MEDIA_RESOLUTION_MEDIUM",
  high: "MEDIA_RESOLUTION_HIGH",
};

export interface RestBlob {
  mimeType: string;
  /** base64 */
  data: string;
}

export interface RestWordInfo {
  word?: string;
  startOffset?: unknown;
  endOffset?: unknown;
}

export interface RestPart {
  text?: string;
  inlineData?: RestBlob;
  thought?: boolean;
  speechMetadata?: { style?: string; speaker?: string };
  audioTranscription?: { text?: string; words?: RestWordInfo[] };
}

export interface RestContent {
  role?: "user" | "model";
  parts: RestPart[];
}

export interface GenerateContentResponse {
  candidates?: {
    content?: { parts?: RestPart[] };
    finishReason?: string;
    finishMessage?: string;
  }[];
  usageMetadata?: UsageMetadata;
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  modelVersion?: string;
}

/** Model ids come from configuration, but they still end up in a URL path: allow plain ids only. */
export function assertModelId(model: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {
    throw new FatalError(`invalid Google model id: ${JSON.stringify(model.slice(0, 80))}`);
  }
  return model;
}

export function modelUrl(baseUrl: string, model: string, method: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1beta/models/${assertModelId(model)}:${method}`;
}

/** GeminiPart (text / local file / bytes) → REST part; files are size-checked against the request budget. */
export async function toRestPart(part: GeminiPart, budget: InlineBudget): Promise<RestPart> {
  if ("text" in part) return { text: part.text };
  if ("bytes" in part) {
    budget.add(part.bytes.length, "inline bytes");
    return { inlineData: { mimeType: part.mimeType, data: part.bytes.toString("base64") } };
  }
  const { data, mimeType } = await readInline(part.file, budget, part.mimeType);
  return { inlineData: { mimeType, data: data.toString("base64") } };
}

export async function toRestParts(parts: readonly GeminiPart[], budget: InlineBudget): Promise<RestPart[]> {
  const out: RestPart[] = [];
  for (const p of parts) out.push(await toRestPart(p, budget));
  return out;
}

export function userContent(parts: RestPart[]): RestContent[] {
  return [{ role: "user", parts }];
}

/** Text parts of the first candidate, without thought summaries. */
export function candidateText(res: GenerateContentResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/** Inline media the model returned (images, audio), in order. */
export function inlineOutputs(res: GenerateContentResponse): { mimeType: string; data: Buffer }[] {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p): p is RestPart & { inlineData: RestBlob } => Boolean(p.inlineData?.data) && !p.thought)
    .map((p) => ({ mimeType: p.inlineData.mimeType, data: Buffer.from(p.inlineData.data, "base64") }));
}

/** finish reasons that mean "content policy said no" — retrying the same request will not help */
const BLOCKED_FINISH = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

/**
 * A failed call that may still have been billed: the cost travels in `details.costMicros`, so capability
 * wrappers can record the spend before falling back.
 */
export function billedError(
  message: string,
  opts: { code: string; retryable: boolean; costMicros: number; details?: Record<string, unknown> },
): ProviderError {
  return new ProviderError(GOOGLE_PROVIDER, message, {
    code: opts.code,
    retryable: opts.retryable,
    charged: opts.costMicros > 0,
    details: { ...opts.details, costMicros: opts.costMicros },
  });
}

/** micro-USD a failed Google call was billed (0 when unknown / not billed). */
export function billedCostOf(err: unknown): number {
  if (!(err instanceof ProviderError)) return 0;
  const c = err.details?.costMicros;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? Math.round(c) : 0;
}

/** Throws a non-retryable ProviderError when the prompt or the output was blocked by Google's filters. */
export function assertNotBlocked(res: GenerateContentResponse, label: string, costMicros: number): void {
  const block = res.promptFeedback?.blockReason;
  if (block && block !== "BLOCK_REASON_UNSPECIFIED") {
    throw billedError(
      `${label}: prompt blocked (${block})${suffix(res.promptFeedback?.blockReasonMessage)}`,
      {
        code: "CONTENT_BLOCKED",
        retryable: false,
        costMicros,
        details: { blockReason: block },
      },
    );
  }
  const finish = res.candidates?.[0]?.finishReason;
  if (finish && BLOCKED_FINISH.has(finish)) {
    throw billedError(`${label}: output blocked (${finish})${suffix(res.candidates?.[0]?.finishMessage)}`, {
      code: "CONTENT_BLOCKED",
      retryable: false,
      costMicros,
      details: { finishReason: finish },
    });
  }
  if (!res.candidates?.length) {
    throw billedError(`${label}: no candidates returned`, {
      code: "EMPTY_RESPONSE",
      retryable: true,
      costMicros,
    });
  }
}

function suffix(msg: string | undefined): string {
  return msg ? `: ${msg.slice(0, 200)}` : "";
}

/**
 * Parse structured output. responseMimeType application/json returns bare JSON; a markdown fence is tolerated
 * (some models add one when the schema is large). Callers still validate with zod.
 */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? (fenced[1] ?? "") : trimmed) as unknown;
}
