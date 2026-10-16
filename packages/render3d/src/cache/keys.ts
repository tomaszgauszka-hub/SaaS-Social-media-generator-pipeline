import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveFromRoot } from "@cre/config";
import type { Asset3D } from "../contracts/asset.ts";
import type { Recipe3D } from "../contracts/recipe.ts";

/*
 * Render cache keys.
 *
 *   visualKey  = sha256(recipe pixels-relevant fields + product model identity + scene-script hash)
 *   recipeHash = sha256(visualKey + engine identity)
 *
 * A recipe holds no text and no locale, so a language / caption / price change never changes a key and never
 * re-renders 3D. `engine` (AUTO / BLENDER …) and the "metadata" output are not part of the picture and are left
 * out; everything else that changes a pixel is in. The scene-script hash covers the Python generators, so an edit
 * to a template invalidates exactly the clips that template rendered.
 */

export const RECIPE_HASH_VERSION = "render3d-key/1";

/** Canonical JSON: sorted keys, no undefined — the same value always hashes the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

export function fileSha256(file: string): string {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

const scriptHashes = new Map<string, string>();

/** Hash of every non-test Python module under the given tool directories (default: Blender scenes + studio). */
export function sceneScriptHash(
  dirs: readonly string[] = [
    resolveFromRoot("tools/blender/scenes"),
    resolveFromRoot("tools/blender/studio"),
  ],
): string {
  const id = dirs.join("\0");
  const hit = scriptHashes.get(id);
  if (hit) return hit;
  const h = createHash("sha256");
  for (const dir of dirs) {
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".py") && !f.startsWith("test_"))
          .sort()
      : [];
    for (const f of files) {
      h.update(`${path.basename(dir)}/${f}\0`);
      h.update(fs.readFileSync(path.join(dir, f)));
    }
  }
  const out = h.digest("hex");
  scriptHashes.set(id, out);
  return out;
}

/** The product model's identity in a key: version + content hashes (never names or descriptions). */
export function productIdentity(product: Asset3D): Record<string, unknown> {
  return {
    assetId: product.assetId,
    version: product.version,
    source: product.source,
    // geometry / material hashes are reported by the engine after a render: metadata, not identity — the model
    // file's sha256 (imported models) or the generator + params (procedural models) define the geometry
    sourceSha: product.outputFiles.find((f) => f.role === "source_model")?.sha256 ?? null,
    generator: product.generator,
  };
}

export function visualKey(recipe: Recipe3D, product: Asset3D, scriptHash = sceneScriptHash()): string {
  const { engine: _mode, outputs, ...pixels } = recipe;
  return sha256(
    canonical({
      v: RECIPE_HASH_VERSION,
      recipe: { ...pixels, outputs: [...outputs].filter((o) => o !== "metadata").sort() },
      product: productIdentity(product),
      scripts: scriptHash,
    }),
  );
}

export function recipeHash(visual: string, engineIdentity: string): string {
  return sha256(canonical({ v: RECIPE_HASH_VERSION, visual, engine: engineIdentity }));
}
