import readline from "node:readline";
import { getEnv } from "@cre/config";
import { createRender3D, type Render3DSetup } from "../setup.ts";
import { handleMessage, type JsonRpcRequest } from "./protocol.ts";

/*
 * stdio entry of the render3d MCP server (launched by tools/mcp/launch.mjs from .mcp.json). Newline-delimited
 * JSON-RPC on stdin/stdout; logs go to stderr only. The engines and library are created lazily on the first
 * tool call, so `initialize` / `tools/list` answer instantly even on a host without Blender.
 */

let setup: Render3DSetup | null = null;
const lazySetup = (): Render3DSetup => (setup ??= createRender3D(getEnv()));

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  queue = queue.then(async () => {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(text) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
      );
      return;
    }
    try {
      const reply = await handleMessage(msg, lazySetup);
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    } catch (e) {
      process.stderr.write(`render3d mcp: ${(e as Error).message}\n`);
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: "internal error" } })}\n`,
      );
    }
  });
});
rl.on("close", () => {
  void queue.then(() => process.exit(0));
});
