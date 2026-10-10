import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIGHTING_PRESETS,
  PRODUCT_ANIMATIONS,
  SHOT_PRESETS,
  STUDIO_ENVIRONMENTS,
  type ShotPreset,
  type ShotTechnique,
} from "../contracts/ids.ts";
import { StudioJob, StudioProfileDefaults } from "../contracts/media.ts";
import type { PlanShot } from "../contracts/plan.ts";
import { ProductSource } from "../contracts/product.ts";
import { testPlan } from "../testing/fixtures.ts";
import { shotRenderInputs, studioCacheKey, studioCodeVersion, studioToolsDir } from "./cache.ts";
import { buildShotClipArgs } from "./encode.ts";
import {
  blenderShotGroups,
  buildStudioJob,
  inferEmitsLight,
  plateOverscan,
  plateTravelX,
  productRealHeightM,
  sequenceRenderFps,
  STUDIO_RENDER_SCALE,
  studioRenderSize,
  studioSeed,
} from "./job.ts";
import {
  boxThroughWindow,
  ease,
  easeExpr,
  plateMove,
  requiredOverscan,
  trackTimes,
  windowAt,
  windowExprs,
  windowTravelX,
  type Easing,
} from "./moves.ts";
import { parseProgressLine, studioCommand, studioEnv, studioFrameCount, StudioShotOutput } from "./run.ts";

/* ---------------------------------------------------------------- fixtures ----------------------------- */

const lamp = ProductSource.parse({
  id: "B075X2FZSM",
  source: { kind: "abo", ref: "abo:B075X2FZSM", license: "CC BY 4.0" },
  brand: "Rivet",
  names: { "en-US": "Rivet Table Lamp" },
  category: "lamp",
  facts: [
    { id: "dim.height", kind: "dimension", text: "height 21.7 inches", value: 21.7, unit: "in", source: "x" },
    { id: "bp.led", kind: "included", text: "LED bulb included.", source: "bullet_point" },
  ],
  images: [],
  model3d: {
    path: "/data/lamp/model.glb",
    format: "glb",
    license: "CC BY 4.0",
    sha256: "a".repeat(64),
    extentM: { x: 0.3632, y: 0.3632, z: 0.5512 },
  },
});

const chair = ProductSource.parse({
  ...lamp,
  id: "chair",
  category: "dining chairs",
  facts: [{ id: "material", kind: "material", text: "solid oak", source: "x" }],
});

const shot = (id: string, startMs: number, durationMs: number, over: Partial<PlanShot> = {}) => ({
  id,
  role: "BENEFIT" as const,
  startMs,
  durationMs,
  preset: "hero_reveal" as const,
  technique: "plate" as const,
  environment: "warm_living" as const,
  lighting: "three_point" as const,
  params: {},
  productAnimation: "none" as const,
  transitionIn: { type: "cut" as const, ms: 0 },
  source: "blender" as const,
  ...over,
});

const plan = testPlan({
  durationMs: 12_000,
  shots: [
    shot("sh01", 0, 2000, {
      preset: "silhouette_reveal",
      technique: "relight",
      productAnimation: "light_on",
      lighting: "rim_dramatic",
    }),
    shot("sh02", 2000, 3000, {
      preset: "slow_turntable",
      technique: "sequence",
      params: { sweepDeg: 40 } as never,
    }),
    shot("sh03", 5000, 2400, { preset: "macro_push", params: { fill: 1.5, focus: "middle" } as never }),
    shot("sh04", 7400, 2100, { preset: "camera_slide" }),
    shot("sh05", 9500, 2500, { preset: "cta_hero" }),
  ],
});

/* ---------------------------------------------------------------- a tiny FFmpeg expression evaluator ---- */

