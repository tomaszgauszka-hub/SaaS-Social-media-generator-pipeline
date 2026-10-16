import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveUnrealConfig } from "./config.ts";
import { buildUeSceneJob } from "./job.ts";
import {
  buildWhitelistedCommand,
  decodeMessage,
  encodeMessage,
  isLoopbackAddress,
  JsonObjectSplitter,
  UeRemoteExecClient,
} from "./remote-exec.ts";
import { makeRequest } from "./testing/fixtures.ts";
import { MockUeRemoteNode } from "./testing/mock-ue-remote.ts";

/* The remote-execution client against a MOCK editor node (testing/mock-ue-remote.ts) — not a UE editor. */

let tmp: string;
const scriptsDir = resolveUnrealConfig({}, {}, {}).scriptsDir;
const whitelist = () => ({ scriptsDir, allowedRoots: [tmp] });

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ue-remote-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sceneJob(interactive: boolean): string {
  const model = path.join(tmp, "product.glb");
  fs.writeFileSync(model, "MOCK GLB");
  const { job } = buildUeSceneJob(makeRequest(tmp, model), path.join(tmp, "ue"), {
    sha256: "a".repeat(64),
    materialReport: null,
    bakedTextures: {},
    executor: "pie",
    gi: "auto",
    maxRenderSec: 600,
    interactive,
  });
  const file = path.join(tmp, `job-${interactive}.json`);
  fs.writeFileSync(file, JSON.stringify(job));
  return file;
}

async function multicastWorks(port: number): Promise<boolean> {
  const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.bind(port, "0.0.0.0", () => resolve());
    });
    s.addMembership("239.0.0.1", "127.0.0.1");
    return true;
  } catch {
    return false;
  } finally {
    s.close();
  }
}

describe("protocol pieces", () => {
  it("encodes and decodes the ue_py envelope", () => {
    const raw = encodeMessage("open_connection", "me", "node", {
      command_ip: "127.0.0.1",
      command_port: 6776,
    });
    expect(JSON.parse(raw.toString())).toEqual({
      version: 1,
      magic: "ue_py",
      type: "open_connection",
      source: "me",
      dest: "node",
      data: { command_ip: "127.0.0.1", command_port: 6776 },
    });
    expect(decodeMessage(raw)?.type).toBe("open_connection");
    expect(decodeMessage('{"version":2,"magic":"ue_py","type":"ping","source":"x"}')).toBeNull();
    expect(decodeMessage('{"version":1,"magic":"py","type":"ping","source":"x"}')).toBeNull();
    expect(decodeMessage('{"version":1,"magic":"ue_py","type":"shell","source":"x"}')).toBeNull();
    expect(decodeMessage("garbage")).toBeNull();
  });

  it("reassembles JSON objects from a TCP stream", () => {
    const s = new JsonObjectSplitter();
    const a = Buffer.from('{"a":"}{\\"","b":{"c":[1,{"d":2}]}}');
    const b = Buffer.from('{"e":1}');
    expect(s.push(a.subarray(0, 9))).toEqual([]);
    expect(s.push(Buffer.concat([a.subarray(9), b, Buffer.from('{"f"')])).map(String)).toEqual([
      String(a),
      String(b),
    ]);
    expect(s.push(Buffer.from(":2}")).map(String)).toEqual(['{"f":2}']);
    expect(() => new JsonObjectSplitter(8).push(Buffer.from("{".padEnd(20)))).toThrow(/too large/);
  });

  it("recognises loopback addresses only", () => {
    for (const h of ["127.0.0.1", "127.8.0.1", "::1", "::ffff:127.0.0.1", "localhost"])
      expect(isLoopbackAddress(h)).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.2", "10.0.0.1", "::", "example.com"])
      expect(isLoopbackAddress(h)).toBe(false);
  });
});

describe("whitelist", () => {
  it("only builds the fixed template for this repository's scripts", () => {
    const out = path.join(tmp, "dir with space", "diag.json");
    const code = buildWhitelistedCommand({ kind: "diagnose", outPath: out }, whitelist());
    expect(code).toContain(
      JSON.stringify([path.join(fs.realpathSync(scriptsDir), "ue_diagnose.py"), out, "--no-exit"]),
    );
    expect(code.split("\n")[0]).toBe("import runpy, sys");
    const evil = path.join(tmp, '"]); import os; os.system("calc") #.json');
    const evilCode = buildWhitelistedCommand({ kind: "diagnose", outPath: evil }, whitelist());
    expect(evilCode).toContain(JSON.stringify(evil)); // a string literal, escaped
    expect(evilCode).not.toContain('os.system("calc")');
  });

  it("refuses anything else", () => {
    const bad: unknown[] = [
      { kind: "shell", outPath: path.join(tmp, "x.json") },
      { kind: "diagnose", outPath: "relative.json" },
      { kind: "diagnose", outPath: path.join(tmp, "x.py") },
      { kind: "diagnose", outPath: path.join(os.homedir(), "outside-allowed.json") },
      { kind: "diagnose", outPath: path.join(tmp, "x\n.json") },
      { kind: "scene", jobPath: sceneJob(false) },
      { kind: "scene", jobPath: path.join(tmp, "missing.json") },
    ];
    for (const cmd of bad)
      expect(
        () => buildWhitelistedCommand(cmd as Parameters<typeof buildWhitelistedCommand>[0], whitelist()),
        JSON.stringify(cmd),
      ).toThrow();
    expect(buildWhitelistedCommand({ kind: "scene", jobPath: sceneJob(true) }, whitelist())).toContain(
      "ue_scene.py",
    );
  });

  it("refuses non-loopback configurations", () => {
    expect(() => new UeRemoteExecClient({ commandHost: "0.0.0.0", whitelist: whitelist() })).toThrow(
      /loopback-only/,
    );
    expect(
      () => new UeRemoteExecClient({ multicastInterface: "192.168.1.5", whitelist: whitelist() }),
    ).toThrow(/loopback-only/);
    expect(() => new UeRemoteExecClient({ ttl: 1, whitelist: whitelist() })).toThrow(/TTL/);
    expect(
      () =>
        new UeRemoteExecClient({ discovery: "unicast", groupAddress: "10.0.0.5", whitelist: whitelist() }),
    ).toThrow(/loopback/);
  });
});

