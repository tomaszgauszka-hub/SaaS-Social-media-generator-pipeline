import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildUeSceneJob,
  findMaterialReport,
  productFormat,
  sha256File,
  stageBakedTextures,
  UeSceneJob,
  type BuildUeJobInput,
} from "./job.ts";
import { readUeResultFile, toEngineOutput, type UeSceneResult } from "./result.ts";
import { makeProduct, makeRecipe, makeRequest } from "./testing/fixtures.ts";

/* UE scene job building / validation and result.json validation (pure + temp files; no editor). */

let tmp: string;
let model: string;
const input = (o: Partial<BuildUeJobInput> = {}): BuildUeJobInput => ({
  sha256: "a".repeat(64),
  materialReport: null,
  bakedTextures: {},
  executor: "pie",
  gi: "auto",
  maxRenderSec: 600,
  ...o,
});

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ue-job-"));
  fs.mkdirSync(path.join(tmp, "export"));
  model = path.join(tmp, "export", "product.fbx");
  fs.writeFileSync(model, "MOCK FBX bytes");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("buildUeSceneJob", () => {
  it("maps a recipe + model to a strict UE scene job", () => {
    const req = makeRequest(tmp, model, {
      recipe: makeRecipe({
        framing: { centerY: 0.62, fill: 0.5 },
        background: { preset: "brand_color", color: "#112233" },
      }),
    });
    const { job, warnings } = buildUeSceneJob(req, path.join(tmp, "ue"), input());
    expect(job).toMatchObject({
      version: 1,
      kind: "ue_scene",
      template: "UE_LUXURY_STUDIO",
      framing: { centerY: 0.62, fill: 0.5 },
      product: { path: model, format: "fbx", dimensionsM: [0.2, 0.08, 0.25], frontYawDeg: 0 },
      render: { executor: "pie", gi: "auto", maxRenderSec: 600 },
      interactive: false,
    });
    expect(job.output.dir).toBe(path.join(tmp, "ue"));
    expect(warnings).toEqual([]);
    expect(() => UeSceneJob.parse({ ...job, script: "import os" })).toThrow();
    expect(() => UeSceneJob.parse({ ...job, product: { ...job.product, command: "x" } })).toThrow();
  });

  it("refuses Blender templates and requests without a model file", () => {
    expect(() =>
      buildUeSceneJob(
        makeRequest(tmp, model, { recipe: makeRecipe({ template: "PRODUCT_HERO" }) }),
        tmp,
        input(),
      ),
    ).toThrow(/not an Unreal template/);
    expect(() => buildUeSceneJob(makeRequest(tmp, null), tmp, input())).toThrow(/needs a model file/);
    expect(() => productFormat("/x/model.blend")).toThrow(/\.fbx or \.glb/);
    expect(productFormat("/x/model.GLB")).toBe("glb");
  });

  it("reports what the UE adapter does not produce", () => {
    const req = makeRequest(tmp, model, {
      recipe: makeRecipe({
        outputs: ["video", "alpha", "control_views", "export_fbx"],
        background: { preset: "transparent" },
      }),
    });
    const { warnings } = buildUeSceneJob(req, tmp, input());
    expect(warnings.join("\n")).toMatch(/alpha.*\n.*control views.*\n.*model exports/s);
  });

  it("keeps only known material report fields and baked maps inside the output dir", () => {
    const out = path.join(tmp, "ue");
    const { job } = buildUeSceneJob(
      makeRequest(tmp, model),
      out,
      input({
        materialReport: {
          materials: [
            {
              material: "Body",
              status: "APPROXIMATED",
              notes: ["Coat Weight=0.80: x"],
              textures: [],
              extra: 1,
            } as never,
          ],
        },
        bakedTextures: { Body: { baseColor: path.join(out, "inputs", "baked", "Body.baseColor.png") } },
      }),
    );
    expect(job.product.materialReport?.materials[0]).toEqual({
      material: "Body",
      status: "APPROXIMATED",
      notes: ["Coat Weight=0.80: x"],
      textures: [],
    });
    expect(() =>
      buildUeSceneJob(
        makeRequest(tmp, model),
        out,
        input({ bakedTextures: { Body: { baseColor: path.join(tmp, "elsewhere.png") } } }),
      ),
    ).toThrow(/outside output\.dir/);
  });

  it("drops out-of-range declared dimensions with a warning", () => {
    const req = makeRequest(tmp, model, { product: makeProduct({ dimensionsM: [0, 0.1, 0.1] }) });
    const { job, warnings } = buildUeSceneJob(req, tmp, input());
    expect(job.product.dimensionsM).toBeUndefined();
    expect(warnings[0]).toMatch(/out of range/);
  });
});

