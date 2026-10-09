import type { Env } from "@cre/config";
import { usesTaskType, type GoogleAI } from "@cre/providers";
import type { CallContext, EmbedItem, EmbeddingProvider } from "../../capabilities/types.ts";
import { FileCache, cacheKey, fileSha256 } from "../../util/cache.ts";
import { paid, recordCacheHit, recordCall } from "./common.ts";

/*
 * gemini-embedding-2: one vector space for text, images, audio and video (asset retrieval). Vectors are cached
 * per item (content hashes of the files, the text, model, dimensions and role), so re-indexing an asset
 * library only pays for new or changed assets. Queries and documents use different task prefixes — the
 * EmbeddingProvider contract has no role, so there is one provider instance per role.
 */

export const EMBEDDING_VERSION = "gemini-embedding/1";
const NS = "google.embedding";

export type EmbedRole = "query" | "document";

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly capability = "embedding" as const;
  readonly local = false;
  readonly model: string;
  readonly dimensions: number;
  readonly modalities: readonly ("text" | "image" | "audio" | "video")[];
  readonly role: EmbedRole;

  constructor(
    env: Pick<Env, "GOOGLE_EMBEDDING_MODEL" | "GOOGLE_EMBEDDING_DIMENSIONS">,
    private readonly ai: GoogleAI,
    opts: { role?: EmbedRole } = {},
  ) {
    this.model = env.GOOGLE_EMBEDDING_MODEL;
    this.dimensions = env.GOOGLE_EMBEDDING_DIMENSIONS;
    this.role = opts.role ?? "document";
    this.name = this.role === "query" ? "gemini-embedding-query" : "gemini-embedding";
    this.modalities = usesTaskType(this.model) ? ["text"] : ["text", "image", "audio", "video"];
  }

  /** the same model / dimensions for search queries (same vector space, query task prefix) */
  forQueries(): GoogleEmbeddingProvider {
    return this.role === "query"
      ? this
      : new GoogleEmbeddingProvider(
          { GOOGLE_EMBEDDING_MODEL: this.model, GOOGLE_EMBEDDING_DIMENSIONS: this.dimensions },
          this.ai,
          { role: "query" },
        );
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve(
      this.ai.hasApiKey ? { ok: true } : { ok: false, reason: "GOOGLE_API_KEY is not configured" },
    );
  }

  estimateMicros(items: EmbedItem[]): number {
    return this.ai.estimateEmbedMicros(this.model, items);
  }

  async embed(items: EmbedItem[], ctx: CallContext): Promise<{ id: string; vector: number[] }[]> {
    if (!items.length) return [];
    const cache = new FileCache(ctx.cacheDir);
    const keys = await Promise.all(items.map((item) => this.itemKey(item)));
    const vectors: (number[] | undefined)[] = await Promise.all(
      keys.map(async (key) => {
        const v = await cache.readJson<number[]>(NS, key, "vector.json");
        return Array.isArray(v) && v.length === this.dimensions ? v : undefined;
      }),
    );
    const missing = items.map((item, i) => ({ item, i })).filter(({ i }) => vectors[i] === undefined);
    const hits = items.length - missing.length;
    if (hits > 0) recordCacheHit(ctx, "embedding", this.model, { items: hits });
    if (missing.length) {
      // request ids are positional so duplicate item ids still map back correctly
      const res = await paid(ctx, "embedding", this.model, () =>
        this.ai.embed({
          model: this.model,
          dimensions: this.dimensions,
          role: this.role,
          items: missing.map(({ item, i }) => ({ ...item, id: String(i) })),
          label: `reel.embedding.${this.role}`,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }),
      );
      recordCall(ctx, {
        capability: "embedding",
        model: this.model,
        costMicros: res.costMicros,
        estimated: res.costEstimated,
        usage: res.usage,
        units: { items: missing.length },
        latencyMs: res.latencyMs,
      });
      for (const { id, vector } of res.vectors) {
        const i = Number(id);
        const key = keys[i];
        if (key === undefined) continue;
        vectors[i] = vector;
        await cache.writeJson(NS, key, vector, "vector.json");
      }
    }
    return items.map((item, i) => {
      const vector = vectors[i];
      if (!vector) throw new Error(`embedding missing for item ${item.id}`);
      return { id: item.id, vector };
    });
  }

  private async itemKey(item: EmbedItem): Promise<string> {
    const sha = async (p: string | undefined) => (p ? await fileSha256(p) : undefined);
    return cacheKey(NS, EMBEDDING_VERSION, {
      model: this.model,
      dimensions: this.dimensions,
      role: this.role,
      text: item.text?.trim() ?? null,
      image: (await sha(item.imagePath)) ?? null,
      audio: (await sha(item.audioPath)) ?? null,
      video: (await sha(item.videoPath)) ?? null,
    });
  }
}