describe("UeRemoteExecClient against a MOCK editor node", () => {
  it("MOCK: discovers the node and runs a whitelisted script (unicast)", async () => {
    const mock = new MockUeRemoteNode({ projectRoot: path.join(tmp, "Render3D") + path.sep });
    const port = await mock.start();
    const client = new UeRemoteExecClient({
      discovery: "unicast",
      groupAddress: "127.0.0.1",
      groupPort: port,
      commandPort: 0,
      expectProjectDir: path.join(tmp, "Render3D"),
      whitelist: whitelist(),
    });
    try {
      const nodes = await client.discover(600);
      expect(nodes.map((x) => x.nodeId)).toEqual([mock.nodeId]);
      expect(nodes[0]).toMatchObject({
        engineVersion: "MOCK-5.8.0",
        projectName: "Render3D",
        address: "127.0.0.1",
      });
      const res = await client.run(
        mock.nodeId,
        { kind: "diagnose", outPath: path.join(tmp, "diag.json") },
        5000,
      );
      expect(res.success).toBe(true);
      expect(res.output[0]?.output).toMatch(/^MOCK/);
      expect(mock.commands).toHaveLength(1);
      expect(mock.commands[0]?.data).toMatchObject({ exec_mode: "ExecuteFile", unattended: true });
      expect(String(mock.commands[0]?.data?.command)).toContain("ue_diagnose.py");
      await new Promise((r) => setTimeout(r, 50));
      expect(mock.seen.map((m) => m.type)).toEqual(
        expect.arrayContaining(["ping", "open_connection", "close_connection"]),
      );
      await expect(
        client.run("unknown-node", { kind: "diagnose", outPath: path.join(tmp, "d.json") }),
      ).rejects.toThrow(/discover/);
    } finally {
      await client.close();
      await mock.stop();
    }
  });

  it("MOCK: ignores pongs addressed to others and refuses an editor of another project", async () => {
    const other = new MockUeRemoteNode({ wrongDest: true });
    const port = await other.start();
    const c1 = new UeRemoteExecClient({
      discovery: "unicast",
      groupAddress: "127.0.0.1",
      groupPort: port,
      whitelist: whitelist(),
    });
    try {
      expect(await c1.discover(400)).toEqual([]);
    } finally {
      await c1.close();
      await other.stop();
    }
    const game = new MockUeRemoteNode({ projectRoot: "/projects/MyGame/" });
    const p2 = await game.start();
    const c2 = new UeRemoteExecClient({
      discovery: "unicast",
      groupAddress: "127.0.0.1",
      groupPort: p2,
      commandPort: 0,
      expectProjectDir: path.join(tmp, "Render3D"),
      whitelist: whitelist(),
    });
    try {
      const [node] = await c2.discover(400);
      await expect(
        c2.run(node!.nodeId, { kind: "diagnose", outPath: path.join(tmp, "d.json") }),
      ).rejects.toThrow(/not the render project/);
      expect(game.commands).toHaveLength(0);
    } finally {
      await c2.close();
      await game.stop();
    }
  });

  it("MOCK: works over loopback multicast like the real protocol (skipped where multicast is unavailable)", async () => {
    const groupPort = 40_000 + Math.floor(Math.random() * 20_000);
    if (!(await multicastWorks(groupPort))) return;
    const mock = new MockUeRemoteNode({ mode: "multicast", groupPort });
    await mock.start();
    const client = new UeRemoteExecClient({ groupPort, commandPort: 0, whitelist: whitelist() });
    try {
      const nodes = await client.discover(1200);
      expect(nodes.map((x) => x.nodeId)).toContain(mock.nodeId);
      const res = await client.run(mock.nodeId, { kind: "scene", jobPath: sceneJob(true) }, 5000);
      expect(res.success).toBe(true);
      expect(String(mock.commands[0]?.data?.command)).toContain("ue_scene.py");
    } finally {
      await client.close();
      await mock.stop();
    }
  });
});