describe("sidecars", () => {
  it("finds a material report next to the model or in the Blender export result", async () => {
    expect((await findMaterialReport(model)).report).toBeNull();
    fs.writeFileSync(
      path.join(tmp, "result.json"),
      JSON.stringify({
        materialReport: {
          materials: [{ material: "Body", status: "PBR_DIRECT", notes: [], textures: [] }],
          counts: { PBR_DIRECT: 1 },
          ueReady: true,
        },
      }),
    );
    expect((await findMaterialReport(model)).report?.materials[0]?.status).toBe("PBR_DIRECT");
    fs.writeFileSync(
      path.join(tmp, "export", "product.materials.json"),
      JSON.stringify({ materials: [{ material: "X", status: "MAGIC" }] }),
    );
    const bad = await findMaterialReport(model);
    expect(bad.report).toBeNull();
    expect(bad.warning).toMatch(/invalid material report/);
    fs.rmSync(path.join(tmp, "export", "product.materials.json"));
  });

  it("copies valid baked maps into the job and ignores anything else", async () => {
    const baked = path.join(tmp, "export", "baked");
    fs.mkdirSync(baked, { recursive: true });
    fs.writeFileSync(path.join(baked, "Body Paint.baseColor.png"), "png");
    fs.writeFileSync(path.join(baked, "Body Paint.normal.png"), "png");
    fs.writeFileSync(path.join(baked, "evil.sh"), "#!/bin/sh");
    fs.symlinkSync("/etc/hostname", path.join(baked, "Link.roughness.png"));
    const out = path.join(tmp, "ue-baked");
    const r = await stageBakedTextures(model, out);
    expect(Object.keys(r.maps)).toEqual(["Body Paint"]);
    expect(r.maps["Body Paint"]?.baseColor).toBe(
      path.join(out, "inputs", "baked", "Body Paint.baseColor.png"),
    );
    expect(fs.existsSync(path.join(out, "inputs", "baked", "Link.roughness.png"))).toBe(false);
    expect(r.warnings.join()).toMatch(/evil\.sh/);
  });

  it("hashes files", async () => {
    expect(await sha256File(model)).toMatch(/^[0-9a-f]{64}$/);
  });
});

function result(job: UeSceneJob, over: Partial<UeSceneResult> = {}): Record<string, unknown> {
  const n = 12;
  return {
    ok: true,
    mock: true,
    sceneVersion: "ue-scene/1",
    jobId: job.jobId,
    template: job.template,
    unreal: { version: "MOCK", executor: "pie", configClass: "MOCK", gi: "lumen" },
    device: { device: "GPU" },
    frames: {
      dir: "frames",
      pattern: "f_%04d.png",
      startNumber: 1,
      count: n,
      width: 128,
      height: 128,
      fps: 24,
      alpha: false,
    },
    product: {
      assetId: job.product.assetId,
      assetPath: "/Game/Render3D/Products/drill_01",
      sourceSha256: job.product.sha256,
      importSkipped: true,
      measuredCm: [20, 8, 25],
      dimsCm: [20, 8, 25],
      expectedCm: [20, 8, 25],
      scaleApplied: 1,
      mismatchPct: 0,
      materialHash: "b".repeat(64),
    },
    set: { name: "Luxury Product Studio", key: "0123456789abcdef", rebuilt: false },
    productBoxes: Array.from({ length: n }, () => [0.3, 0.3, 0.7, 0.7]),
    anchorTracks: { center: Array.from({ length: n }, () => [0.5, 0.5]) },
    camera: { preset: "hero_low", lensMm: 40, distanceCm: 90 },
    controlViews: [],
    materials: [],
    materialReport: null,
    mrq: {},
    warnings: [],
    timings: { totalMs: 1, renderMs: 1, frameMs: [] },
    ...over,
  };
}