/** Evaluates the subset of FFmpeg's expression language the builders emit (numbers, + - * /, PI, functions). */
function evalFf(expr: string, vars: Record<string, number>): number {
  let i = 0;
  const peek = () => expr[i];
  const fns: Record<string, (...a: number[]) => number> = {
    cos: Math.cos,
    pow: Math.pow,
    min: Math.min,
    max: Math.max,
    clip: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
    lt: (a, b) => (a < b ? 1 : 0),
    lte: (a, b) => (a <= b ? 1 : 0),
    if: (c, a, b) => (c ? a : b),
  };
  const primary = (): number => {
    if (peek() === "(") {
      i++;
      const v = sum();
      i++; // )
      return v;
    }
    if (peek() === "-") {
      i++;
      return -primary();
    }
    const m = /^[0-9.]+(e-?\d+)?|^[A-Za-z_]+/.exec(expr.slice(i))!;
    i += m[0].length;
    const tok = m[0];
    if (/^[0-9.]/.test(tok)) return Number(tok);
    if (tok === "PI") return Math.PI;
    if (peek() === "(") {
      i++;
      const args = [sum()];
      while (peek() === ",") {
        i++;
        args.push(sum());
      }
      i++;
      return fns[tok]!(...args);
    }
    if (!(tok in vars)) throw new Error(`unknown variable ${tok}`);
    return vars[tok]!;
  };
  const product = (): number => {
    let v = primary();
    while (peek() === "*" || peek() === "/") v = expr[i++] === "*" ? v * primary() : v / primary();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = expr[i++] === "+" ? v + product() : v - product();
    return v;
  };
  const v = sum();
  if (i !== expr.length) throw new Error(`trailing input at ${i}: ${expr.slice(i)}`);
  return v;
}

/* ---------------------------------------------------------------- job ---------------------------------- */

