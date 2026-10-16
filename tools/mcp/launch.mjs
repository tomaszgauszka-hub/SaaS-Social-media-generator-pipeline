#!/usr/bin/env node
/**
 * Launcher for the local MCP servers in .mcp.json (cross-platform: the same file works on Windows and Linux).
 *
 *   node tools/mcp/launch.mjs blender     → pinned mcp-for-blender from .tools/mcp-venv (stdio)
 *   node tools/mcp/launch.mjs render3d    → this repo's thin 3D orchestration server (stdio)
 *
 * The child gets a minimal environment: no API keys or tokens of the developer's shell ever reach an MCP server,
 * telemetry and self-update are off, the Blender socket is loopback-only and model-written Blender code goes
 * through the upstream AST safe mode (BLENDER_MCP_SAFE_MODE=1).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WIN = process.platform === "win32";
const PASS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
];

export function baseEnv(src = process.env) {
  const env = {};
  for (const k of PASS) if (src[k]) env[k] = src[k];
  return env;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function blenderEnv(src = process.env) {
  const host = src.BLENDER_HOST || "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new Error(`BLENDER_HOST=${host}: the Blender MCP socket is loopback-only`);
  const port = Number(src.BLENDER_PORT || 9876);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid BLENDER_PORT ${port}`);
  return {
    ...baseEnv(src),
    BLENDER_HOST: host,
    BLENDER_PORT: String(port),
    DISABLE_TELEMETRY: "1",
    BLENDER_MCP_DISABLE_TELEMETRY: "1",
    MCP_DISABLE_TELEMETRY: "1",
    BLENDER_MCP_SAFE_MODE: src.BLENDER_MCP_SAFE_MODE === "0" ? "0" : "1",
    BLENDERMCP_NO_UPDATE_CHECK: "1",
    PYTHONNOUSERSITE: "1",
  };
}

export function venvBin(name, root = ROOT) {
  const dir = path.join(root, ".tools", "mcp-venv", WIN ? "Scripts" : "bin");
  return path.join(dir, WIN ? `${name}.exe` : name);
}

function fail(msg) {
  process.stderr.write(`[mcp launcher] ${msg}\n`);
  process.exit(1);
}

function run(command, args, env) {
  const child = spawn(command, args, { cwd: ROOT, env, stdio: "inherit", windowsHide: true });
  const forward = (sig) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on("error", (e) => fail(`${command}: ${e.message}`));
}

function main() {
  const which = process.argv[2];
  if (which === "blender") {
    const exe = venvBin("mcp-for-blender");
    if (!fs.existsSync(exe))
      fail(`${exe} not found — run scripts/setup-3d.ps1 (Windows) or scripts/setup-3d.sh first`);
    run(exe, process.argv.slice(3), blenderEnv());
  } else if (which === "render3d") {
    const tsx = path.join(ROOT, "node_modules", ".bin", WIN ? "tsx.cmd" : "tsx");
    if (!fs.existsSync(tsx)) fail("node_modules missing — run pnpm install");
    const env = { ...baseEnv(), RENDER3D_MCP: "1" };
    for (const k of ["BLENDER_PYTHON", "BLENDER_BIN", "UE_EDITOR_CMD", "UE_PROJECT", "RENDER3D_DATA_DIR"])
      if (process.env[k]) env[k] = process.env[k];
    run(tsx, [path.join(ROOT, "packages", "render3d", "src", "mcp", "server.ts")], env);
  } else fail(`usage: node tools/mcp/launch.mjs <blender|render3d>`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
