import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EngineUnavailableError,
  type EngineCapabilities,
  type EngineId,
  type EngineRenderOutput,
  type EngineRenderRequest,
  type RenderEngine,
} from "../contracts/engine.ts";
import { frameCount, renderSize } from "../routing/estimate.ts";

/*
 * TEST ENGINE — renders no 3D. It writes a PNG sequence with FFmpeg (a grey frame with a moving light box that
 * stands in for "the product") so the worker's encode → QA → library path can be exercised without Blender.
 * Every output it produces is marked { mock: true }.
 */

export const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

export class FakeEngine implements RenderEngine {
  renders = 0;
  lastRequest: EngineRenderRequest | null = null;

  constructor(
    readonly id: EngineId = "blender",
    private readonly opts: {
      available?: boolean;
      version?: string;
      gpu?: boolean;
      /** frame colour (e.g. "black" to trigger the black-frame check) */
      color?: string;
      delayMs?: number;
      fail?: Error;
    } = {},
  ) {}

  probe(): Promise<EngineCapabilities> {
    const available = this.opts.available ?? true;
    return Promise.resolve({
      engine: this.id,
      available,
      version: this.opts.version ?? (this.id === "blender" ? "Blender 4.3.0" : "Unreal Engine 5.8.0"),
      reason: available ? null : "test engine offline",
      gpu: { available: this.opts.gpu ?? false, name: this.opts.gpu ? "Test GPU" : null, vramMb: null },
      renderers: ["TEST"],
      host: os.hostname(),
    });
  }

  async render(req: EngineRenderRequest): Promise<EngineRenderOutput> {
    if (!(this.opts.available ?? true)) throw new EngineUnavailableError(this.id, "test engine offline");
    this.renders++;
    this.lastRequest = req;
    if (this.opts.fail) throw this.opts.fail;
    if (this.opts.delayMs)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    const n = frameCount(req.recipe.durationSec, req.recipe.fps);
    const [w, h] = renderSize(req.recipe);
    const framesDir = path.join(req.workDir, "out", "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const color = this.opts.color ?? "0x6a6f78";
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=${w}x${h}:r=${req.recipe.fps}:d=${(n / req.recipe.fps).toFixed(4)}`,
      "-vf",
      `drawbox=x='iw*0.3+iw*0.1*t':y=ih*0.35:w=iw*0.35:h=ih*0.3:color=0xd0b080:t=fill`,
      "-frames:v",
      String(n),
      "-start_number",
      "1",
      path.join(framesDir, "f_%04d.png"),
    ]);
    const boxes = Array.from({ length: n }, (_, i) => {
      const t = i / req.recipe.fps;
      const u0 = 0.3 + 0.1 * t;
      return [u0, 0.35, u0 + 0.35, 0.65];
    });
    return {
      framesDir,
      framePattern: "f_%04d.png",
      startNumber: 1,
      frameCount: n,
      width: w,
      height: h,
      fps: req.recipe.fps,
      alpha: false,
      productBoxes: boxes,
      anchorTracks: { chuck: boxes.map((b) => [b[0]!, 0.5] as [number, number]) },
      controlViews: [],
      exports: {},
      materialReport: { mock: true },
      sceneFile: null,
      engineVersion: this.opts.version ?? "Blender 4.3.0",
      device: "CPU",
      warnings: [],
      geometryHash: "a".repeat(64),
      materialHash: "b".repeat(64),
      parts: [{ name: "chuck", role: "detail", verified: true, internal: false }],
      actions: [],
      timings: { totalMs: 10, renderMs: 10, frameMs: Array.from({ length: n }, () => 5) },
      raw: { mock: true },
    };
  }
}