describe("buildStudioJob", () => {
  it("maps plan shots to a valid StudioJob", () => {
    const job = buildStudioJob(plan, lamp, "FAST", "/tmp/studio/x");
    expect(StudioJob.parse(job)).toEqual(job);
    expect(job.shots.map((s) => [s.id, s.preset, s.technique, s.renderFps, s.overscan])).toEqual([
      ["sh01", "silhouette_reveal", "relight", 15, 1.18],
      ["sh02", "slow_turntable", "sequence", 8, 1],
      ["sh03", "macro_push", "plate", 15, 1.18],
      ["sh04", "camera_slide", "plate", 15, 1.18],
      ["sh05", "cta_hero", "plate", 15, 1.18],
    ]);
    expect(job.product).toMatchObject({
      modelPath: "/data/lamp/model.glb",
      modelSha: "a".repeat(64),
      format: "glb",
      realHeightM: 0.5512,
      emitsLight: true,
    });
    expect(job.product.emissiveHints).toContain("shade");
    expect(job.product.emissiveHints).not.toContain("lamp");
    expect(job.environment).toBe("warm_living");
    expect(job.output).toEqual({ dir: "/tmp/studio/x", width: 1080, height: 1920 });
    expect(job.camera).toEqual(plan.camera);
    expect(job.shots[2]!.params).toMatchObject({ fill: 1.5, focus: "middle", intensity: 0.5 });
  });

  it("keeps the job key and seed independent of the output dir and the variant", () => {
    const a = buildStudioJob(plan, lamp, "FAST", "/a");
    const b = buildStudioJob(
      { ...plan, metadata: { ...plan.metadata, variantKey: "B", seed: "other" } },
      lamp,
      "FAST",
      "/b",
    );
    expect(a.jobKey).toBe(b.jobKey);
    expect(a.seed).toBe(b.seed);
    expect(a.seed).toBe(studioSeed("a".repeat(64)));
    expect(buildStudioJob(plan, lamp, "QUALITY", "/a").jobKey).not.toBe(a.jobKey);
  });

  it("renders sequences at a rate the job can afford; FAST halves only the slow presets", () => {
    const job = buildStudioJob(plan, lamp, "QUALITY", "/q");
    expect(job.shots.find((s) => s.id === "sh02")!.renderFps).toBe(15);
    expect(sequenceRenderFps("turntable", "QUALITY")).toBe(15);
    expect(sequenceRenderFps("turntable", "FAST")).toBe(StudioProfileDefaults.FAST.sequenceFps);
    expect(sequenceRenderFps("slow_turntable", "FAST")).toBe(8);
  });

  it("tells Blender how far a plate's move slides, so the framing keeps the product inside", () => {
    const job = buildStudioJob(plan, lamp, "FAST", "/x");
    const travel = Object.fromEntries(job.shots.map((s) => [s.preset, s.travelX]));
    expect(travel).toEqual({
      silhouette_reveal: 0,
      slow_turntable: 0,
      macro_push: 0,
      camera_slide: plateTravelX({
        preset: "camera_slide",
        technique: "plate",
        params: plan.shots[3]!.params,
      }),
      cta_hero: 0,
    });
    expect(travel.camera_slide).toBeCloseTo(0.055, 4); // lerp(0.035, 0.075, 0.5)
  });

  it("honours the product profile's traits and refuses impossible jobs", () => {
    expect(buildStudioJob(plan, lamp, "FAST", "/x", { emitsLight: false }).product.emitsLight).toBe(false);
    expect(buildStudioJob(plan, chair, "FAST", "/x").product.emitsLight).toBe(false);
    const { model3d: _m, ...noModel } = lamp;
    expect(() => buildStudioJob(plan, noModel as ProductSource, "FAST", "/x")).toThrow(/no 3D model/);
    const mixed = {
      ...plan,
      shots: plan.shots.map((s, i) => (i === 1 ? { ...s, environment: "industrial" as const } : s)),
    };
    expect(() => buildStudioJob(mixed, lamp, "FAST", "/x")).toThrow(/mixes environments/);
    expect(blenderShotGroups(mixed).map((g) => g.map((s) => s.id))).toEqual([
      ["sh01", "sh03", "sh04", "sh05"],
      ["sh02"],
    ]);
    const photos = { ...plan, shots: plan.shots.map((s) => ({ ...s, source: "product_photo" as const })) };
    expect(blenderShotGroups(photos)).toEqual([]);
    expect(() => buildStudioJob(photos, lamp, "FAST", "/x")).toThrow(/no Blender shots/);
  });

  it("finds the real height from the model extent, else from a height fact", () => {
    expect(productRealHeightM(lamp)).toBe(0.5512);
    const noExtent = { ...lamp, model3d: { ...lamp.model3d!, extentM: undefined } };
    expect(productRealHeightM(noExtent)).toBeCloseTo(0.55118, 5);
    expect(productRealHeightM({ ...noExtent, facts: [] })).toBeUndefined();
    const silly = { ...lamp, model3d: { ...lamp.model3d!, extentM: { x: 1, y: 1, z: 300 } }, facts: [] };
    expect(productRealHeightM(silly)).toBeUndefined();
  });

  it("detects light-emitting products", () => {
    expect(inferEmitsLight(lamp)).toBe(true);
    expect(inferEmitsLight(chair)).toBe(false);
    expect(
      inferEmitsLight({
        ...chair,
        facts: [{ ...chair.facts[0]!, kind: "feature", text: "Integrated LED strip" }],
      }),
    ).toBe(true);
  });

  it("computes the render sizes Blender uses", () => {
    expect(studioRenderSize({ width: 1080, height: 1920 }, "FAST", "plate", 1.18)).toEqual({
      width: 956,
      height: 1699,
    });
    expect(studioRenderSize({ width: 1080, height: 1920 }, "FAST", "relight", 1.18)).toEqual({
      width: 956,
      height: 1699,
    });
    expect(studioRenderSize({ width: 1080, height: 1920 }, "FAST", "sequence", 1.18)).toEqual({
      width: 540,
      height: 960,
    });
    expect(studioRenderSize({ width: 1080, height: 1920 }, "QUALITY", "plate", 1.18)).toEqual({
      width: 1274,
      height: 2266,
    });
  });
});

