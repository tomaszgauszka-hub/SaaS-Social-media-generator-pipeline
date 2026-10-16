import { describe, expect, it } from "vitest";
import { Asset3D, type Asset3DInput } from "../contracts/asset.ts";
import type { EngineCapabilities } from "../contracts/engine.ts";
import { recipeHash, visualKey } from "../cache/keys.ts";
import { Recipe3D, type Recipe3DInput } from "../contracts/recipe.ts";
import { engineIdentity, routeRender, type LibraryLookup, type RouteContext } from "./router.ts";

const caps = (
  engine: "blender" | "unreal",
  available: boolean,
  gpu = false,
  version = "4.3.0",
): EngineCapabilities => ({
  engine,
  available,
  version: available ? `${engine === "blender" ? "Blender" : "Unreal Engine"} ${version}` : null,
  reason: available ? null : `${engine} not installed`,
  gpu: { available: gpu, name: gpu ? "RTX" : null, vramMb: gpu ? 12000 : null },
  renderers: [],
  host: "test",
});

const model = (over: Partial<Asset3DInput> = {}): Asset3D =>
  Asset3D.parse({
    assetId: "demo-drill-20v",
    assetType: "PRODUCT_MODEL",
    productId: "bench-tools-drill",
    category: "tools",
    source: "procedural:drill_driver_20v@1",
    license: "own",
    licenseEvidence: "repo",
    isSynthetic: true,
    isDemoOnly: true,
    isProductVerified: false,
    fidelity: "FICTIONAL_DEMO",
    structureVerified: true,
    engine: "blender",
    generator: { name: "drill_driver_20v", version: 1, params: {} },
    version: 1,
    createdAt: "2026-10-16T00:00:00Z",
    parts: [{ name: "chuck", role: "detail", verified: true }],
    ...over,
  });

const emptyLib: LibraryLookup = {
  findByRecipeHash: () => Promise.resolve(null),
  findByVisualKey: () => Promise.resolve(null),
};

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  blender: caps("blender", true),
  unreal: caps("unreal", false),
  workerOnline: true,
  library: emptyLib,
  ...over,
});

const hero: Recipe3DInput = { template: "PRODUCT_HERO", productAssetId: "demo-drill-20v", durationSec: 4 };

