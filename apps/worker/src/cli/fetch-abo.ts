/**
 * Fetch a real product from the Amazon Berkeley Objects dataset (CC BY 4.0): catalog record, 3D model and photos.
 *
 *   pnpm reel:fetch-abo B075X2FZSM            → .data/products/abo/B075X2FZSM/{listing.json, model.glb, images/*}
 *
 * The catalog listings (16 gzip files, ~87 MB) are downloaded once into the cache and indexed by item id.
 * URLs are built from the fixed dataset bucket and a validated item id only.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { resolveFromRoot } from "@cre/config";

const BUCKET = "https://amazon-berkeley-objects.s3.amazonaws.com";
const SHARDS = "0123456789abcdef".split("");

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

async function main(): Promise<void> {
  const itemId = process.argv[2] ?? "";
  if (!/^[A-Z0-9]{10}$/.test(itemId))
    throw new Error("usage: fetch-abo <ITEM_ID> (10 upper-case letters/digits)");
  const cacheDir = resolveFromRoot(".data/cache/abo");
  const outDir = resolveFromRoot(path.join(".data/products/abo", itemId));

  let listing: Record<string, unknown> | undefined;
  for (const s of SHARDS) {
    const file = await cached(`listings/metadata/listings_${s}.json.gz`, cacheDir);
    for (const line of gunzipLines(file)) {
      if (!line.includes(`"item_id": "${itemId}"`) && !line.includes(`"item_id":"${itemId}"`)) continue;
      const j = JSON.parse(line) as Record<string, unknown>;
      if (j.item_id === itemId) listing = j;
    }
    if (listing) break;
  }
  if (!listing) throw new Error(`${itemId} not found in the ABO listings`);
  fs.mkdirSync(path.join(outDir, "images"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "listing.json"), JSON.stringify(listing, null, 1));

  const modelId = typeof listing["3dmodel_id"] === "string" ? listing["3dmodel_id"] : null;
  if (modelId) {
    const models = gunzipLines(await cached("3dmodels/metadata/3dmodels.csv.gz", cacheDir));
    const row = models.find((l) => l.startsWith(`${modelId},`));
    const rel = row?.split(",")[1];
    if (rel && /^[A-Za-z0-9]\/[A-Z0-9]{10}\.glb$/.test(rel))
      await download(`${BUCKET}/3dmodels/original/${rel}`, path.join(outDir, "model.glb"));
  }

  const ids = [listing.main_image_id, ...((listing.other_image_id as unknown[] | undefined) ?? [])].filter(
    (x): x is string => typeof x === "string" && /^[A-Za-z0-9+_-]{6,20}$/.test(x),
  );
  if (ids.length) {
    const rows = gunzipLines(await cached("images/metadata/images.csv.gz", cacheDir));
    const byId = new Map(rows.map((r) => [r.split(",")[0], r.split(",")[3]] as const));
    for (const [i, id] of ids.entries()) {
      const rel = byId.get(id);
      if (!rel || !/^[0-9a-f]{2}\/[0-9a-f]{8}\.jpg$/.test(rel)) continue;
      await download(
        `${BUCKET}/images/original/${rel}`,
        path.join(outDir, "images", `${String(i).padStart(2, "0")}_${id.replace(/\+/g, "_")}.jpg`),
      );
    }
  }
  console.log(
    `${itemId} → ${path.relative(process.cwd(), outDir)} (model: ${modelId ? "yes" : "no"}, images: ${ids.length})`,
  );
  console.log(
    "Licence: CC BY 4.0 — Amazon Berkeley Objects (https://amazon-berkeley-objects.s3.amazonaws.com/index.html)",
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