describe("TS ⇄ Python contract sync", () => {
  const dir = studioToolsDir();

  it("profiles.json matches StudioProfileDefaults and the render scales", () => {
    const profiles = JSON.parse(fs.readFileSync(path.join(dir, "profiles.json"), "utf8")) as Record<
      string,
      Record<string, number>
    >;
    for (const p of ["FAST", "QUALITY"] as const) {
      const d = StudioProfileDefaults[p];
      expect(profiles[p]).toMatchObject({
        samples: d.samples,
        sequenceFps: d.sequenceFps,
        overscan: d.overscan,
        scale: d.scale,
      });
      expect(profiles[p]!.plateScale).toBe(STUDIO_RENDER_SCALE[p].plate);
    }
  });

  it("jobspec.py whitelists the same ids as contracts/ids.ts", () => {
    const src = fs.readFileSync(path.join(dir, "jobspec.py"), "utf8");
    const tuple = (name: string) => {
      const m = new RegExp(`^${name} = \\(([\\s\\S]*?)\\)$`, "m").exec(src);
      return [...(m?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    };
    expect(tuple("SHOT_PRESETS")).toEqual([...SHOT_PRESETS]);
    expect(tuple("ENVIRONMENTS")).toEqual([...STUDIO_ENVIRONMENTS]);
    expect(tuple("LIGHTING_PRESETS")).toEqual([...LIGHTING_PRESETS]);
    expect(tuple("PRODUCT_ANIMATIONS")).toEqual([...PRODUCT_ANIMATIONS]);
  });
});

/* ---------------------------------------------------------------- cache keys --------------------------- */

describe("studioCacheKey", () => {
  const job = buildStudioJob(plan, lamp, "FAST", "/w");
  const code = "c0de";
  const renderer = "bpy 5.2.2 LTS d13f752e3b9c";
  const key = (j = job, i = 2, codeVersion = code) =>
    studioCacheKey(j.shots[i]!, j, { codeVersion, renderer });
  const withShot = (i: number, patch: object) => ({
    ...job,
    shots: job.shots.map((s, k) => (k === i ? { ...s, ...patch } : s)),
  });

  it("ignores what cannot change the pixels", () => {
    expect(key(withShot(2, { id: "sh07" }))).toBe(key());
    expect(key(withShot(2, { durationMs: 4000, renderFps: 30 }))).toBe(key()); // a plate's timing is FFmpeg's
    expect(key({ ...job, output: { ...job.output, dir: "/elsewhere" }, jobKey: "other" })).toBe(key());
    expect(key({ ...job, camera: { ...job.camera, motionBlur: !job.camera.motionBlur } })).toBe(key());
    const noDof = { ...job, camera: { ...job.camera, dof: { enabled: false, fStop: 4 } } };
    expect(key({ ...noDof, camera: { ...noDof.camera, dof: { enabled: false, fStop: 11 } } })).toBe(
      key(noDof),
    );
    const reordered = {
      ...job,
      product: { ...job.product, emissiveHints: [...job.product.emissiveHints].reverse() },
    };
    expect(key(reordered)).toBe(key());
  });

  it("changes with everything that can", () => {
    const base = key();
    expect(key(withShot(2, { overscan: 1.3 }))).not.toBe(base);
    expect(key(withShot(2, { params: { ...job.shots[2]!.params, fill: 1.2 } }))).not.toBe(base);
    expect(key(withShot(2, { lighting: "top_spot" }))).not.toBe(base);
    expect(key({ ...job, product: { ...job.product, modelSha: "b".repeat(64) } })).not.toBe(base);
    expect(key({ ...job, environment: "industrial" })).not.toBe(base);
    expect(key({ ...job, profile: "QUALITY" })).not.toBe(base);
    expect(key({ ...job, camera: { ...job.camera, lensMm: 85 } })).not.toBe(base);
    expect(key({ ...job, seed: 1 })).not.toBe(base);
    expect(key(job, 2, "other-code")).not.toBe(base);
    expect(
      studioCacheKey(job.shots[2]!, job, { codeVersion: code, renderer, overrides: { samples: 4 } }),
    ).not.toBe(base);
    // another Blender build renders other pixels (Cycles, OIDN, colour management, importers)
    expect(studioCacheKey(job.shots[2]!, job, { codeVersion: code, renderer: "bpy 5.3.0" })).not.toBe(base);
    expect(key(withShot(2, { travelX: 0.07 }))).not.toBe(base);
    // a sequence's duration and frame rate are rendered frames
    expect(key(withShot(1, { durationMs: 4000 }), 1)).not.toBe(key(job, 1));
    expect(key(withShot(1, { renderFps: 15 }), 1)).not.toBe(key(job, 1));
    expect(key({ ...job, camera: { ...job.camera, motionBlur: !job.camera.motionBlur } }, 1)).not.toBe(
      key(job, 1),
    );
  });

  it("does not depend on the job's other shots", () => {
    expect(shotRenderInputs(job.shots[2]!, { ...job, shots: [job.shots[2]!] })).toEqual(
      shotRenderInputs(job.shots[2]!, job),
    );
  });

  it("hashes the studio's python code but not its tests", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-code-"));
    fs.writeFileSync(path.join(tmp, "run.py"), "print(1)\n");
    fs.writeFileSync(path.join(tmp, "test_x.py"), "a\n");
    const v1 = studioCodeVersion(tmp);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "studio-code-"));
    fs.writeFileSync(path.join(tmp2, "run.py"), "print(1)\n");
    fs.writeFileSync(path.join(tmp2, "test_x.py"), "b\n");
    expect(studioCodeVersion(tmp2)).toBe(v1);
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "studio-code-"));
    fs.writeFileSync(path.join(tmp3, "run.py"), "print(2)\n");
    expect(studioCodeVersion(tmp3)).not.toBe(v1);
    expect(studioCodeVersion()).toMatch(/^[0-9a-f]{16}$/);
    for (const d of [tmp, tmp2, tmp3]) fs.rmSync(d, { recursive: true });
  });
});

