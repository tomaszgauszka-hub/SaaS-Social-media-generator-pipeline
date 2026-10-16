import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FatalError } from "@cre/shared";
import { describe, expect, it } from "vitest";
import { Asset3D } from "../../contracts/asset.ts";
import { Recipe3D } from "../../contracts/recipe.ts";
import {
  BlenderEngine,
  blenderCommand,
  buildSceneJob,
  parseBlenderVersion,
  parseSceneProgress,
} from "./adapter.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** a real result.json written by tools/blender/scenes (Blender 5.2, tiny preview of the cosmetic tube) */
const SAMPLE = path.join(HERE, "fixtures", "result.sample.json");

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
  structureVerified: true,
  engine: "blender",
  generator: { name: "drill_driver_20v", version: 1, params: {} },
  version: 1,
  createdAt: "2026-10-16T00:00:00Z",
});

function outDirWith(result: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blender-result-"));
  fs.mkdirSync(path.join(dir, "frames"));
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
  return dir;
}

describe("Blender adapter", () => {
  it("maps a recipe onto the scene job of the Python generators (closed sets, absolute output dir)", () => {
    const recipe = Recipe3D.parse({
      template: "MACRO_DETAIL",
      productAssetId: "demo-drill-20v",
      durationSec: 3,
      focus: "chuck",
      outputs: ["video", "export_fbx", "control_views"],
      actions: [{ kind: "LED_ON", startSec: 0.5, endSec: 1 }],
    });
    const job = buildSceneJob(
      { jobId: "j1", recipe, product, productFile: null, device: "AUTO", threads: 0 },
      "/tmp/x/out",
    );
    expect(job).toMatchObject({
      version: 1,
      template: "MACRO_DETAIL",
      focus: "chuck",
      product: { source: "procedural", generator: "drill_driver_20v", structureVerified: true },
      outputs: { frames: true, controlViews: true, export: ["fbx"] },
      output: { dir: path.resolve("/tmp/x/out") },
    });
    expect(job.actions).toEqual([{ kind: "LED_ON", startSec: 0.5, endSec: 1 }]);
  });

  it("refuses Unreal templates and model files of unknown formats", () => {
    const ue = Recipe3D.parse({ template: "UE_LUXURY_STUDIO", productAssetId: "p", durationSec: 3 });
    expect(() =>
      buildSceneJob(
        { jobId: "j", recipe: ue, product, productFile: null, device: "CPU", threads: 0 },
        "/tmp/o",
      ),
    ).toThrow(FatalError);
    const file = Asset3D.parse({
      ...product,
      generator: null,
      fidelity: "TECHNICAL_RECONSTRUCTION",
      isDemoOnly: false,
    });
    const hero = Recipe3D.parse({ template: "PRODUCT_HERO", productAssetId: "p", durationSec: 3 });
    expect(() =>
      buildSceneJob(
        { jobId: "j", recipe: hero, product: file, productFile: "/m/model.exe", device: "CPU", threads: 0 },
        "/o",
      ),
    ).toThrow(/unsupported model format/);
  });

  it("runs a bpy Python or a Blender executable — never a shell", () => {
    expect(blenderCommand({ blenderPython: "/py", blenderBin: null }, "/run.py", ["/job.json"])).toEqual({
      command: "/py",
      args: ["-B", "/run.py", "/job.json"],
    });
    expect(
      blenderCommand({ blenderPython: null, blenderBin: "C:/Blender/blender.exe" }, "/run.py", ["/j"]).args,
    ).toEqual([
      "-b",
      "--factory-startup",
      "-noaudio",
      "--python-exit-code",
      "1",
      "--python",
      "/run.py",
      "--",
      "/j",
    ]);
  });

  it("parses progress lines and Blender versions", () => {
    expect(parseSceneProgress("PROGRESS job=a frame=3/45 ms=11089")).toEqual({
      frame: 3,
      total: 45,
      ms: 11089,
    });
    expect(parseSceneProgress("Fra:1 Mem:...")).toBeNull();
    expect(parseBlenderVersion("bpy 4.3.0")).toBe("4.3.0");
    expect(parseBlenderVersion("Blender 5.2.2 LTS\nbuild date")).toBe("5.2.2");
  });

  it("accepts a real result.json and resolves its files inside the output directory", () => {
    const dir = outDirWith(JSON.parse(fs.readFileSync(SAMPLE, "utf8")));
    const out = new BlenderEngine({ blenderPython: null, blenderBin: null }).readResult(dir);
    expect(out.framesDir).toBe(path.join(dir, "frames"));
    expect(out.fps).toBe(15);
    expect(out.productBoxes.length).toBe(out.frameCount);
    expect(out.geometryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects results that name files outside the job or unexpected frame patterns", () => {
    const sample = JSON.parse(fs.readFileSync(SAMPLE, "utf8")) as Record<string, unknown>;
    const engine = new BlenderEngine({ blenderPython: null, blenderBin: null });
    const evil = outDirWith({
      ...sample,
      exports: { files: { fbx: "/etc/passwd" }, dimensionsM: [1, 1, 1] },
    });
    expect(() => engine.readResult(evil)).toThrow(/escapes/);
    const frames = sample.frames as Record<string, unknown>;
    const pattern = outDirWith({ ...sample, frames: { ...frames, pattern: "../../%04d.png" } });
    expect(() => engine.readResult(pattern)).toThrow(FatalError);
    const views = outDirWith({ ...sample, controlViews: ["../../x.png"] });
    expect(() => engine.readResult(views)).toThrow(FatalError);
  });
});
