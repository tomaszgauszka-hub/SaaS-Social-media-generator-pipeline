import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnv } from "@cre/config";
import { LocalStorageProvider } from "@cre/providers";
import { describe, expect, it } from "vitest";
import { FileAssetLibrary } from "../library/library.ts";
import { createRender3D } from "../setup.ts";
import { FakeEngine } from "../testing/fake-engine.ts";
import { handleMessage, TOOLS } from "./protocol.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render3d-mcp-"));
const storage = new LocalStorageProvider(path.join(dir, "s"));
const setup = () =>
  createRender3D(getEnv(), {
    storage,
    library: new FileAssetLibrary(path.join(dir, "lib"), storage),
    blender: new FakeEngine("blender"),
    unreal: new FakeEngine("unreal", { available: false }),
  });

const call = (name: string, args: Record<string, unknown>) =>
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, setup);

describe("render3d MCP server", () => {
  it("initializes and lists a closed set of tools with JSON schemas — no code execution, no approval", async () => {
    const init = await handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, setup);
    expect((init?.result as { serverInfo: { name: string } }).serverInfo.name).toBe("render3d");
    const list = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, setup);
    const names = (list?.result as { tools: { name: string; inputSchema: unknown }[] }).tools.map(
      (t) => t.name,
    );
    expect(names).toEqual(TOOLS.map((t) => t.name));
    expect(names.some((n) => /exec|code|approve|publish|shell/.test(n))).toBe(false);
  });

  it("validates recipes and routes them as a dry run", async () => {
    const bad = await call("render3d_validate_recipe", { recipe: { template: "NOPE" } });
    const parsed = JSON.parse((bad?.result as { content: { text: string }[] }).content[0]!.text) as {
      ok: boolean;
    };
    expect(parsed.ok).toBe(false);
    await call("render3d_render", {
      recipe: {
        template: "PRODUCT_HERO",
        productAssetId: "demo-drill-20v",
        durationSec: 0.5,
        fps: 24,
        resolution: [256, 456],
      },
      demoProduct: "demo-drill-20v",
    }).catch(() => null);
    const route = await call("render3d_route", {
      recipe: { template: "TURNTABLE_360", productAssetId: "demo-drill-20v", durationSec: 2 },
    });
    const d = JSON.parse((route?.result as { content: { text: string }[] }).content[0]!.text) as {
      engine: string;
    };
    expect(["BLENDER", "EXISTING_ASSET"]).toContain(d.engine);
  });

  it("rejects unknown tools and invalid arguments without throwing", async () => {
    const unknown = await call("render3d_exec", {});
    expect(unknown?.error).toBeTruthy();
    const invalid = await call("render3d_asset", { assetId: "../x" });
    expect((invalid?.result as { isError: boolean }).isError).toBe(true);
  });

  it("ignores notifications", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, setup)).toBeNull();
  });
});
