import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalStorageProvider } from "@cre/providers";
import { DeferredError, FatalError } from "@cre/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Recipe3DInput } from "../contracts/recipe.ts";
import { LocalCostAssumptions } from "../cost/local.ts";
import { FileAssetLibrary } from "../library/library.ts";
import { registerDemoProduct, registerModelFile } from "../library/products.ts";
import { FakeEngine, hasFfmpeg } from "../testing/fake-engine.ts";
import { RenderWorker3D } from "./render-worker.ts";

/*
 * Render worker with a TEST engine (FFmpeg-drawn frames, no 3D): routing, resource locks, encode, clip QA,
 * library storage, cache hits, deferral, the preview gate and cancellation.
 */

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "render3d-worker-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function setup(blender = new FakeEngine("blender"), unreal = new FakeEngine("unreal", { available: false })) {
  const dir = fs.mkdtempSync(path.join(root, "w-"));
  const storage = new LocalStorageProvider(path.join(dir, "storage"));
  const library = new FileAssetLibrary(path.join(dir, "library"), storage);
  const worker = new RenderWorker3D({
    library,
    engines: { blender, unreal },
    workRoot: path.join(dir, "work"),
    lockDir: path.join(dir, "locks"),
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
    heavySlots: 1,
    blenderSlots: 1,
    device: "CPU",
    threads: 0,
    cost: LocalCostAssumptions.parse({}),
    minFreeRamMb: 1,
  });
  return { dir, storage, library, worker, blender };
}

const recipe: Recipe3DInput = {
  template: "PRODUCT_HERO",
  productAssetId: "demo-drill-20v",
  durationSec: 1,
  fps: 24,
  resolution: [270, 480],
};

describe.skipIf(!hasFfmpeg)("RenderWorker3D (test engine)", () => {
  it("renders, encodes, checks and stores a clip; the identical job is a cache hit", async () => {
    const { worker, library, blender, dir } = setup();
    await registerDemoProduct(library, "demo-drill-20v");
    const first = await worker.run({ jobId: "job-a", recipe });
    expect(first.decision.engine).toBe("BLENDER");
    expect(first.reused).toBe(false);
    expect(blender.renders).toBe(1);
    const clip = first.asset!;
    expect(clip.assetType).toBe("RENDER_CLIP");
    expect(clip.isDemoOnly).toBe(true);
    expect(clip.fidelity).toBe("FICTIONAL_DEMO");
    expect(clip.parentAssetIds).toEqual(["demo-drill-20v"]);
    expect(clip.outputFiles.map((f) => f.role).sort()).toEqual(["metadata", "thumbnail", "video"]);
    expect(clip.qa?.passed).toBe(true);
    expect(clip.telemetry?.framesRendered).toBe(24);
    expect(clip.renderCostEstimateUsd).toBeGreaterThan(0);
    expect(clip.approval.status).toBe("PENDING");
    // temporary files are cleaned up
    expect(fs.readdirSync(path.join(dir, "work"))).toEqual([]);

    const again = await worker.run({ jobId: "job-b", recipe });
    expect(again.decision.engine).toBe("EXISTING_ASSET");
    expect(again.reused).toBe(true);
    expect(again.asset?.assetId).toBe(clip.assetId);
    expect(blender.renders).toBe(1);
  });

  it("a storyboard locale change has no recipe field to change: same key, no re-render", async () => {
    const { worker, library, blender } = setup();
    await registerDemoProduct(library, "demo-drill-20v");
    await worker.run({ jobId: "en", recipe });
    await worker.run({ jobId: "pl", recipe: { ...recipe } });
    expect(blender.renders).toBe(1);
  });

  it("flags black frames as a QA blocker", async () => {
    const { worker, library } = setup(new FakeEngine("blender", { color: "black" }));
    await registerDemoProduct(library, "demo-drill-20v");
    const r = await worker.run({ jobId: "dark", recipe: { ...recipe, seed: 7 } });
    expect(r.qa?.passed).toBe(false);
    expect(r.qa?.checks.find((c) => c.id === "no_black_frames")?.ok).toBe(false);
  });

  it("defers (does not fail) while the engine is offline", async () => {
    const { worker, library } = setup(new FakeEngine("blender", { available: false }));
    await registerDemoProduct(library, "demo-drill-20v");
    await expect(worker.run({ jobId: "off", recipe })).rejects.toBeInstanceOf(DeferredError);
  });

  it("production needs an approved preview of the same recipe", async () => {
    const { worker, library } = setup();
    await registerDemoProduct(library, "demo-drill-20v");
    const prod: Recipe3DInput = { ...recipe, quality: "production", resolution: [270, 480] };
    await expect(worker.run({ jobId: "p0", recipe: prod, requireApprovedPreview: true })).rejects.toThrow(
      /approved preview/,
    );
    const preview = await worker.run({ jobId: "p1", recipe });
    await library.setApproval(preview.asset!.assetId, "APPROVED", "owner@example.com");
    const done = await worker.run({ jobId: "p2", recipe: prod, requireApprovedPreview: true });
    expect(done.asset?.quality).toBe("production");
  });

  it("cancels a running render and cleans its scratch directory", async () => {
    const { worker, library, dir } = setup(new FakeEngine("blender", { delayMs: 5_000 }));
    await registerDemoProduct(library, "demo-drill-20v");
    const ac = new AbortController();
    const run = worker.run({ jobId: "cancel", recipe }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(run).rejects.toThrow();
    expect(fs.readdirSync(path.join(dir, "work"))).toEqual([]);
  });

  it("refuses model files without a commercial-use licence; stores a cleared one once (dedup)", async () => {
    const { library, storage, dir } = setup();
    const file = path.join(dir, "model.glb");
    fs.writeFileSync(file, "glTF-test");
    await expect(
      registerModelFile(library, {
        assetId: "m-nc",
        file,
        productId: "p",
        category: "lamp",
        source: "web",
        license: "CC BY-NC 4.0",
        licenseEvidence: "x",
        fidelity: "APPROXIMATE_VISUALIZATION",
      }),
    ).rejects.toBeInstanceOf(FatalError);
    const a = await registerModelFile(library, {
      assetId: "m-ok",
      file,
      productId: "p",
      category: "lamp",
      source: "abo:X",
      license: "CC BY 4.0",
      licenseEvidence: "https://amazon-berkeley-objects.s3.amazonaws.com/index.html",
      fidelity: "TECHNICAL_RECONSTRUCTION",
    });
    const b = await registerModelFile(library, {
      assetId: "m-ok2",
      file,
      productId: "p2",
      category: "lamp",
      source: "abo:Y",
      license: "CC BY 4.0",
      licenseEvidence: "same file",
      fidelity: "TECHNICAL_RECONSTRUCTION",
    });
    expect(a.outputFiles[0]!.key).toBe(b.outputFiles[0]!.key); // one stored copy
    expect(await storage.exists(a.outputFiles[0]!.key)).toBe(true);
    expect(a.isProductVerified).toBe(false);
    expect(a.structureVerified).toBe(false);
  });
});