/* ---------------------------------------------------------------- moves -------------------------------- */

describe("plate moves", () => {
  const easings: Easing[] = ["linear", "inOut", "out", "punch"];
  const techniques: ShotTechnique[] = ["plate", "relight"];

  it("easings start at 0, end at 1 and agree with their FFmpeg expressions", () => {
    for (const e of easings) {
      expect(ease(e, 0)).toBeCloseTo(0, 9);
      expect(ease(e, 1)).toBeCloseTo(e === "punch" ? 1.02 : 1, 9);
      for (let k = 0; k <= 50; k++)
        expect(evalFf(easeExpr(e, "T"), { T: k / 50 })).toBeCloseTo(ease(e, k / 50), 9);
    }
    expect(Math.max(...Array.from({ length: 29 }, (_, k) => ease("punch", k / 100)))).toBeGreaterThan(1.05);
  });

  it("FFmpeg window expressions equal windowAt for every preset", () => {
    for (const preset of SHOT_PRESETS)
      for (const technique of techniques)
        for (const intensity of [0, 0.5, 1]) {
          const move = plateMove(preset, { intensity, angleDeg: -25 }, technique);
          const w = windowExprs(move, 1.18, "T");
          for (const t of [0, 0.1, 0.27, 0.5, 0.9, 1]) {
            const win = windowAt(move, 1.18, t);
            expect(evalFf(w.left, { T: t })).toBeCloseTo(win.x, 6); // printed to 1e-7 of the plate = 0.0002 px
            expect(evalFf(w.top, { T: t })).toBeCloseTo(win.y, 6);
            expect(evalFf(w.right, { T: t })).toBeCloseTo(win.x + win.s, 6);
            expect(evalFf(w.bottom, { T: t })).toBeCloseTo(win.y + win.s, 6);
          }
        }
  });

  it("every move fits the profile's default overscan and stays inside the plate", () => {
    for (const preset of SHOT_PRESETS)
      for (const technique of techniques)
        for (const intensity of [0, 0.3, 1])
          for (const angleDeg of [-90, 25]) {
            const move = plateMove(preset, { intensity, angleDeg }, technique);
            expect(requiredOverscan(move)).toBeLessThanOrEqual(StudioProfileDefaults.FAST.overscan + 1e-9);
            const o = plateOverscan({ preset, technique, params: { intensity, angleDeg } as never }, "FAST");
            expect(o).toBe(1.18);
            for (let k = 0; k <= 40; k++) {
              const w = windowAt(move, o, k / 40);
              expect(w.x).toBeGreaterThanOrEqual(-1e-9);
              expect(w.y).toBeGreaterThanOrEqual(-1e-9);
              expect(w.x + w.s).toBeLessThanOrEqual(1 + 1e-9);
              expect(w.y + w.s).toBeLessThanOrEqual(1 + 1e-9);
            }
          }
  });

  it("push ends and pull starts on the composed frame (the centre 1/overscan of the plate)", () => {
    const composed = { x: 0.5 - 0.5 / 1.18, y: 0.5 - 0.5 / 1.18, s: 1 / 1.18 };
    const push = plateMove("hero_reveal", { intensity: 0.6, angleDeg: -25 });
    expect(push.kind).toBe("push");
    for (const [k, v] of Object.entries(windowAt(push, 1.18, 1)))
      expect(v).toBeCloseTo(composed[k as "x"], 12);
    expect(windowAt(push, 1.18, 0).s).toBeCloseTo((1 + 0.08 + 0.1 * 0.6) / 1.18, 12);
    const pull = plateMove("macro_pull", { intensity: 0.6, angleDeg: -25 });
    expect(windowAt(pull, 1.18, 0).s).toBeCloseTo(composed.s, 12);
    expect(windowAt(pull, 1.18, 1).s).toBeGreaterThan(composed.s);
  });

  it("reports the sideways travel of every move (the margin Blender keeps around the product)", () => {
    expect(windowTravelX(plateMove("camera_slide", { intensity: 1, angleDeg: -25 }))).toBe(0.075);
    expect(windowTravelX(plateMove("camera_slide", { intensity: 0, angleDeg: 25 }))).toBe(0.035);
    expect(windowTravelX(plateMove("detail_closeup", { intensity: 1, angleDeg: 25 }))).toBe(0.045);
    for (const preset of SHOT_PRESETS) {
      const params = { intensity: 1, angleDeg: -25 } as never;
      if (preset !== "camera_slide" && preset !== "detail_closeup")
        expect(plateTravelX({ preset, technique: "plate", params })).toBe(0);
      expect(plateTravelX({ preset, technique: "relight", params })).toBe(0);
      expect(plateTravelX({ preset, technique: "sequence", params })).toBe(0);
    }
  });

  it("slides follow the side the product faces; relights only drift", () => {
    const right = plateMove("camera_slide", { intensity: 1, angleDeg: -25 });
    const left = plateMove("camera_slide", { intensity: 1, angleDeg: 25 });
    expect(windowAt(right, 1.18, 1).x).toBeGreaterThan(windowAt(right, 1.18, 0).x);
    expect(windowAt(left, 1.18, 1).x).toBeLessThan(windowAt(left, 1.18, 0).x);
    expect(windowAt(right, 1.18, 0.5).x).toBeCloseTo(0.5 - 0.5 / 1.18, 12);
    expect(plateMove("camera_slide", { intensity: 1, angleDeg: -25 }, "relight").kind).toBe("drift");
    expect(plateMove("impact", { intensity: 1, angleDeg: 0 }).kind).toBe("punch");
    expect(plateMove("low_angle", { intensity: 1, angleDeg: 0 }).kind).toBe("rise");
  });

  it("maps a plate box through a window to output pixels", () => {
    const box = { x: 0.25, y: 0.2, w: 0.5, h: 0.6 };
    expect(boxThroughWindow(box, { x: 0, y: 0, s: 1 }, 1080, 1920)).toEqual({
      x: 270,
      y: 384,
      w: 540,
      h: 1152,
    });
    const r = boxThroughWindow(box, { x: 0.5 - 0.5 / 1.18, y: 0.5 - 0.5 / 1.18, s: 1 / 1.18 }, 1080, 1920);
    expect(r.w).toBeCloseTo(540 * 1.18, 0);
    expect(r.x + r.w / 2).toBeCloseTo(540, 0); // a centred box stays centred
  });

  it("samples the track every 100 ms up to the last frame", () => {
    const t = trackTimes(3000, 30);
    expect(t[0]).toBe(0);
    expect(t[1]).toBe(100);
    expect(t.at(-1)).toBe(2967);
    expect(trackTimes(500, 30).at(-1)).toBe(467);
  });
});

