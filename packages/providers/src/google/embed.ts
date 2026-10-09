import { FatalError } from "@cre/shared";
import type { RestPart } from "./gemini.ts";
import { InlineBudget, readInline } from "./media.ts";
import type { GoogleEmbedItem } from "./types.ts";

/*
 * gemini-embedding-2 via `models/{model}:batchEmbedContents` (one Content per item → one vector per item; parts
 * inside one Content are aggregated into ONE vector). Per-request config goes in `embedContentConfig`
 * (discovery rev 20261008 deprecates the top-level outputDimensionality / taskType). gemini-embedding-2 has no
 * task types — retrieval is tuned with text prefixes; gemini-embedding-001 (text only) still uses taskType.
 */

export type EmbedRole = "query" | "document";

/** Gemini API batch limits: 100 requests per call; inline media counted against the request-size budget. */
export const EMBED_MAX_BATCH = 100;

export function usesTaskType(model: string): boolean {
  return /^(gemini-embedding-001|text-embedding-)/.test(model);
}

/** Task prefixes of gemini-embedding-2 (query vs document). */
export function embedText(text: string, role: EmbedRole, model: string): string {
  if (usesTaskType(model)) return text;
  return role === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
}

export interface EmbedRestRequest {
  model: string;
  content: { parts: RestPart[] };
  embedContentConfig: { outputDimensionality: number; taskType?: string };
}

export async function embedRequest(
  item: GoogleEmbedItem,
  opts: { model: string; dimensions: number; role: EmbedRole; budget: InlineBudget },
): Promise<EmbedRestRequest> {
  const parts: RestPart[] = [];
  if (item.text?.trim()) parts.push({ text: embedText(item.text.trim(), opts.role, opts.model) });
  for (const file of [item.imagePath, item.audioPath, item.videoPath]) {
    if (!file) continue;
    const { data, mimeType } = await readInline(file, opts.budget);
    parts.push({ inlineData: { mimeType, data: data.toString("base64") } });
  }
  if (!parts.length) throw new FatalError(`embedding item ${item.id} has no content`);
  if (parts.length > 1 && usesTaskType(opts.model)) {
    throw new FatalError(`${opts.model} embeds text only (item ${item.id} has media)`);
  }
  return {
    model: `models/${opts.model}`,
    content: { parts },
    embedContentConfig: {
      outputDimensionality: opts.dimensions,
      ...(usesTaskType(opts.model)
        ? { taskType: opts.role === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" }
        : {}),
    },
  };
}

/**
 * Group items into batch calls: at most EMBED_MAX_BATCH requests and `maxInlineBytes` of media per call. An
 * item that alone exceeds the budget fails in `embedRequest` (InlineBudget) with a clear message.
 */
export async function planEmbedBatches(
  items: readonly GoogleEmbedItem[],
  opts: { model: string; dimensions: number; role: EmbedRole; maxInlineBytes: number },
): Promise<{ ids: string[]; requests: EmbedRestRequest[] }[]> {
  const batches: { ids: string[]; requests: EmbedRestRequest[] }[] = [];
  let current = { ids: [] as string[], requests: [] as EmbedRestRequest[] };
  let used = 0;
  for (const item of items) {
    const probe = new InlineBudget(opts.maxInlineBytes);
    const req = await embedRequest(item, { ...opts, budget: probe });
    const bytes = inlineBytes(req);
    if (current.requests.length >= EMBED_MAX_BATCH || (used + bytes > opts.maxInlineBytes && used > 0)) {
      batches.push(current);
      current = { ids: [], requests: [] };
      used = 0;
    }
    current.ids.push(item.id);
    current.requests.push(req);
    used += bytes;
  }
  if (current.requests.length) batches.push(current);
  return batches;
}

function inlineBytes(req: EmbedRestRequest): number {
  // base64 length × 3/4 ≈ raw bytes (the budget is defined on raw bytes)
  return req.content.parts.reduce((s, p) => s + Math.ceil(((p.inlineData?.data.length ?? 0) * 3) / 4), 0);
}

/** Truncate to `dimensions` (Matryoshka) and L2-normalise (gemini-embedding-001 does not normalise). */
export function normalizeVector(values: readonly number[], dimensions: number): number[] {
  const v = values.slice(0, dimensions);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}
