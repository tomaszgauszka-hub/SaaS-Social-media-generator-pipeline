import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { UeSceneJob } from "./job.ts";

/*
 * Client of the Unreal Editor's Python remote execution (PythonScriptPlugin), for interactive control / status of
 * an editor that is already open (and for the thin MCP server). Protocol v1 as implemented by UE's own
 * Engine/Plugins/Experimental/PythonScriptPlugin/Content/Python/remote_execution.py — see tools/unreal/remote_exec.py
 * for the notes. NOT verified against a running UE 5.8 editor here; the protocol must be checked on the user's
 * install (ue_diagnose.py reports the editor's remote-execution settings).
 *
 *   UDP  239.0.0.1:6766 (multicast group, TTL 0)   ping → pong · open_connection · close_connection
 *   TCP  the CLIENT listens (127.0.0.1:6776); the editor connects   command → command_result
 *   message: {"version":1,"magic":"ue_py","type":…,"source":<node id>,"dest":<node id>?,"data":{…}?}
 *
 * Security: loopback only unless explicitly allowed (multicast interface, command host and every peer must be
 * loopback, TTL 0), and the client cannot send caller strings — only a fixed template that runs this repository's
 * ue_diagnose.py or ue_scene.py with one validated absolute .json path (embedded as a JSON string literal).
 */

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_MAGIC = "ue_py";
export const MESSAGE_TYPES = [
  "ping",
  "pong",
  "open_connection",
  "close_connection",
  "command",
  "command_result",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const EXEC_MODES = ["ExecuteFile", "ExecuteStatement", "EvaluateStatement"] as const;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** this tool's Python modules, dropped from the editor's module cache before each run (edited scripts reload) */
export const UE_MODULES = [
  "ue_scene",
  "ue_diagnose",
  "ue_job",
  "ue_math",
  "ue_materials",
  "ue_sets",
  "ue_mrq",
  "ue_util",
  "ue_compat",
];

export const RemoteMessage = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    magic: z.literal(PROTOCOL_MAGIC),
    type: z.enum(MESSAGE_TYPES),
    source: z.string().min(1).max(200),
    dest: z.string().max(200).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
export type RemoteMessage = z.infer<typeof RemoteMessage>;

export function encodeMessage(
  type: MessageType,
  source: string,
  dest?: string,
  data?: Record<string, unknown>,
): Buffer {
  const msg: Record<string, unknown> = { version: PROTOCOL_VERSION, magic: PROTOCOL_MAGIC, type, source };
  if (dest) msg.dest = dest;
  if (data) msg.data = data;
  return Buffer.from(JSON.stringify(msg), "utf8");
}

export function decodeMessage(raw: Buffer | string): RemoteMessage | null {
  let j: unknown;
  try {
    j = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return null;
  }
  const r = RemoteMessage.safeParse(j);
  return r.success ? r.data : null;
}

/** Splits a TCP byte stream into top-level JSON objects (the protocol has no length prefix). */
export class JsonObjectSplitter {
  private buf = Buffer.alloc(0);
  constructor(private readonly limit = MAX_MESSAGE_BYTES) {}

  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.limit) throw new Error("remote message too large");
    const out: Buffer[] = [];
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = -1;
    let consumed = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === 0x5c) esc = true;
        else if (c === 0x22) inStr = false;
      } else if (c === 0x22) inStr = true;
      else if (c === 0x7b) {
        if (depth === 0) start = i;
        depth++;
      } else if (c === 0x7d && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(this.buf.subarray(start, i + 1));
          consumed = i + 1;
          start = -1;
        }
      }
    }
    this.buf = Buffer.from(this.buf.subarray(consumed));
    return out;
  }
}

export function isLoopbackAddress(host: string): boolean {
  if (host === "localhost") return true;
  const h = host.startsWith("::ffff:") ? host.slice(7) : host;
  if (net.isIPv4(h)) return h.split(".")[0] === "127";
  return h === "::1";
}

// ------------------------------------------------------------------------------------------- whitelist ----

export type WhitelistedCommand = { kind: "diagnose"; outPath: string } | { kind: "scene"; jobPath: string };

export interface WhitelistOptions {
  /** tools/unreal of this repository */
  scriptsDir: string;
  /** directories the .json argument must be inside (e.g. the render work root) */
  allowedRoots: string[];
}

const SCRIPT: Record<WhitelistedCommand["kind"], string> = {
  diagnose: "ue_diagnose.py",
  scene: "ue_scene.py",
};

function checkJsonPath(p: string, roots: string[], mustExist: boolean): string {
  if (
    typeof p !== "string" ||
    !path.isAbsolute(p) ||
    !/\.json$/i.test(p) ||
    [...p].some((c) => c.charCodeAt(0) < 32) ||
    p.length > 1024
  )
    throw new Error("the argument must be an absolute .json path");
  const abs = path.resolve(p);
  const inRoot = roots.some((r) => {
    const root = path.resolve(r);
    return abs.startsWith(root + path.sep);
  });
  if (!inRoot) throw new Error(`${abs} is outside the allowed directories`);
  if (mustExist && !fs.statSync(abs).isFile()) throw new Error(`${abs} is not a file`);
  return abs;
}