/* ---------------------------------------------------------------- ffmpeg arguments --------------------- */

describe("buildShotClipArgs", () => {
  const box = { x: 0.2, y: 0.25, w: 0.6, h: 0.5 };
  const base = { fps: 30, width: 1080, height: 1920, dir: "/cache/s1", outPath: "/out/clip.mp4" };
  const planShot = (preset: ShotPreset, technique: ShotTechnique, durationMs = 3000) => ({
    preset,
    technique,
    durationMs,
    params: {
      intensity: 0.5,
      angleDeg: -25,
      height: 0.55,
      focus: "whole" as const,
      fill: 0.62,
      sweepDeg: 40,
    },
  });

  it("plate: looped still, per-frame sub-pixel crop window, exact frame count, BT.709", () => {
    const r = buildShotClipArgs({
      ...base,
      shot: {
        technique: "plate",
        files: ["plate.png"],
        renderFps: 15,
        productBoxes: [box],
        overscan: 1.18,
        width: 956,
        height: 1699,
      },
      planShot: planShot("hero_reveal", "plate"),
    });
    expect(r.frameCount).toBe(90);
    expect(r.args.slice(0, 8)).toEqual([
      "-loop",
      "1",
      "-framerate",
      "30",
      "-t",
      "3.0667",
      "-i",
      "/cache/s1/plate.png",
    ]);
    const graph = r.args[r.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("perspective=");
    expect(graph).toContain("clip((in-1)/89,0,1)");
    expect(graph).toContain(":interpolation=cubic:eval=frame");
    expect(graph).toContain("scale=1080:1920:flags=lanczos:out_color_matrix=bt709:out_range=tv");
    expect(r.args).toEqual(
      expect.arrayContaining(["-frames:v", "90", "-an", "-crf", "14", "-colorspace", "bt709"]),
    );
    expect(r.args.at(-1)).toBe("/out/clip.mp4");
    // push-in: the product grows into its composed size (box × overscan on the frame)
    const first = r.productTrack[0]!.rect;
    const last = r.productTrack.at(-1)!.rect;
    expect(first.h).toBeLessThan(last.h);
    expect(last.h).toBeCloseTo(0.5 * 1.18 * 1920, 0);
    expect(last.x + last.w / 2).toBeCloseTo(540, 0);
    expect(r.productTrack.at(-1)!.tMs).toBe(2967);
  });

  it("relight: 16-bit linear-light cross-fade at 30 % of the shot, then the move", () => {
    const r = buildShotClipArgs({
      ...base,
      shot: {
        technique: "relight",
        files: ["off.png", "on.png"],
        renderFps: 15,
        productBoxes: [box, box],
        overscan: 1.18,
        width: 956,
        height: 1699,
      },
      planShot: planShot("silhouette_reveal", "relight", 2000),
    });
    expect(r.args.filter((a) => a === "-i")).toHaveLength(2);
    expect(r.args).toContain("/cache/s1/off.png");
    expect(r.args).toContain("/cache/s1/on.png");
    const graph = r.args[r.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toMatch(/^\[0:v\]format=gbrp16le,lutrgb=/);
    expect(graph).toContain("xfade=transition=fade:duration=0.2333:offset=0.6000");
    expect(graph.indexOf("xfade")).toBeLessThan(graph.indexOf("perspective"));
    expect(r.move?.kind).toBe("drift");
    expect(r.frameCount).toBe(60);
  });

  it("sequence: frames at renderFps, motion-interpolated to the reel fps", () => {
    const files = Array.from({ length: 25 }, (_, k) => `f_${String(k + 1).padStart(4, "0")}.png`);
    const boxes = files.map((_, k) => ({ ...box, x: 0.2 + k * 0.001 }));
    const r = buildShotClipArgs({
      ...base,
      shot: { technique: "sequence", files, renderFps: 8, productBoxes: boxes, width: 540, height: 960 },
      planShot: planShot("slow_turntable", "sequence"),
    });
    expect(r.args.slice(0, 6)).toEqual([
      "-framerate",
      "8",
      "-start_number",
      "1",
      "-i",
      "/cache/s1/f_%04d.png",
    ]);
    const graph = r.args[r.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("tpad=stop_mode=clone:stop=2,minterpolate=fps=30:mi_mode=mci");
    expect(r.productTrack[1]).toEqual({ tMs: 125, rect: { x: 217.1, y: 480, w: 648, h: 960 } });
    expect(r.productTrack.at(-1)!.tMs).toBeLessThanOrEqual(3000);
    const full = buildShotClipArgs({
      ...base,
      shot: { technique: "sequence", files, renderFps: 30, productBoxes: boxes, width: 540, height: 960 },
      planShot: planShot("turntable", "sequence", 800),
    });
    expect(full.args[full.args.indexOf("-filter_complex") + 1]).toContain(",fps=30,");
    expect(() =>
      buildShotClipArgs({
        ...base,
        shot: {
          technique: "sequence",
          files: ["f_0001.png", "f_0003.png"],
          renderFps: 8,
          productBoxes: [box, box],
          width: 540,
          height: 960,
        },
        planShot: planShot("turntable", "sequence", 500),
      }),
    ).toThrow(/sequence frame 1/);
  });
});

/* ---------------------------------------------------------------- bridge ------------------------------- */

describe("studio bridge", () => {
  it("runs a bpy python or a Blender executable — never a shell", () => {
    expect(studioCommand({ blenderPython: "/py", blenderBin: null }, "/w/job.json", "/s/run.py")).toEqual({
      command: "/py",
      args: ["-B", "/s/run.py", "/w/job.json"],
    });
    const bin = studioCommand(
      { blenderPython: null, blenderBin: "/opt/blender" },
      "/w/job.json",
      "/s/run.py",
    );
    expect(bin.command).toBe("/opt/blender");
    expect(bin.args).toEqual([
      "-b",
      "--factory-startup",
      "-noaudio",
      "--python-exit-code",
      "1",
      "--python",
      "/s/run.py",
      "--",
      "/w/job.json",
    ]);
    expect(() => studioCommand({ blenderPython: null, blenderBin: null }, "/w/job.json")).toThrow(
      /BLENDER_PYTHON/,
    );
  });

  it("passes no secrets to Blender", () => {
    const env = studioEnv(
      { blenderThreads: 3 },
      { samples: 4, scale: 0.5 },
      {
        PATH: "/bin",
        HOME: "/root",
        GOOGLE_API_KEY: "secret",
        ELEVENLABS_API_KEY: "secret",
        DATABASE_URL: "postgres://",
      },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/root",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      BLENDER_THREADS: "3",
      STUDIO_SAMPLES: "4",
      STUDIO_SCALE: "0.5",
    });
    expect(studioEnv({ blenderThreads: 0 }, {}, {}).BLENDER_THREADS).toBeUndefined();
  });

  it("parses progress lines and counts frames", () => {
    expect(parseProgressLine("PROGRESS shot=sh02 frame=3/46 ms=7450")).toEqual({
      shotId: "sh02",
      frame: 3,
      total: 46,
      ms: 7450,
    });
    expect(parseProgressLine("PHASE scene ms=300")).toBeNull();
    expect(studioFrameCount(buildStudioJob(plan, lamp, "FAST", "/x"))).toBe(2 + 25 + 1 + 1 + 1);
  });

  it("validates file names in Blender's result before using them as paths", () => {
    const ok = {
      id: "sh01",
      technique: "relight",
      files: ["off.png", "on.png"],
      width: 956,
      height: 1699,
      renderFps: 15,
      productBoxes: [
        { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
        { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
      ],
      samples: 12,
      renderMs: 1000,
      engine: "CYCLES",
      blenderVersion: "5.2.2",
      fallbackPreset: "orbit",
      somethingNew: 1,
    };
    expect(StudioShotOutput.parse(ok).fallbackPreset).toBe("orbit");
    const asPlate = {
      ...ok,
      technique: "plate",
      files: ["plate.png"],
      productBoxes: [ok.productBoxes[0]],
      fallbackTechnique: "plate",
      fallbackTechniqueReason: "the product has no light of its own to switch on: one plate at full light",
    };
    expect(StudioShotOutput.parse(asPlate).fallbackTechnique).toBe("plate");
    expect(() => StudioShotOutput.parse({ ...asPlate, fallbackTechnique: "veo" })).toThrow();
    expect(() => StudioShotOutput.parse({ ...ok, files: ["../../etc/passwd", "on.png"] })).toThrow();
    expect(() =>
      StudioShotOutput.parse({
        ...ok,
        technique: "plate",
        files: ["off.png"],
        productBoxes: [ok.productBoxes[0]],
      }),
    ).toThrow();
    expect(() => StudioShotOutput.parse({ ...ok, productBoxes: [ok.productBoxes[0]] })).toThrow(
      /one product box/,
    );
    expect(() => StudioShotOutput.parse({ ...ok, fallbackPreset: "warp" })).toThrow();
  });
});
