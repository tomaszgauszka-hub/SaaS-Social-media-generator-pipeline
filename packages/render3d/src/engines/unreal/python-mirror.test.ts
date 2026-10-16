import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIDELITY_LEVELS } from "../../contracts/asset.ts";
import {
  BACKGROUND_PRESETS,
  CAMERA_PRESETS,
  ENVIRONMENT_PRESETS,
  FPS_VALUES,
  LIGHTING_PRESETS,
  MOVEMENTS,
  PRODUCT_ACTIONS,
  UNREAL_TEMPLATES,
} from "../../contracts/recipe.ts";
import { pyTuple } from "../../testing/py-tables.ts";
import { resolveUnrealConfig, UE_EXECUTORS, UE_GI_MODES } from "./config.ts";
import { BAKE_CHANNELS, buildUeSceneJob, MATERIAL_STATUSES, sha256File } from "./job.ts";
import { readUeResultFile, toEngineOutput } from "./result.ts";
import { buildWhitelistedCommand, UE_MODULES } from "./remote-exec.ts";
import { makeRecipe, makeRequest } from "./testing/fixtures.ts";

/*
 * The TypeScript job contract and tools/unreal/ue_job.py must agree: the closed sets are compared from source, and a
 * job built here is validated by the Python validator (and a broken one rejected) when python3 is available.
 */