describe("3D render router", () => {
  it("2D_ONLY never renders 3D", async () => {
    const d = await routeRender({ recipe: { ...hero, engine: "2D_ONLY" }, product: model() }, ctx());
    expect(d.engine).toBe("PROGRAMMATIC_2D");
  });

  it("without a product model the 2D pipeline uses the real product media — no model is invented", async () => {
    const d = await routeRender({ recipe: hero, product: null, productMediaCount: 4 }, ctx());
    expect(d.engine).toBe("PROGRAMMATIC_2D");
    expect(d.rejected[0]?.why).toMatch(/never invented/);
  });

  it("blocks construction templates for models without a verified structure", async () => {
    const abo = model({
      assetId: "abo-lamp",
      generator: null,
      source: "abo:B075X2FZSM",
      fidelity: "TECHNICAL_RECONSTRUCTION",
      isDemoOnly: false,
      isSynthetic: false,
      structureVerified: false,
    });
    for (const template of ["EXPLODED_VIEW", "PRODUCT_ASSEMBLY", "TECHNICAL"] as const) {
      const d = await routeRender(
        { recipe: { ...hero, template, productAssetId: "abo-lamp" }, product: abo },
        ctx(),
      );
      expect(d.engine).toBe("BLOCKED");
    }
  });

  it("refuses a focus part the model does not have", async () => {
    const d = await routeRender(
      { recipe: { ...hero, template: "MACRO_DETAIL", focus: "nozzle" }, product: model() },
      ctx(),
    );
    expect(d.engine).toBe("BLOCKED");
  });

  it("an existing clip with the same recipe is reused (cache hit, nothing rendered)", async () => {
    const recipe = Recipe3D.parse(hero);
    const product = model();
    const vk = visualKey(recipe, product);
    const rh = recipeHash(vk, engineIdentity(caps("blender", true), "CPU"));
    const clip = model({ assetId: "clip-1", assetType: "RENDER_CLIP", recipeHash: rh, visualKey: vk });
    const lib: LibraryLookup = {
      findByRecipeHash: (h) => Promise.resolve(h === rh ? clip : null),
      findByVisualKey: () => Promise.resolve(null),
    };
    const d = await routeRender({ recipe: hero, product }, ctx({ library: lib }));
    expect(d.engine).toBe("EXISTING_ASSET");
    expect(d.cacheHit).toBe(true);
    expect(d.existingAsset?.assetId).toBe("clip-1");
  });

  it("reuses the same visual recipe rendered by an older engine version; never a rejected clip", async () => {
    const product = model();
    const vk = visualKey(Recipe3D.parse(hero), product);
    const older = model({
      assetId: "clip-old",
      assetType: "RENDER_CLIP",
      visualKey: vk,
      engineVersion: "Blender 4.2.0",
    });
    const lib = (c: Asset3D): LibraryLookup => ({
      findByRecipeHash: () => Promise.resolve(null),
      findByVisualKey: (k) => Promise.resolve(k === vk ? c : null),
    });
    expect((await routeRender({ recipe: hero, product }, ctx({ library: lib(older) }))).engine).toBe(
      "EXISTING_ASSET",
    );
    const rejected = model({ ...older, approval: { status: "REJECTED", by: "owner", at: null, note: null } });
    const d = await routeRender({ recipe: hero, product }, ctx({ library: lib(rejected) }));
    expect(d.engine).toBe("BLENDER");
    expect(d.rejected.some((r) => r.engine === "EXISTING_ASSET")).toBe(true);
  });

  it("EXISTING_ASSET mode without a clip falls back to 2D", async () => {
    const d = await routeRender({ recipe: { ...hero, engine: "EXISTING_ASSET" }, product: model() }, ctx());
    expect(d.engine).toBe("PROGRAMMATIC_2D");
  });

  it("a simple turntable never starts Unreal, even when it is available", async () => {
    const d = await routeRender(
      { recipe: { ...hero, template: "TURNTABLE_360" }, product: model() },
      ctx({ unreal: caps("unreal", true, true, "5.8.0") }),
    );
    expect(d.engine).toBe("BLENDER");
    expect(d.rejected.some((r) => r.engine === "UNREAL")).toBe(true);
  });

  it("cinematic templates use Unreal when available with a GPU, else the Blender equivalent", async () => {
    const recipe = { ...hero, template: "UE_INDUSTRIAL_WORKSHOP" } as const;
    const withUe = await routeRender(
      { recipe, product: model() },
      ctx({ unreal: caps("unreal", true, true, "5.8.0") }),
    );
    expect(withUe.engine).toBe("UNREAL");
    const without = await routeRender({ recipe, product: model() }, ctx());
    expect(without.engine).toBe("BLENDER");
    expect(without.recipe?.template).toBe("LIFESTYLE");
    expect(without.recipe?.environment?.preset).toBe("workshop");
  });

  it("forced UNREAL without Unreal waits instead of silently switching engines", async () => {
    const d = await routeRender({ recipe: { ...hero, engine: "UNREAL" }, product: model() }, ctx());
    expect(d.engine).toBe("DEFER");
  });

  it("an offline station defers the job, or uses 2D when skip-3D-when-offline is on", async () => {
    expect((await routeRender({ recipe: hero, product: model() }, ctx({ workerOnline: false }))).engine).toBe(
      "DEFER",
    );
    const skip = await routeRender(
      { recipe: hero, product: model() },
      ctx({ workerOnline: false, settings: { skip3dWhenWorkerOffline: true } }),
    );
    expect(skip.engine).toBe("PROGRAMMATIC_2D");
    const noBlender = await routeRender(
      { recipe: hero, product: model() },
      ctx({ blender: caps("blender", false) }),
    );
    expect(noBlender.engine).toBe("DEFER");
  });

  it("does not use 3D for low-value beats in AUTO mode (but honours a forced engine)", async () => {
    const settings = { minValueFor3d: 0.4 };
    expect(
      (await routeRender({ recipe: hero, product: model(), valueScore: 0.1 }, ctx({ settings }))).engine,
    ).toBe("PROGRAMMATIC_2D");
    expect(
      (
        await routeRender(
          { recipe: { ...hero, engine: "BLENDER" }, product: model(), valueScore: 0.1 },
          ctx({ settings }),
        )
      ).engine,
    ).toBe("BLENDER");
  });

  it("estimates time and local cost, and asks for a preview first when production is too long", async () => {
    const d = await routeRender(
      { recipe: { ...hero, quality: "production", durationSec: 10 }, product: model() },
      ctx({ settings: { maxRenderMs: 60_000 } }),
    );
    expect(d.engine).toBe("BLENDER");
    expect(d.estimate?.totalMs).toBeGreaterThan(60_000);
    expect(d.estimate?.costUsd).toBeGreaterThan(0);
    expect(d.previewFirst).toBe(true);
  });
});
