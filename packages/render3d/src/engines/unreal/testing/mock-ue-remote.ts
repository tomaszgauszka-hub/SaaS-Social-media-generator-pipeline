import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { decodeMessage, encodeMessage, JsonObjectSplitter, type RemoteMessage } from "../remote-exec.ts";

/*
 * MOCK Unreal Editor remote-execution node for tests — not Unreal. It speaks the same wire protocol as
 * remote-exec.ts (UE's PythonScriptPlugin remote execution, v1): answers ping with pong (unicast to the sender, or
 * to the multicast group), connects back on open_connection, records each command and answers with a
 * command_result (sent in fragments, to exercise stream reassembly). It never executes anything it receives.
 */

export interface MockUeRemoteOptions {
  mode?: "unicast" | "multicast";
  groupAddress?: string;
  groupPort?: number;
  projectRoot?: string;
  /** answer pongs to another node id (tests that the client ignores them) */
  wrongDest?: boolean;
  /** never connect back on open_connection */
  noConnect?: boolean;
}

export class MockUeRemoteNode {
  readonly nodeId = `mock-ue-${randomUUID()}`;
  readonly commands: RemoteMessage[] = [];
  readonly seen: RemoteMessage[] = [];
  private sock: dgram.Socket | null = null;
  port = 0;

  constructor(private readonly o: MockUeRemoteOptions = {}) {}

  async start(): Promise<number> {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (raw, rinfo) => this.onDatagram(raw, rinfo));
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      if (this.o.mode === "multicast") sock.bind(this.o.groupPort ?? 6766, "0.0.0.0", () => resolve());
      else sock.bind(0, "127.0.0.1", () => resolve());
    });
    if (this.o.mode === "multicast") {
      sock.setMulticastTTL(0);
      sock.setMulticastLoopback(true);
      sock.setMulticastInterface("127.0.0.1");
      sock.addMembership(this.o.groupAddress ?? "239.0.0.1", "127.0.0.1");
    }
    this.sock = sock;
    this.port = sock.address().port;
    return this.port;
  }

  async stop(): Promise<void> {
    const s = this.sock;
    this.sock = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private reply(raw: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!this.sock) return;
    if (this.o.mode === "multicast")
      this.sock.send(raw, this.o.groupPort ?? 6766, this.o.groupAddress ?? "239.0.0.1");
    else this.sock.send(raw, rinfo.port, rinfo.address);
  }

  private onDatagram(raw: Buffer, rinfo: dgram.RemoteInfo): void {
    const m = decodeMessage(raw);
    if (!m || m.source === this.nodeId) return;
    this.seen.push(m);
    if (m.type === "ping") {
      this.reply(
        encodeMessage("pong", this.nodeId, this.o.wrongDest ? "someone-else" : m.source, {
          user: "mock",
          machine: "mock-host",
          engine_version: "MOCK-5.8.0",
          engine_root: "/mock/UE_5.8/",
          project_root: this.o.projectRoot ?? "/mock/Render3D/",
          project_name: "Render3D",
        }),
        rinfo,
      );
    } else if (m.type === "open_connection" && m.dest === this.nodeId && !this.o.noConnect) {
      const d = m.data ?? {};
      const host = typeof d.command_ip === "string" ? d.command_ip : "127.0.0.1";
      const port = typeof d.command_port === "number" ? d.command_port : 0;
      const client = m.source;
      const c = net.connect(port, host);
      const splitter = new JsonObjectSplitter();
      c.on("error", () => undefined);
      c.on("data", (chunk: Buffer) => {
        for (const part of splitter.push(chunk)) {
          const cmd = decodeMessage(part);
          if (!cmd || cmd.type !== "command" || cmd.dest !== this.nodeId) continue;
          this.commands.push(cmd);
          const res = encodeMessage("command_result", this.nodeId, client, {
            success: true,
            command: cmd.data?.command,
            result: "None",
            output: [{ type: "Info", output: "MOCK: command recorded, nothing executed" }],
          });
          c.write(res.subarray(0, 7));
          setTimeout(() => c.write(res.subarray(7)), 5);
        }
      });
    }
  }
}