const scriptsDir = resolveUnrealConfig({}, {}, {}).scriptsDir;
const src = fs.readFileSync(path.join(scriptsDir, "ue_job.py"), "utf8");
const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
let tmp: string;
/** the double-quoted words of a Python literal's body */
const quoted = (body: string | undefined) =>
  [...(body ?? "").matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ue-mirror-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function pyValidate(job: unknown): { code: number; err: string } {
  const file = path.join(tmp, `job-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(job));
  const r = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import json,sys; sys.path.insert(0, sys.argv[1]); import ue_job; ue_job.validate_job(json.load(open(sys.argv[2])))",
      scriptsDir,
      file,
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" } },
  );
  return { code: r.status ?? -1, err: r.stderr };
}

describe("TS ↔ Python UE tables", () => {
  it("closed sets match tools/unreal/ue_job.py", () => {
    expect(pyTuple(src, "TEMPLATES")).toEqual([...UNREAL_TEMPLATES]);
    expect(pyTuple(src, "CAMERA_PRESETS")).toEqual([...CAMERA_PRESETS]);
    expect(quoted(/^MOVEMENTS = \{([^}]*)\}/m.exec(src)?.[1])).toEqual([...MOVEMENTS]);
    expect(pyTuple(src, "LIGHTING_PRESETS")).toEqual([...LIGHTING_PRESETS]);
    expect(pyTuple(src, "BACKGROUND_PRESETS")).toEqual([...BACKGROUND_PRESETS]);
    expect(pyTuple(src, "ENVIRONMENT_PRESETS")).toEqual([...ENVIRONMENT_PRESETS]);
    expect(pyTuple(src, "ACTIONS")).toEqual([...PRODUCT_ACTIONS]);
    expect(pyTuple(src, "FIDELITY")).toEqual([...FIDELITY_LEVELS]);
    expect(pyTuple(src, "EXECUTORS")).toEqual([...UE_EXECUTORS]);
    expect(pyTuple(src, "GI_MODES")).toEqual([...UE_GI_MODES]);
    expect(pyTuple(src, "MATERIAL_STATUSES")).toEqual([...MATERIAL_STATUSES]);
    expect(pyTuple(src, "BAKE_CHANNELS")).toEqual([...BAKE_CHANNELS]);
    expect(
      /^FPS_VALUES = \(([^)]*)\)/m
        .exec(src)?.[1]
        ?.split(",")
        .map((s) => Number(s.trim())),
    ).toEqual([...FPS_VALUES]);
    const remote = fs.readFileSync(path.join(scriptsDir, "remote_exec.py"), "utf8");
    expect(quoted(/^MODULES = \(([^)]*)\)/m.exec(remote)?.[1])).toEqual(UE_MODULES);
  });

  it("a job built by the adapter passes the Python validator; tampered ones fail", () => {
    if (!hasPython) return; // python3 missing on this host: the table comparison above still ran
    const model = path.join(tmp, "product.fbx");
    fs.writeFileSync(model, "MOCK");
    const out = path.join(tmp, "ue");
    const { job } = buildUeSceneJob(
      makeRequest(tmp, model, {
        recipe: makeRecipe({
          template: "UE_MODERN_INTERIOR",
          environment: { preset: "kitchen" },
          background: { preset: "environment" },
          framing: { centerY: 0.4, fill: 0.5 },
          actions: [{ kind: "LED_ON", startSec: 0, endSec: 0.4 }],
        }),
      }),
      out,
      {
        sha256: "a".repeat(64),
        materialReport: {
          materials: [
            { material: "Body Paint", status: "APPROXIMATED", notes: ["Coat Weight=0.8: x"], textures: [] },
          ],
        },
        bakedTextures: {
          "Body Paint": { baseColor: path.join(out, "inputs", "baked", "Body Paint.baseColor.png") },
        },
        executor: "new_process",
        gi: "screen_space",
        maxRenderSec: 900,
      },
    );
    const ok = pyValidate(job);
    expect(ok.code, ok.err).toBe(0);
    expect(pyValidate({ ...job, extra: 1 }).code).not.toBe(0);
    expect(pyValidate({ ...job, template: "PRODUCT_HERO" }).code).not.toBe(0);
    expect(pyValidate({ ...job, product: { ...job.product, path: "relative.fbx" } }).code).not.toBe(0);
  });

  it("FAKE editor: ue_scene.py's result.json for a TS-built job passes the adapter's result validation", async () => {
    if (!hasPython) return;
    const projectDir = path.join(tmp, "Render3D");
    fs.mkdirSync(path.join(projectDir, "Config"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "Config", "DefaultRender3D.ini"),
      "[Render3D]\nDedicatedRenderProject=True\n",
    );
    const model = path.join(tmp, "contract.fbx");
    fs.writeFileSync(model, "MOCK FBX for the contract test");
    const out = path.join(tmp, "contract-out");
    for (const template of ["UE_TECHNOLOGY_SHOWCASE", "UE_ARCHITECTURAL_DEMO"] as const) {
      fs.rmSync(out, { recursive: true, force: true });
      const { job } = buildUeSceneJob(
        makeRequest(tmp, model, {
          recipe: makeRecipe({
            template,
            camera: { preset: "turntable", movement: "static" },
            framing: { centerY: 0.45 },
          }),
        }),
        out,
        {
          sha256: await sha256File(model),
          materialReport: null,
          bakedTextures: {},
          executor: "pie",
          gi: "auto",
          maxRenderSec: 600,
        },
      );
      const jobFile = path.join(tmp, `contract-${template}.json`);
      fs.writeFileSync(jobFile, JSON.stringify(job));
      const r = spawnSync("python3", ["-I", path.join(scriptsDir, "fake_unreal.py"), jobFile, projectDir], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const file = readUeResultFile(out);
      expect(file.kind, template).toBe("ok");
      if (file.kind !== "ok") return;
      expect(file.result.mock).toBe(true); // produced through the FAKE unreal module
      const o = toEngineOutput(file.result, out, job);
      expect(o.frameCount).toBe(12);
      expect(o.productBoxes).toHaveLength(12);
      expect(o.warnings[0]).toMatch(/^MOCK render/);
    }
  });

  it("the remote command template compiles as Python and keeps the path a literal", () => {
    if (!hasPython) return;
    const out = path.join(tmp, 'we"ird $(x) dir', "d.json");
    const code = buildWhitelistedCommand(
      { kind: "diagnose", outPath: out },
      { scriptsDir, allowedRoots: [tmp] },
    );
    const r = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import sys,ast; t=ast.parse(sys.stdin.read()); print(ast.literal_eval(t.body[2].value)[1])",
      ],
      { input: code, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(out);
  });
});
