import { describe, expect, it } from "vitest";
import { LocalCostAssumptions, localRenderCost } from "../cost/local.ts";
import { Recipe3D } from "../contracts/recipe.ts";
import { estimateRender, renderFps, renderSize } from "../routing/estimate.ts";
import { bestFrame, h264Args, videoFilter, xstackLayout } from "./encode.ts";
import { parseGpuSample, parseNvidiaSmi } from "./gpu.ts";

describe("encoder helpers", () => {
  it("interpolates a preview rendered at 15 fps up to the clip fps, and only then", () => {
    expect(videoFilter(15, 30)).toMatch(/^tpad=.*minterpolate=fps=30:mi_mode=mci/);
    expect(videoFilter(30, 30)).not.toMatch(/minterpolate/);
    const args = h264Args("/f/f_%04d.png", 1, 15, "/o.mp4", "preview", 30, 90);
    expect(args.slice(args.indexOf("-framerate"), args.indexOf("-framerate") + 2)).toEqual([
      "-framerate",
      "15",
    ]);
    expect(args).toContain("-frames:v");
    expect(args).not.toContain("-filter_complex");
  });

  it("lays out control views 3 per row and picks the frame with the largest product", () => {
    expect(xstackLayout(6, 3)).toBe("0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0");
    expect(
      bestFrame(
        [
          [0.4, 0.4, 0.5, 0.5],
          [0.1, 0.1, 0.9, 0.9],
          [0.2, 0.2, 0.3, 0.3],
        ],
        3,
      ),
    ).toBe(1);
    // a box mostly outside the frame does not win
    expect(
      bestFrame(
        [
          [0.3, 0.3, 0.7, 0.7],
          [-2, -2, 0.1, 0.1],
        ],
        2,
      ),
    ).toBe(0);
  });
});

describe("estimates and local cost", () => {
  const recipe = Recipe3D.parse({ template: "PRODUCT_HERO", productAssetId: "p", durationSec: 4 });

  it("preview renders half size at 15 fps; production full size at the clip fps", () => {
    expect(renderSize(recipe)).toEqual([540, 960]);
    expect(renderFps(recipe)).toBe(15);
    expect(renderFps({ ...recipe, quality: "production" })).toBe(30);
    const p = estimateRender(recipe, "blender", "CPU");
    expect(p.frames).toBe(60);
    const q = estimateRender({ ...recipe, quality: "production" }, "blender", "CPU");
    expect(q.frames).toBe(120);
    expect(q.totalMs).toBeGreaterThan(p.totalMs * 10);
    expect(estimateRender(recipe, "blender", "GPU").totalMs).toBeLessThan(p.totalMs);
  });

  it("learns the unit time from telemetry once there are samples", () => {
    const fast = estimateRender(recipe, "blender", "CPU", [
      { engine: "blender", device: "CPU", quality: "preview", unitMs: 100 },
      { engine: "blender", device: "CPU", quality: "preview", unitMs: 100 },
    ]);
    expect(fast.source).toBe("telemetry");
    expect(fast.msPerFrame).toBeLessThan(estimateRender(recipe, "blender", "CPU").msPerFrame);
  });

  it("local rendering costs energy and hardware wear, not zero", () => {
    const a = LocalCostAssumptions.parse({});
    const c = localRenderCost(3_600_000, "CPU", a);
    expect(c.energyKwh).toBeCloseTo(0.14);
    expect(c.energyUsd).toBeCloseTo(0.042);
    expect(c.amortizationUsd).toBeCloseTo(2200 / 8760, 5);
    expect(c.usd).toBeGreaterThan(0.25);
    expect(localRenderCost(3_600_000, "GPU", a).energyUsd).toBeGreaterThan(c.energyUsd);
  });
});

describe("GPU probe parsing", () => {
  it("parses nvidia-smi CSV", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4070, 12282\n")).toEqual({
      available: true,
      name: "NVIDIA GeForce RTX 4070",
      vramMb: 12282,
    });
    expect(parseNvidiaSmi("")).toEqual({ available: false, name: null, vramMb: null });
    expect(parseGpuSample("87, 5120")).toEqual({ utilPct: 87, memUsedMb: 5120 });
  });
});