describe("result.json", () => {
  const out = () => path.join(tmp, "res");
  const job = () => buildUeSceneJob(makeRequest(tmp, model), out(), input()).job;
  const write = (r: unknown) => {
    fs.mkdirSync(path.join(out(), "frames"), { recursive: true });
    fs.writeFileSync(path.join(out(), "result.json"), JSON.stringify(r));
  };
  const frames = (n: number) => {
    for (let i = 1; i <= n; i++)
      fs.writeFileSync(path.join(out(), "frames", `f_${String(i).padStart(4, "0")}.png`), "png");
  };

  it("validates and maps a result (and labels a MOCK result)", () => {
    write(result(job()));
    frames(12);
    const f = readUeResultFile(out());
    expect(f.kind).toBe("ok");
    if (f.kind !== "ok") return;
    const o = toEngineOutput(f.result, out(), job());
    expect(o).toMatchObject({
      frameCount: 12,
      startNumber: 1,
      framePattern: "f_%04d.png",
      width: 128,
      alpha: false,
      controlViews: [],
    });
    expect(o.warnings[0]).toMatch(/^MOCK render/);
    expect(o.exports.dimensionsM).toEqual([0.2, 0.08, 0.25]);
  });

  it("rejects results that do not match the job or the disk", () => {
    const j = job();
    const bad: [Record<string, unknown>, RegExp][] = [
      [result(j, { jobId: "other" }), /for job other/],
      [
        {
          ...result(j),
          frames: { ...(result(j).frames as object), count: 13 },
          productBoxes: Array.from({ length: 13 }, () => [0, 0, 1, 1]),
          anchorTracks: {},
        },
        /13 frames/,
      ],
      [{ ...result(j), frames: { ...(result(j).frames as object), width: 256 } }, /256x128/],
      [
        { ...result(j), product: { ...(result(j).product as object), sourceSha256: "c".repeat(64) } },
        /another model/,
      ],
    ];
    for (const [r, re] of bad) {
      write(r);
      const f = readUeResultFile(out());
      expect(f.kind).toBe("ok");
      if (f.kind === "ok") expect(() => toEngineOutput(f.result, out(), j)).toThrow(re);
    }
    fs.rmSync(path.join(out(), "frames", "f_0012.png"));
    write(result(j));
    const f = readUeResultFile(out());
    if (f.kind === "ok")
      expect(() => toEngineOutput(f.result, out(), j)).toThrow(/frame missing: frames\/f_0012\.png/);
  });

  it("rejects malformed results, escaping names and symlinked frame dirs", () => {
    const j = job();
    write({ ...result(j), frames: { ...(result(j).frames as object), dir: "../x" } });
    expect(() => readUeResultFile(out())).toThrow(/failed validation/);
    write({ ...result(j), productBoxes: [[0, 0, 1]] });
    expect(() => readUeResultFile(out())).toThrow(/failed validation/);
    fs.writeFileSync(path.join(out(), "result.json"), "{oops");
    expect(() => readUeResultFile(out())).toThrow(/not JSON/);
    const out2 = path.join(tmp, "res-link");
    fs.mkdirSync(out2, { recursive: true });
    fs.symlinkSync(path.join(out(), "frames"), path.join(out2, "frames"));
    fs.writeFileSync(path.join(out2, "result.json"), JSON.stringify(result(j)));
    const f = readUeResultFile(out2);
    if (f.kind === "ok") expect(() => toEngineOutput(f.result, out2, j)).toThrow(/escapes the job/);
  });

  it("reads failure documents and a missing result", () => {
    write({ ok: false, error: "render_failed", message: "boom", exitCode: 1, warnings: [] });
    expect(readUeResultFile(out())).toMatchObject({ kind: "failure", failure: { error: "render_failed" } });
    fs.rmSync(path.join(out(), "result.json"));
    expect(readUeResultFile(out()).kind).toBe("missing");
  });
});
