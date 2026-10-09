/**
 * Fetch a real product from the Amazon Berkeley Objects dataset (CC BY 4.0): catalog record, 3D model and photos.
 *
 *   pnpm reel:fetch-abo B075X2FZSM            → .data/products/abo/B075X2FZSM/{listing.json, model.glb, images/*}
 *
 * The catalog listings (16 gzip files, ~87 MB) are downloaded once into the cache and indexed by item id.
 */
import path from "node:path";
import { fetchAboProduct } from "../reel/abo.ts";

async function main(): Promise<void> {
  const itemId = process.argv[2] ?? "";
  const r = await fetchAboProduct(itemId);
  console.log(
    `${itemId} → ${path.relative(process.cwd(), r.dir)} (model: ${r.hasModel ? "yes" : "no"}, images: ${r.images})`,
  );
  console.log(
    "Licence: CC BY 4.0 — Amazon Berkeley Objects (https://amazon-berkeley-objects.s3.amazonaws.com/index.html)",
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
