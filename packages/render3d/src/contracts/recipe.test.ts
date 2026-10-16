import fs from "node:fs";
import { resolveFromRoot } from "@cre/config";
import { describe, expect, it } from "vitest";
import { ACTIONS_PY, pyTuple, pyDictKeys } from "../testing/py-tables.ts";
import {
  BACKGROUND_PRESETS,
  BLENDER_TEMPLATES,
  blenderEquivalent,
  CAMERA_PRESETS,
  defaultRecipe,
  ENVIRONMENT_PRESETS,
  LIGHTING_PRESETS,
  MATERIAL_TYPES_3D,
  PRODUCT_ACTIONS,
  Recipe3D,
  unrealEquivalent,
  UNREAL_TEMPLATES,
} from "./recipe.ts";
import { Asset3D } from "./asset.ts";

const SPEC = fs.readFileSync(resolveFromRoot("tools/blender/scenes/scene_spec.py"), "utf8");

describe("Recipe3D", () => {
  it("accepts the recipe example of the spec", () => {
    const r = Recipe3D.parse({
      engine: "AUTO",
      template: "PRODUCT_HERO",
      productAssetId: "product-demo-001",
      durationSec: 4,
      fps: 30,
      resolution: [1080, 1920],
      camera: { preset: "orbit_closeup", movement: "slow" },
      lighting: { preset: "premium_studio" },
      background: { preset: "dark_gradient" },
      outputs: ["video", "thumbnail", "metadata"],
    });
    expect(r.quality).toBe("preview");
    expect(r.framing.centerY).toBe(0.5);
    expect(r.actions).toEqual([]);
  });

  it("refuses text, prices or locales — a recipe is language-free", () => {
    expect(() =>
      Recipe3D.parse({ template: "PRODUCT_HERO", productAssetId: "p1", durationSec: 3, locale: "pl-PL" }),
    ).toThrow();
    expect(() =>
      Recipe3D.parse({ template: "PRODUCT_HERO", productAssetId: "p1", durationSec: 3, text: "Buy now" }),
    ).toThrow();
  });

  it("validates bounds and cross-field rules", () => {
    const base = { template: "PRODUCT_HERO", productAssetId: "p1", durationSec: 3 } as const;
    expect(() => Recipe3D.parse({ ...base, fps: 29 })).toThrow();
    expect(() => Recipe3D.parse({ ...base, resolution: [1081, 1920] })).toThrow();
    expect(() => Recipe3D.parse({ ...base, durationSec: 30 })).toThrow();
    expect(() => Recipe3D.parse({ ...base, productAssetId: "../etc" })).toThrow();
    expect(() => Recipe3D.parse({ ...base, template: "LIFESTYLE" })).toThrow(/environment/);
    expect(() => Recipe3D.parse({ ...base, template: "UE_LUXURY_STUDIO", engine: "BLENDER" })).toThrow(
      /Unreal/,
    );
    expect(() => Recipe3D.parse({ ...base, actions: [{ kind: "LED_ON", startSec: 1, endSec: 5 }] })).toThrow(
      /after the clip/,
    );
    expect(() => Recipe3D.parse({ ...base, focus: "Chuck; rm -rf" })).toThrow();
  });

  it("has a default recipe for every storyboard material type", () => {
    for (const mt of MATERIAL_TYPES_3D) expect(() => Recipe3D.parse(defaultRecipe(mt, "p1"))).not.toThrow();
  });

  it("maps every Unreal template to a Blender equivalent and back", () => {
    for (const t of UNREAL_TEMPLATES) {
      const r = Recipe3D.parse({ ...defaultRecipe("3D_CINEMATIC", "p1"), template: t });
      const b = blenderEquivalent(r);
      expect(BLENDER_TEMPLATES).toContain(b.template);
      expect(UNREAL_TEMPLATES).toContain(unrealEquivalent(b).template);
    }
  });
});

describe("TS tables mirror the Python scene generators", () => {
  it("templates, presets and actions are identical", () => {
    expect(pyTuple(SPEC, "TEMPLATES")).toEqual([...BLENDER_TEMPLATES]);
    expect(pyTuple(SPEC, "CAMERA_PRESETS")).toEqual([...CAMERA_PRESETS]);
    expect(pyTuple(SPEC, "ENVIRONMENTS")).toEqual([...ENVIRONMENT_PRESETS]);
    expect(pyTuple(SPEC, ACTIONS_PY)).toEqual([...PRODUCT_ACTIONS]);
    expect(pyDictKeys(SPEC, "LIGHTING")).toEqual([...LIGHTING_PRESETS]);
    expect(pyDictKeys(SPEC, "BACKGROUNDS")).toEqual([...BACKGROUND_PRESETS]);
  });
});

describe("Asset3D fidelity rules", () => {
  const base = {
    assetId: "m1",
    assetType: "PRODUCT_MODEL",
    category: "tools",
    source: "x",
    license: "own",
    licenseEvidence: "repo",
    isSynthetic: true,
    engine: "blender",
    version: 1,
    createdAt: "2026-10-16T00:00:00Z",
  } as const;
  it("a fictional demo model is DEMO_ONLY and never product-verified", () => {
    expect(() =>
      Asset3D.parse({ ...base, fidelity: "FICTIONAL_DEMO", isDemoOnly: false, isProductVerified: false }),
    ).toThrow();
    expect(() =>
      Asset3D.parse({ ...base, fidelity: "FICTIONAL_DEMO", isDemoOnly: true, isProductVerified: true }),
    ).toThrow();
    expect(() =>
      Asset3D.parse({ ...base, fidelity: "FICTIONAL_DEMO", isDemoOnly: true, isProductVerified: false }),
    ).not.toThrow();
  });
  it("an approximate visualisation cannot be marked as the verified product", () => {
    expect(() =>
      Asset3D.parse({
        ...base,
        fidelity: "APPROXIMATE_VISUALIZATION",
        isDemoOnly: false,
        isProductVerified: true,
      }),
    ).toThrow();
  });
});
