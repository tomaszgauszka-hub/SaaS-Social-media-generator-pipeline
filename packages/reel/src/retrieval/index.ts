import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { textSimilarity } from "@cre/shared";
import type { ProductProfile } from "../contracts/product.ts";

/**
 * Asset library + retrieval: studio renders, plates, sequences, music, SFX, backgrounds, models, voices and
 * images that already exist are found before anything is made. Lexical scoring (tags + trigram text similarity)
 * always works; multimodal embeddings (Gemini Embedding) refine the ranking when vectors exist for the
 * configured model. No LLM is ever called here.
 */

export const ASSET_KINDS = [
  "render",
  "plate",
  "sequence",
  "studio",
  "music",
  "sfx",
  "background",
  "model",
  "voice",
  "image",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface AssetEntry {
  id: string;
  kind: AssetKind;
  tags: string[];
  /** one-line description (what the director sees) */
  text: string;
  path: string;
  meta: Record<string, unknown>;
  /** model key ("<model>@<dims>") → vector */
  vectors?: Record<string, number[]>;
  createdAt: string;
}

export interface SearchQuery {
  text?: string;
  tags?: string[];
  kinds?: AssetKind[];
  /** exact meta match (e.g. { productModelSha }) */
  meta?: Record<string, unknown>;
  vector?: { key: string; values: number[] };
  limit?: number;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function tagScore(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a.map((t) => t.toLowerCase()));
  const hits = b.filter((t) => sa.has(t.toLowerCase())).length;
  return hits / new Set([...sa, ...b.map((t) => t.toLowerCase())]).size;
}

export class AssetIndex {
  private readonly file: string;
  private entries: AssetEntry[] | null = null;

  constructor(cacheDir: string) {
    this.file = path.join(cacheDir, "assets", "index.json");
  }

  list(kind?: AssetKind): AssetEntry[] {
    this.entries ??= fs.existsSync(this.file)
      ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as AssetEntry[])
      : [];
    return kind ? this.entries.filter((e) => e.kind === kind) : [...this.entries];
  }

  async upsert(items: Omit<AssetEntry, "createdAt">[]): Promise<void> {
    const all = this.list();
    for (const it of items) {
      const i = all.findIndex((e) => e.id === it.id);
      const entry = { ...it, createdAt: i >= 0 ? all[i]!.createdAt : new Date().toISOString() };
      if (i >= 0) all[i] = { ...all[i]!, ...entry, vectors: { ...all[i]!.vectors, ...it.vectors } };
      else all.push(entry);
    }
    this.entries = all;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(all, null, 1));
    await fsp.rename(tmp, this.file);
  }

  search(q: SearchQuery): (AssetEntry & { score: number })[] {
    return this.list()
      .filter((e) => !q.kinds || q.kinds.includes(e.kind))
      .filter((e) => !q.meta || Object.entries(q.meta).every(([k, v]) => e.meta[k] === v))
      .filter((e) => fs.existsSync(e.path))
      .map((e) => {
        const lexical =
          0.6 * tagScore(e.tags, q.tags ?? []) + 0.4 * (q.text ? textSimilarity(q.text, e.text) : 0);
        const v = q.vector && e.vectors?.[q.vector.key];
        const score = v ? 0.5 * lexical + 0.5 * Math.max(0, cosine(q.vector!.values, v)) : lexical;
        return { ...e, score: Math.round(score * 1000) / 1000 };
      })
      .filter((e) => e.score > 0 || Boolean(q.meta))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, q.limit ?? 10);
  }
}

export interface Retrieved {
  /** shown to the director (ids + one-line descriptions) */
  assets: { id: string; kind: string; description: string; score: number }[];
  /** studio renders that already exist for this exact 3D model */
  renders: AssetEntry[];
}

export class AssetRetriever {
  constructor(private readonly index: AssetIndex) {}

  /**
   * `embedQuery` (optional) returns a query vector — the caller runs it through its capability chain and
   * budget gate; undefined (no provider, over budget, failed) means lexical / tag search only.
   */
  async retrieveFor(
    profile: ProductProfile,
    needs: { productModelSha?: string | undefined; limit?: number } = {},
    embedQuery?: (text: string) => Promise<SearchQuery["vector"]>,
  ): Promise<Retrieved> {
    const text = [profile.shortName, profile.category, ...profile.visual_features].join(" ");
    const tags = [
      profile.category,
      profile.productId,
      ...profile.visual_features.flatMap((v) => v.split(/\s+/)),
    ];
    const vector = embedQuery ? await embedQuery(text) : undefined;
    const renders = needs.productModelSha
      ? this.index.search({
          kinds: ["render", "plate", "sequence"],
          meta: { productModelSha: needs.productModelSha },
          limit: 50,
        })
      : [];
    const assets = this.index.search({
      text,
      tags,
      kinds: ["music", "sfx", "background", "studio"],
      ...(vector ? { vector } : {}),
      limit: needs.limit ?? 8,
    });
    return {
      assets: [...renders.slice(0, 6), ...assets].map((a) => ({
        id: a.id,
        kind: a.kind,
        description: a.text,
        score: a.score,
      })),
      renders,
    };
  }
}
