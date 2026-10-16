import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Asset3D, type Asset3DInput } from "../../../contracts/asset.ts";
import type { EngineRenderRequest } from "../../../contracts/engine.ts";
import { Recipe3D, type Recipe3DInput } from "../../../contracts/recipe.ts";

/*
 * Test fixtures for the Unreal adapter (MOCK installs — no Unreal Engine involved): a fake engine tree with
 * Engine/Build/Build.version, a dedicated render project with the Render3D marker, a model file and requests.
 */

export const FAKE_EDITOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-unreal-editor.mjs");

export function makeInstall(
  root: string,
  version = { MajorVersion: 5, MinorVersion: 8, PatchVersion: 1 },
  platform: "Win64" | "Linux" = "Win64",
): string {
  const engine = path.join(root, "Engine");
  const bin = path.join(engine, "Binaries", platform);
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(engine, "Build"), { recursive: true });
  fs.writeFileSync(
    path.join(engine, "Build", "Build.version"),
    JSON.stringify({
      ...version,
      Changelist: 12345678,
      CompatibleChangelist: 12345678,
      IsLicenseeVersion: 0,
      BranchName: "++UE5+Release-5.8",
    }),
  );
  const exe = path.join(bin, platform === "Win64" ? "UnrealEditor-Cmd.exe" : "UnrealEditor-Cmd");
  fs.writeFileSync(exe, "MOCK editor binary (never executed)\n");
  return exe;
}

export function makeProject(
  dir: string,
  o: { marker?: boolean; plugins?: string[]; association?: string; name?: string } = {},
): string {
  fs.mkdirSync(path.join(dir, "Config"), { recursive: true });
  const file = path.join(dir, `${o.name ?? "Render3D"}.uproject`);
  const plugins = o.plugins ?? [
    "PythonScriptPlugin",
    "EditorScriptingUtilities",
    "SequencerScripting",
    "MovieRenderPipeline",
  ];
  fs.writeFileSync(
    file,
    JSON.stringify({
      FileVersion: 3,
      EngineAssociation: o.association ?? "5.8",
      Category: "",
      Description: "",
      Plugins: plugins.map((Name) => ({ Name, Enabled: true })),
    }),
  );
  if (o.marker ?? true)
    fs.writeFileSync(
      path.join(dir, "Config", "DefaultRender3D.ini"),
      "[Render3D]\nDedicatedRenderProject=True\n",
    );
  return file;
}

export function makeProduct(over: Partial<Asset3DInput> = {}): Asset3D {
  return Asset3D.parse({
    assetId: "drill_01",
    assetType: "PRODUCT_MODEL",
    category: "tools",
    source: "manufacturer:test",
    license: "test",
    licenseEvidence: "test fixture",
    isSynthetic: false,
    isDemoOnly: true,
    isProductVerified: false,
    fidelity: "APPROXIMATE_VISUALIZATION",
    engine: "external",
    version: 1,
    createdAt: "2026-10-16T00:00:00Z",
    dimensionsM: [0.2, 0.08, 0.25],
    ...over,
  });
}

export function makeRecipe(over: Partial<Recipe3DInput> = {}): Recipe3D {
  return Recipe3D.parse({
    template: "UE_LUXURY_STUDIO",
    productAssetId: "drill_01",
    durationSec: 0.5,
    fps: 24,
    resolution: [256, 256],
    camera: { preset: "hero_low", movement: "slow" },
    ...over,
  });
}

export function makeRequest(
  workDir: string,
  productFile: string | null,
  over: Partial<EngineRenderRequest> = {},
): EngineRenderRequest {
  return {
    jobId: "ue-job-1",
    recipe: makeRecipe(),
    product: makeProduct(),
    productFile,
    workDir,
    device: "GPU",
    threads: 0,
    timeoutMs: 60_000,
    ...over,
  };
}
