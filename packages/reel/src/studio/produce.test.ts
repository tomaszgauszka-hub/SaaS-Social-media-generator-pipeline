import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext } from "../capabilities/types.ts";
import { ProductSource } from "../contracts/product.ts";
import { CostTracker } from "../cost/tracker.ts";
import { testPlan } from "../testing/fixtures.ts";
import type { ReelTools } from "../util/tools.ts";
import { buildStudioJob } from "./job.ts";
import { produceShotClips } from "./produce.ts";
import { studioRendererVersion } from "./run.ts";

/*
 * A fake "bpy python" stands in for Blender: it finishes the job's first shot (files + result.json, as
 * studio_main.render_shot does) and then fails or hangs — a crash, a timeout kill or an aborted job.
 */

const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "-c") {
  console.log("bpy 9.9.9 fake");
  process.exit(0);
}
const job = JSON.parse(fs.readFileSync(args[2], "utf8"));
const work = path.join(job.output.dir, "..", "..");
fs.appendFileSync(path.join(work, "requested.log"), job.shots.map((s) => s.id).join(",") + "\\n");
const first = job.shots[0];
const dir = path.join(job.output.dir, first.id);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "plate.png"), "png");
const box = { x: 0.3, y: 0.2, w: 0.4, h: 0.6 };
const result = { id: first.id, technique: "plate", files: ["plate.png"], width: 319, height: 566, renderFps: 15,
  productBoxes: [box], samples: 4, renderMs: 10, engine: "CYCLES", blenderVersion: "9.9.9", overscan: 1.18 };
fs.writeFileSync(path.join(dir, "result.json.tmp"), JSON.stringify(result));
fs.renameSync(path.join(dir, "result.json.tmp"), path.join(dir, "result.json"));
if (fs.readFileSync(path.join(work, "mode.txt"), "utf8") === "hang") setInterval(() => {}, 1000);
else {
  console.error("Cycles crashed");
  process.exit(1);
}
`;

const product = ProductSource.parse({
  id: "lamp",
  source: { kind: "abo", ref: "abo:lamp", license: "CC BY 4.0" },
  brand: "Rivet",
  names: { "en-US": "Lamp" },
  category: "lamp",
  facts: [],
  images: [],
  model3d: { path: "/models/lamp.glb", format: "glb", license: "CC BY 4.0", sha256: "a".repeat(64) },
});

const shot = (id: string, startMs: number, preset: "hero_reveal" | "cta_hero") => ({
  id,
  role: "BENEFIT" as const,
  startMs,
  durationMs: 3000,
  preset,
  technique: "plate" as const,
  environment: "warm_living" as const,
  lighting: "three_point" as const,
  params: {},
  productAnimation: "none" as const,
  transitionIn: { type: "cut" as const, ms: 0 },
  source: "blender" as const,
});
const plan = testPlan({
  durationMs: 6000,
  shots: [shot("sh01", 0, "hero_reveal"), shot("sh02", 3000, "cta_hero")],
});

describe("produceShotClips after a failed studio run", () => {
  let root: string;
  let ctx: CallContext;
  let tools: ReelTools;
  const requested = () => fs.readFileSync(path.join(ctx.workDir, "requested.log"), "utf8").trim().split("\n");
  const mode = (m: "fail" | "hang") => fs.writeFileSync(path.join(ctx.workDir, "mode.txt"), m);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-resume-"));
    const fake = path.join(root, "fake-bpy.cjs");
    fs.writeFileSync(fake, FAKE, { mode: 0o755 });
    ctx = {
      workDir: path.join(root, "work"),
      cacheDir: path.join(root, "cache"),
      scope: "master",
      tracker: new CostTracker(),
    };
    fs.mkdirSync(ctx.workDir, { recursive: true });
    tools = {
      blenderPython: fake,
      blenderBin: null,
      blenderThreads: 0,
      blenderMaxConcurrent: 1,
      piperBin: null,
      piperVoicesDir: null,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      cacheDir: ctx.cacheDir,
      outputDir: path.join(root, "out"),
      workDir: ctx.workDir,
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("keeps the shots Blender finished, so the retry renders only the rest (never a stale leftover)", async () => {
    // a leftover of an earlier run in the same job dir (e.g. older studio code) must not be installed
    const jobDir = path.join(
      ctx.workDir,
      "studio",
      buildStudioJob(plan, product, "FAST", ctx.workDir, { modelSha: "a".repeat(64) }).jobKey.slice(0, 20),
    );
    const stale = path.join(jobDir, "sh02");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "plate.png"), "old");
    fs.writeFileSync(
      path.join(stale, "result.json"),
      JSON.stringify({
        ...JSON.parse('{"technique":"plate","files":["plate.png"],"width":1,"height":1}'),
        id: "sh02",
        renderFps: 15,
        productBoxes: [{ x: 0, y: 0, w: 1, h: 1 }],
        samples: 1,
        renderMs: 1,
        engine: "CYCLES",
        blenderVersion: "old",
      }),
    );
    const hourAgo = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(stale, "result.json"), hourAgo, hourAgo);

    mode("fail");
    await expect(produceShotClips(plan, product, "FAST", ctx, { tools })).rejects.toThrow(/Cycles crashed/);
    await expect(produceShotClips(plan, product, "FAST", ctx, { tools })).rejects.toThrow(/Cycles crashed/);
    expect(requested()).toEqual(["sh01,sh02", "sh02"]);
  });

  it("keys renders by the renderer's version (probed once per process)", async () => {
    expect(await studioRendererVersion(tools)).toBe("bpy 9.9.9 fake");
    expect(await studioRendererVersion({ blenderPython: null, blenderBin: null })).toBe("none");
    await expect(
      studioRendererVersion({ blenderPython: "/no/such/python", blenderBin: null }),
    ).rejects.toThrow();
  });

  it("keeps them when the job is aborted while Blender renders", async () => {
    mode("hang");
    const ac = new AbortController();
    const done = path.join(ctx.workDir, "studio");
    const poll = setInterval(() => {
      const hit =
        fs.existsSync(done) &&
        fs.readdirSync(done).some((d) => fs.existsSync(path.join(done, d, "sh01", "result.json")));
      if (hit) ac.abort();
    }, 20);
    try {
      await expect(
        produceShotClips(plan, product, "FAST", { ...ctx, signal: ac.signal }, { tools }),
      ).rejects.toThrow(/aborted/);
    } finally {
      clearInterval(poll);
    }
    mode("fail");
    await expect(produceShotClips(plan, product, "FAST", ctx, { tools })).rejects.toThrow(/Cycles crashed/);
    expect(requested()).toEqual(["sh01,sh02", "sh02"]);
  });
});
