import { describe, expect, it } from "vitest";
import { Asset3D } from "../contracts/asset.ts";
import { Recipe3D } from "../contracts/recipe.ts";
import { canonical, recipeHash, sceneScriptHash, visualKey } from "./keys.ts";

const product = Asset3D.parse({
  assetId: "demo-drill-20v",
  assetType: "PRODUCT_MODEL",
  category: "tools",
  source: "procedural:drill_driver_20v@1",
  license: "own",
  licenseEvidence: "repo",
  isSynthetic: true,
  isDemoOnly: true,
  isProductVerified: false,
  fidelity: "FICTIONAL_DEMO",
  engine: "blender",
  generator: { name: "drill_driver_20v", version: 1, params: {} },
  version: 1,
  createdAt: "2026-10-16T00:00:00Z",
});
const recipe = Recipe3D.parse({ template: "PRODUCT_HERO", productAssetId: "demo-drill-20v", durationSec: 4 });

describe("render cache keys", () => {
  it("canonical JSON ignores key order and undefined", () => {
    expect(canonical({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(canonical({ a: { d: [1, 2] }, b: 1 }));
  });

  it("is stable and independent of the engine mode and the metadata output", () => {
    const a = visualKey(recipe, product);
    expect(visualKey(Recipe3D.parse({ ...recipe }), product)).toBe(a);
    expect(visualKey({ ...recipe, engine: "BLENDER" }, product)).toBe(a);
    expect(visualKey({ ...recipe, outputs: ["thumbnail", "video"] }, product)).toBe(a);
  });

  it("changes with everything that changes a pixel", () => {
    const a = visualKey(recipe, product);
    expect(visualKey({ ...recipe, quality: "production" }, product)).not.toBe(a);
    expect(visualKey({ ...recipe, template: "TURNTABLE_360" }, product)).not.toBe(a);
    expect(visualKey({ ...recipe, seed: 2 }, product)).not.toBe(a);
    expect(visualKey({ ...recipe, framing: { centerY: 0.6 } }, product)).not.toBe(a);
    expect(visualKey(recipe, { ...product, version: 2 })).not.toBe(a);
    expect(visualKey(recipe, product, "other-scripts")).not.toBe(a);
  });

  it("the engine identity separates recipe hashes, not visual keys", () => {
    const v = visualKey(recipe, product);
    expect(recipeHash(v, "blender|Blender 4.3.0|CPU")).not.toBe(recipeHash(v, "blender|Blender 5.2.2|CPU"));
  });

  it("covers the Python scene generators", () => {
    expect(sceneScriptHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});