/**
 * The only Python this client ever sends: run one of this repository's scripts with one validated path. A scene job
 * must validate as a UE scene job with "interactive": true (the script then never closes the user's editor).
 */
export function buildWhitelistedCommand(cmd: WhitelistedCommand, opts: WhitelistOptions): string {
  const kind = cmd.kind;
  if (!(kind in SCRIPT)) throw new Error(`not a whitelisted script: ${String(kind)}`);
  const script = path.join(fs.realpathSync(opts.scriptsDir), SCRIPT[kind]);
  if (!fs.existsSync(script)) throw new Error(`${script} not found`);
  let arg: string;
  if (cmd.kind === "scene") {
    arg = checkJsonPath(cmd.jobPath, opts.allowedRoots, true);
    const job = UeSceneJob.parse(JSON.parse(fs.readFileSync(arg, "utf8")));
    if (!job.interactive)
      throw new Error('a scene job sent to a running editor must have "interactive": true');
  } else {
    arg = checkJsonPath(cmd.outPath, opts.allowedRoots, false);
  }
  const argv = JSON.stringify([script, arg, "--no-exit"]);
  return (
    "import runpy, sys\n" +
    `for _m in ${JSON.stringify(UE_MODULES)}:\n` +
    "    sys.modules.pop(_m, None)\n" +
    `sys.argv = ${argv}\n` +
    `runpy.run_path(${JSON.stringify(script)}, run_name='__main__')\n`
  );
}

// ---------------------------------------------------------------------------------------------- client ----

export interface RemoteExecOptions {
  groupAddress?: string;
  groupPort?: number;
  /** interface for multicast send / membership (default 127.0.0.1) */
  multicastInterface?: string;
  /** TCP host / port the client listens on for the editor's command connection (port 0 = any free port) */
  commandHost?: string;
  commandPort?: number;
  ttl?: number;
  /** "multicast" (the protocol) or "unicast" to a fixed endpoint (tests, a mock editor) */
  discovery?: "multicast" | "unicast";
  allowNonLoopback?: boolean;
  /** only talk to an editor whose project_root is this directory (the dedicated render project) */
  expectProjectDir?: string;
  whitelist: WhitelistOptions;
}

export interface RemoteNode {
  nodeId: string;
  address: string;
  user?: string;
  machine?: string;
  engineVersion?: string;
  engineRoot?: string;
  projectRoot?: string;
  projectName?: string;
}

export const CommandResult = z
  .object({
    success: z.boolean(),
    command: z.string().optional(),
    result: z.string().nullable().optional(),
    output: z.array(z.object({ type: z.string(), output: z.string() }).loose()).default([]),
  })
  .loose();
export type CommandResult = z.infer<typeof CommandResult>;

const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 1024) : undefined);

export class UeRemoteExecClient {
  readonly nodeId = randomUUID();
  private sock: dgram.Socket | null = null;
  private readonly o: Required<Omit<RemoteExecOptions, "expectProjectDir">> & { expectProjectDir?: string };
  private readonly listeners = new Set<(m: RemoteMessage, address: string) => void>();
  private readonly nodes = new Map<string, RemoteNode>();

  constructor(opts: RemoteExecOptions) {
    this.o = {
      groupAddress: opts.groupAddress ?? "239.0.0.1",
      groupPort: opts.groupPort ?? 6766,
      multicastInterface: opts.multicastInterface ?? "127.0.0.1",
      commandHost: opts.commandHost ?? "127.0.0.1",
      commandPort: opts.commandPort ?? 6776,
      ttl: opts.ttl ?? 0,
      discovery: opts.discovery ?? "multicast",
      allowNonLoopback: opts.allowNonLoopback ?? false,
      whitelist: opts.whitelist,
      ...(opts.expectProjectDir ? { expectProjectDir: opts.expectProjectDir } : {}),
    };
    if (!this.o.allowNonLoopback) {
      if (!isLoopbackAddress(this.o.commandHost) || !isLoopbackAddress(this.o.multicastInterface))
        throw new Error("Python remote execution is loopback-only (set allowNonLoopback to override)");
      if (this.o.ttl !== 0) throw new Error("multicast TTL must be 0 (local host only)");
      if (this.o.discovery === "unicast" && !isLoopbackAddress(this.o.groupAddress))
        throw new Error("unicast discovery must target a loopback address");
    }
  }

