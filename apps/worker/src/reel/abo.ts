import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { resolveFromRoot } from "@cre/config";

/**
 * Amazon Berkeley Objects (CC BY 4.0): real products with catalog records, photos and — for ~8 k of them — real
 * 3D models. Only the fixed dataset bucket is ever contacted; ids are validated before they reach a URL.
 */

const BUCKET = "https://amazon-berkeley-objects.s3.amazonaws.com";
const SHARDS = "0123456789abcdef".split("");
const ITEM_ID = /^[A-Z0-9]{10}$/;

async function download(url: string, out: string): Promise<void> {
  if (!url.startsWith(`${BUCKET}/`))
    throw new Error(`refusing to download outside the dataset bucket: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, out);
}

async function cached(rel: string, cacheDir: string): Promise<string> {
  const out = path.join(cacheDir, rel);
  if (!fs.existsSync(out)) await download(`${BUCKET}/${rel}`, out);
  return out;
}

function gunzipLines(file: string): string[] {
  return zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").split("\n").filter(Boolean);
}

const cacheDir = () => resolveFromRoot(".data/cache/abo");

export interface AboCandidate {
  itemId: string;
  name: string;
  node: string;
  images: number;
}

/**
 * Products worth a reel: they have a real 3D model (the studio shows the real product) and match a category
 * path fragment (e.g. "Table Lamps", "Lamps", "Chairs"). Deterministic order (by item id).
 */
export async function discoverAboProducts(opts: {
  nodeContains: string;
  limit: number;
  requireModel?: boolean;
}): Promise<AboCandidate[]> {
  const needle = opts.nodeContains.toLowerCase();
  const out: AboCandidate[] = [];
  for (const s of SHARDS) {
    for (const line of gunzipLines(await cached(`listings/metadata/listings_${s}.json.gz`, cacheDir()))) {
      if (opts.requireModel !== false && !line.includes('"3dmodel_id"')) continue;
      const j = JSON.parse(line) as {
        item_id?: string;
        node?: { node_name?: string }[];
        item_name?: { language_tag?: string; value: string }[];
        other_image_id?: string[];
        main_image_id?: string;
      };
      const node = j.node?.map((n) => n.node_name ?? "").join(" | ") ?? "";
      if (!j.item_id || !ITEM_ID.test(j.item_id) || !node.toLowerCase().includes(needle)) continue;
      out.push({
        itemId: j.item_id,
        name:
          j.item_name?.find((n) => n.language_tag === "en_US")?.value ?? j.item_name?.[0]?.value ?? j.item_id,
        node,
        images: (j.main_image_id ? 1 : 0) + (j.other_image_id?.length ?? 0),
      });
    }
  }
  return out.sort((a, b) => a.itemId.localeCompare(b.itemId)).slice(0, opts.limit);
}

/** Catalog record + 3D model + photos → .data/products/abo/<ITEM_ID>/ (skips files already present). */
export async function fetchAboProduct(
  itemId: string,
): Promise<{ dir: string; hasModel: boolean; images: number }> {
  if (!ITEM_ID.test(itemId)) throw new Error(`invalid ABO item id ${itemId}`);
  const outDir = resolveFromRoot(path.join(".data/products/abo", itemId));
  let listing: Record<string, unknown> | undefined;
  const listingFile = path.join(outDir, "listing.json");
  if (fs.existsSync(listingFile))
    listing = JSON.parse(fs.readFileSync(listingFile, "utf8")) as Record<string, unknown>;
  for (const s of listing ? [] : SHARDS) {
    for (const line of gunzipLines(await cached(`listings/metadata/listings_${s}.json.gz`, cacheDir()))) {
      if (!line.includes(`"item_id": "${itemId}"`) && !line.includes(`"item_id":"${itemId}"`)) continue;
      const j = JSON.parse(line) as Record<string, unknown>;
      if (j.item_id === itemId) listing = j;
    }
    if (listing) break;
  }
  if (!listing) throw new Error(`${itemId} not found in the ABO listings`);
  fs.mkdirSync(path.join(outDir, "images"), { recursive: true });
  fs.writeFileSync(listingFile, JSON.stringify(listing, null, 1));

  const modelId = typeof listing["3dmodel_id"] === "string" ? listing["3dmodel_id"] : null;
  const modelFile = path.join(outDir, "model.glb");
  if (modelId && !fs.existsSync(modelFile)) {
    const models = gunzipLines(await cached("3dmodels/metadata/3dmodels.csv.gz", cacheDir()));
    const rel = models.find((l) => l.startsWith(`${modelId},`))?.split(",")[1];
    if (rel && /^[A-Za-z0-9]\/[A-Z0-9]{10}\.glb$/.test(rel))
      await download(`${BUCKET}/3dmodels/original/${rel}`, modelFile);
  }

  const ids = [listing.main_image_id, ...((listing.other_image_id as unknown[] | undefined) ?? [])].filter(
    (x): x is string => typeof x === "string" && /^[A-Za-z0-9+_-]{6,20}$/.test(x),
  );
  if (ids.length) {
    const rows = gunzipLines(await cached("images/metadata/images.csv.gz", cacheDir()));
    const byId = new Map(rows.map((r) => [r.split(",")[0], r.split(",")[3]] as const));
    for (const [i, id] of ids.entries()) {
      const rel = byId.get(id);
      if (!rel || !/^[0-9a-f]{2}\/[0-9a-f]{8}\.jpg$/.test(rel)) continue;
      const out = path.join(outDir, "images", `${String(i).padStart(2, "0")}_${id.replace(/\+/g, "_")}.jpg`);
      if (!fs.existsSync(out)) await download(`${BUCKET}/images/original/${rel}`, out);
    }
  }
  return { dir: outDir, hasModel: fs.existsSync(modelFile), images: ids.length };
}
