import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFromRoot } from "@cre/config";
import { probeMedia } from "@cre/media";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallContext } from "../capabilities/types.ts";
import { ProductSource } from "../contracts/product.ts";
import { CostTracker } from "../cost/tracker.ts";
import { testPlan } from "../testing/fixtures.ts";
import { resolveReelTools } from "../util/tools.ts";
import { produceShotClips } from "./produce.ts";

/*
 * Smoke test with the real Blender studio and the real product (ABO B075X2FZSM table lamp, CC BY 4.0): one tiny
 * plate (270×480 composed, 4 samples) → a 1 s 1080×1920 clip; the second call must be a pure cache hit.
 */

const MODEL = resolveFromRoot(".data/products/abo/B075X2FZSM/model.glb");
const tools = resolveReelTools();
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const ready = hasFfmpeg && Boolean(tools.blenderPython ?? tools.blenderBin) && fs.existsSync(MODEL);

const lamp = ProductSource.parse({
  id: "B075X2FZSM",
  source: { kind: "abo", ref: "abo:B075X2FZSM", license: "CC BY 4.0" },
  brand: "Rivet",
  names: { "en-US": "Rivet Mid-Century Modern Table Lamp" },
  category: "lamp",
  facts: [],
  images: [],
  model3d: { path: MODEL, format: "glb", license: "CC BY 4.0", extentM: { x: 0.3632, y: 0.3632, z: 0.5512 } },
});

const plan = testPlan({
  shots: [
    {
      id: "sh01",
      role: "HOOK",
      startMs: 0,
      durationMs: 1000,
      preset: "hero_reveal",
      technique: "plate",
      environment: "dark_premium",
      lighting: "rim_dramatic",
      params: { intensity: 0.6 },
      productAnimation: "none",
      transitionIn: { type: "cut", ms: 0 },
      source: "blender",
    },
    {
      id: "sh02",
      role: "CTA",
      startMs: 1000,
      durationMs: 4000,
      preset: "cta_hero",
      technique: "plate",
      environment: "dark_premium",
      lighting: "three_point",
      params: {},
      productAnimation: "none",
      transitionIn: { type: "cut", ms: 0 },
      source: "product_photo",
    },
  ],
});

describe.skipIf(!ready)("Blender studio smoke test (real lamp model)", () => {
  let dir: string;
  let ctx: CallContext;
  let tracker: CostTracker;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-smoke-"));
    tracker = new CostTracker();
    ctx = { workDir: path.join(dir, "work"), cacheDir: path.join(dir, "cache"), scope: "master", tracker };
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("renders a plate of the real lamp, encodes a 1 s clip and reuses it from the cache", async () => {
    const overrides = { samples: 4, scale: 1 / 3 };
    const t0 = Date.now();
    const first = await produceShotClips(plan, lamp, "FAST", ctx, { overrides });
    const firstMs = Date.now() - t0;
    expect(first.skipped).toEqual([
      { shotId: "sh02", reason: 'source "product_photo" is not rendered by the studio' },
    ]);
    expect(first.studioRuns).toBe(1);
    expect(first.clips).toHaveLength(1);
    const [info] = first.shots;
    expect(info).toMatchObject({
      shotId: "sh01",
      renderHit: false,
      clipHit: false,
      technique: "plate",
      frames: 1,
    });
    expect(info!.renderSize).toEqual({ width: 319, height: 566 }); // 270×480 composed × overscan 1.18
    const clip = first.clips[0]!;
    const media = await probeMedia(clip.path);
    expect([media.width, media.height, media.fps, media.hasAudio]).toEqual([1080, 1920, 30, false]);
    expect(media.durationMs).toBeCloseTo(1000, -1);
    // the lamp ends the push-in at its composed framing: 62 % of the frame height, centred
    const end = clip.productTrack.at(-1)!.rect;
    expect(end.h / 1920).toBeGreaterThan(0.55);
    expect(end.h / 1920).toBeLessThan(0.7);
    expect(Math.abs(end.x + end.w / 2 - 540)).toBeLessThan(40);
    expect(end.y).toBeGreaterThan(0);
    expect(end.y + end.h).toBeLessThan(1920);
    expect(
      tracker.computeEntries.filter((e) => e.stage === "blender" && !e.cached).length,
    ).toBeGreaterThanOrEqual(2);
    expect(tracker.computeEntries.some((e) => e.stage === "ffmpeg")).toBe(true);

    const t1 = Date.now();
    const again = await produceShotClips(plan, lamp, "FAST", ctx, { overrides });
    const againMs = Date.now() - t1;
    expect(again.studioRuns).toBe(0);
    expect(again.shots[0]).toMatchObject({ renderHit: true, clipHit: true, renderMs: 0 });
    expect(again.clips[0]).toMatchObject({
      path: clip.path,
      cacheHit: true,
      productTrack: clip.productTrack,
    });
    expect(againMs).toBeLessThan(firstMs);
  }, 180_000);
});