  async open(): Promise<void> {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (raw, rinfo) => {
      if (!this.o.allowNonLoopback && !isLoopbackAddress(rinfo.address)) return;
      const m = decodeMessage(raw);
      if (!m || m.source === this.nodeId) return;
      for (const l of this.listeners) l(m, rinfo.address);
    });
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      if (this.o.discovery === "unicast") sock.bind(0, this.o.multicastInterface, () => resolve());
      else sock.bind(this.o.groupPort, "0.0.0.0", () => resolve());
    });
    if (this.o.discovery === "multicast") {
      sock.setMulticastTTL(this.o.ttl);
      sock.setMulticastLoopback(true);
      sock.setMulticastInterface(this.o.multicastInterface);
      sock.addMembership(this.o.groupAddress, this.o.multicastInterface);
    }
    this.sock = sock;
  }

  async close(): Promise<void> {
    const s = this.sock;
    this.sock = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private send(raw: Buffer): Promise<void> {
    const s = this.sock;
    if (!s) return Promise.reject(new Error("client not open"));
    return new Promise((resolve, reject) =>
      s.send(raw, this.o.groupPort, this.o.groupAddress, (e) => (e ? reject(e) : resolve())),
    );
  }

  /** Editors answering a ping within the time (pings every second, like UE's client). */
  async discover(timeoutMs = 2500): Promise<RemoteNode[]> {
    await this.open();
    const found = new Map<string, RemoteNode>();
    const onMsg = (m: RemoteMessage, address: string) => {
      if (m.type !== "pong" || m.dest !== this.nodeId) return;
      const d = m.data ?? {};
      const node: RemoteNode = { nodeId: m.source, address };
      const fields: [keyof RemoteNode, string][] = [
        ["user", "user"],
        ["machine", "machine"],
        ["engineVersion", "engine_version"],
        ["engineRoot", "engine_root"],
        ["projectRoot", "project_root"],
        ["projectName", "project_name"],
      ];
      for (const [k, src] of fields) {
        const v = str(d[src]);
        if (v !== undefined) (node as unknown as Record<string, string>)[k] = v;
      }
      found.set(m.source, node);
    };
    this.listeners.add(onMsg);
    try {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        await this.send(encodeMessage("ping", this.nodeId));
        await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, end - Date.now()))));
      }
    } finally {
      this.listeners.delete(onMsg);
    }
    for (const n of found.values()) this.nodes.set(n.nodeId, n);
    return [...found.values()];
  }

  /** Run a whitelisted script in an editor found by discover(). */
  async run(nodeId: string, cmd: WhitelistedCommand, timeoutMs = 60_000): Promise<CommandResult> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`unknown editor ${nodeId}: discover() first`);
    if (this.o.expectProjectDir) {
      const want = path
        .resolve(this.o.expectProjectDir)
        .replace(/[\\/]+$/, "")
        .toLowerCase();
      const got = path
        .resolve(node.projectRoot ?? "")
        .replace(/[\\/]+$/, "")
        .toLowerCase();
      if (want !== got)
        throw new Error(`editor ${nodeId} has project ${node.projectRoot ?? "?"}, not the render project`);
    }
    const command = buildWhitelistedCommand(cmd, this.o.whitelist);
    return this.exchange(nodeId, command, timeoutMs);
  }

  private async exchange(nodeId: string, command: string, timeoutMs: number): Promise<CommandResult> {
    await this.open();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.commandPort, this.o.commandHost, () => resolve());
    });
    const addr = server.address() as net.AddressInfo;
    try {
      const conn = await new Promise<net.Socket>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error("the editor did not connect back (remote execution enabled?)")),
          5000,
        );
        server.on("connection", (c) => {
          if (!this.o.allowNonLoopback && !isLoopbackAddress(c.remoteAddress ?? "")) {
            c.destroy();
            return;
          }
          clearTimeout(t);
          resolve(c);
        });
        this.send(
          encodeMessage("open_connection", this.nodeId, nodeId, {
            command_ip: addr.address,
            command_port: addr.port,
          }),
        ).catch((e: unknown) => {
          clearTimeout(t);
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      });
      try {
        return await new Promise<CommandResult>((resolve, reject) => {
          const splitter = new JsonObjectSplitter();
          const t = setTimeout(
            () => reject(new Error(`no command_result within ${timeoutMs} ms`)),
            timeoutMs,
          );
          conn.on("data", (chunk: Buffer) => {
            try {
              for (const raw of splitter.push(chunk)) {
                const m = decodeMessage(raw);
                if (m?.type === "command_result" && m.dest === this.nodeId) {
                  clearTimeout(t);
                  resolve(CommandResult.parse(m.data ?? {}));
                }
              }
            } catch (e) {
              clearTimeout(t);
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
          conn.on("error", (e) => {
            clearTimeout(t);
            reject(e);
          });
          conn.on("close", () => {
            clearTimeout(t);
            reject(new Error("the editor closed the command connection"));
          });
          conn.write(
            encodeMessage("command", this.nodeId, nodeId, {
              command,
              unattended: true,
              exec_mode: "ExecuteFile",
            }),
          );
        });
      } finally {
        conn.destroy();
      }
    } finally {
      await this.send(encodeMessage("close_connection", this.nodeId, nodeId)).catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
