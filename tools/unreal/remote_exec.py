"""Client for the Unreal Editor's Python remote execution (PythonScriptPlugin) — loopback only, whitelisted scripts.

    python3 tools/unreal/remote_exec.py discover
    python3 tools/unreal/remote_exec.py diagnose <abs out.json>
    python3 tools/unreal/remote_exec.py scene    <abs job.json>       (the job must say "interactive": true)

PROTOCOL NOTES — written from UE's own client (Engine/Plugins/Experimental/PythonScriptPlugin/Content/Python/
remote_execution.py, protocol version 1) and NOT verified against a running UE 5.8 editor in this repository.
Check that file in your 5.8 install (same constants?) before relying on this; ue_diagnose.py reports the
editor-side settings.

  Discovery (UDP multicast, group 239.0.0.1:6766 by default = Project Settings > Plugins > Python > Multicast
  Group Endpoint; TTL 0 keeps datagrams on this host; the editor binds the Multicast Bind Address, 127.0.0.1 by
  default in recent versions). Every message is one UTF-8 JSON object:
      {"version": 1, "magic": "ue_py", "type": <type>, "source": <sender node id>, "dest": <node id>?, "data": {...}?}
  * ping            client → group, no dest; every editor with remote execution enabled answers
  * pong            editor → group, dest = client id, source = the editor's node id,
                    data {user, machine, engine_version, engine_root, project_root, project_name}
  * open_connection client → group, dest = editor id, data {command_ip, command_port}: the CLIENT listens on that
                    TCP endpoint (127.0.0.1:6776 by default) and the editor connects to it
  * close_connection client → group, dest = editor id: the editor drops the TCP connection
  Command channel (TCP, same JSON envelope; no length prefix — one JSON object per message):
  * command         client → editor, data {command, unattended, exec_mode} with exec_mode one of
                    ExecuteFile (a .py file + arguments, or literal multi-statement code), ExecuteStatement,
                    EvaluateStatement
  * command_result  editor → client, data {success, command, result, output: [{type, output}]}
  Messages from yourself (source == own id) and messages addressed to other nodes are ignored.

SECURITY: remote execution runs Python with the editor's rights. This client only binds / connects loopback
addresses (non-loopback peers are dropped), sends with TTL 0, and can only send one fixed command template that
runs this repository's ue_diagnose.py or ue_scene.py with a validated absolute .json path — never a caller string.
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import struct
import sys
import time
import uuid

PROTOCOL_VERSION = 1
PROTOCOL_MAGIC = "ue_py"
TYPES = ("ping", "pong", "open_connection", "close_connection", "command", "command_result")
EXEC_MODES = ("ExecuteFile", "ExecuteStatement", "EvaluateStatement")
DEFAULT_GROUP = ("239.0.0.1", 6766)
DEFAULT_COMMAND = ("127.0.0.1", 6776)
MAX_MESSAGE = 16 * 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = {"diagnose": "ue_diagnose.py", "scene": "ue_scene.py"}
#: this tool's modules, dropped from sys.modules before a run so an edited script is never served from cache
MODULES = ("ue_scene", "ue_diagnose", "ue_job", "ue_math", "ue_materials", "ue_sets", "ue_mrq", "ue_util",
           "ue_compat")


class RemoteExecError(RuntimeError):
    pass


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def encode(type_: str, source: str, dest: str | None = None, data: dict | None = None) -> bytes:
    if type_ not in TYPES:
        raise ValueError(f"unknown message type {type_}")
    msg = {"version": PROTOCOL_VERSION, "magic": PROTOCOL_MAGIC, "type": type_, "source": source}
    if dest:
        msg["dest"] = dest
    if data:
        msg["data"] = data
    return json.dumps(msg, ensure_ascii=False).encode("utf-8")


def decode(raw) -> dict | None:
    """A protocol message, or None for anything else (wrong magic / version / type, not JSON)."""
    try:
        msg = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(msg, dict) or msg.get("version") != PROTOCOL_VERSION or msg.get("magic") != PROTOCOL_MAGIC:
        return None
    if msg.get("type") not in TYPES or not isinstance(msg.get("source"), str):
        return None
    return msg


class JsonStream:
    """Splits a TCP byte stream into top-level JSON objects (strings and escapes respected)."""

    def __init__(self, limit: int = MAX_MESSAGE):
        self.buf = bytearray()
        self.limit = limit

    def push(self, chunk: bytes) -> list[bytes]:
        self.buf += chunk
        if len(self.buf) > self.limit:
            raise RemoteExecError("remote message too large")
        out = []
        depth, in_str, esc, start = 0, False, False, None
        i = 0
        consumed = 0
        while i < len(self.buf):
            c = self.buf[i]
            if in_str:
                if esc:
                    esc = False
                elif c == 0x5C:
                    esc = True
                elif c == 0x22:
                    in_str = False
            elif c == 0x22:
                in_str = True
            elif c == 0x7B:
                if depth == 0:
                    start = i
                depth += 1
            elif c == 0x7D and depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    out.append(bytes(self.buf[start:i + 1]))
                    consumed = i + 1
                    start = None
            i += 1
        del self.buf[:consumed]
        if depth == 0 and not in_str:
            self.buf = bytearray(self.buf.strip())
        return out


def whitelisted_command(kind: str, path: str, tools_dir: str = HERE) -> str:
    """The only code this client sends: run this repository's ue_diagnose.py / ue_scene.py with one absolute .json
    path. The path is embedded as a JSON string literal (valid Python), so it cannot change the code around it."""
    if kind not in SCRIPTS:
        raise RemoteExecError(f"not a whitelisted script: {kind!r}")
    if not isinstance(path, str) or not os.path.isabs(path) or not path.lower().endswith(".json") \
            or any(ord(c) < 32 for c in path) or len(path) > 1024:
        raise RemoteExecError("the argument must be an absolute .json path")
    script = os.path.join(os.path.realpath(tools_dir), SCRIPTS[kind])
    if not os.path.isfile(script):
        raise RemoteExecError(f"{script} not found")
    if kind == "scene":
        with open(path, encoding="utf-8") as fh:
            job = json.load(fh)
        if not isinstance(job, dict) or job.get("interactive") is not True:
            raise RemoteExecError("a scene job sent to a running editor must have \"interactive\": true")
    argv = json.dumps([script, os.path.normpath(path), "--no-exit"], ensure_ascii=False)
    return ("import runpy, sys\n"
            f"for _m in {json.dumps(list(MODULES))}:\n"
            "    sys.modules.pop(_m, None)\n"
            f"sys.argv = {argv}\n"
            f"runpy.run_path({json.dumps(script, ensure_ascii=False)}, run_name='__main__')\n")


class RemoteExecClient:
    def __init__(self, group=DEFAULT_GROUP, interface: str = "127.0.0.1", command=DEFAULT_COMMAND, ttl: int = 0,
                 allow_non_loopback: bool = False, unicast: bool = False):
        if not allow_non_loopback:
            if not is_loopback(interface) or not is_loopback(command[0]):
                raise RemoteExecError("remote execution is loopback-only (pass allow_non_loopback to override)")
            if ttl != 0:
                raise RemoteExecError("multicast TTL must be 0 (local host only)")
        self.group = (group[0], int(group[1]))
        self.interface = interface
        self.command = (command[0], int(command[1]))
        self.ttl = ttl
        self.allow_non_loopback = allow_non_loopback
        self.unicast = unicast
        self.node_id = str(uuid.uuid4())
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self.udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if unicast:  # tests / mock editors: plain datagrams to the group endpoint, replies to our own port
            self.udp.bind((interface, 0))
        else:
            self.udp.bind(("0.0.0.0", self.group[1]))
            self.udp.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
            self.udp.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl)
            self.udp.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interface))
            mreq = struct.pack("4s4s", socket.inet_aton(self.group[0]), socket.inet_aton(interface))
            self.udp.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        self.udp.settimeout(0.1)

    def close(self) -> None:
        self.udp.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()

    def _send(self, raw: bytes) -> None:
        self.udp.sendto(raw, self.group)

    def _recv(self) -> dict | None:
        try:
            raw, addr = self.udp.recvfrom(65535)
        except (socket.timeout, BlockingIOError):
            return None
        if not self.allow_non_loopback and not is_loopback(addr[0]):
            return None
        msg = decode(raw)
        if msg is None or msg["source"] == self.node_id:
            return None
        return msg

    def discover(self, timeout: float = 2.0) -> list[dict]:
        nodes: dict[str, dict] = {}
        end = time.monotonic() + timeout
        next_ping = 0.0
        while time.monotonic() < end:
            if time.monotonic() >= next_ping:
                self._send(encode("ping", self.node_id))
                next_ping = time.monotonic() + 1.0
            msg = self._recv()
            if msg and msg["type"] == "pong" and msg.get("dest") == self.node_id:
                nodes[msg["source"]] = {"nodeId": msg["source"], **(msg.get("data") or {})}
        return list(nodes.values())

    def run(self, node_id: str, command: str, exec_mode: str = "ExecuteFile", timeout: float = 60.0) -> dict:
        if exec_mode not in EXEC_MODES:
            raise RemoteExecError(f"unknown exec mode {exec_mode}")
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(self.command)
        server.listen(1)
        server.settimeout(5.0)
        host, port = server.getsockname()[:2]
        try:
            self._send(encode("open_connection", self.node_id, node_id, {"command_ip": host, "command_port": port}))
            try:
                conn, addr = server.accept()
            except socket.timeout as e:
                raise RemoteExecError("the editor did not connect back (remote execution enabled?)") from e
            if not self.allow_non_loopback and not is_loopback(addr[0]):
                conn.close()
                raise RemoteExecError(f"refused a non-loopback command connection from {addr[0]}")
            with conn:
                conn.settimeout(timeout)
                conn.sendall(encode("command", self.node_id, node_id,
                                    {"command": command, "unattended": True, "exec_mode": exec_mode}))
                stream = JsonStream()
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:
                        raise RemoteExecError("the editor closed the command connection")
                    for raw in stream.push(chunk):
                        msg = decode(raw)
                        if msg and msg["type"] == "command_result" and msg.get("dest") == self.node_id:
                            return msg.get("data") or {}
        finally:
            try:
                self._send(encode("close_connection", self.node_id, node_id))
            finally:
                server.close()


def cli(argv: list[str]) -> int:
    args = argv[1:]
    if not args or args[0] not in ("discover", "diagnose", "scene") or (args[0] != "discover" and len(args) != 2):
        print(__doc__.split("\n\n")[0], file=sys.stderr)
        return 2
    group = (os.environ.get("UE_REMOTE_EXEC_GROUP", DEFAULT_GROUP[0]),
             int(os.environ.get("UE_REMOTE_EXEC_PORT", DEFAULT_GROUP[1])))
    command = ("127.0.0.1", int(os.environ.get("UE_REMOTE_EXEC_COMMAND_PORT", DEFAULT_COMMAND[1])))
    try:
        with RemoteExecClient(group, command=command) as client:
            nodes = client.discover()
            if args[0] == "discover":
                print(json.dumps(nodes, indent=1))
                return 0
            if len(nodes) != 1:
                raise RemoteExecError(f"expected one editor, found {len(nodes)} (close the others)")
            res = client.run(nodes[0]["nodeId"], whitelisted_command(args[0], args[1]))
            print(json.dumps(res, indent=1))
            return 0 if res.get("success") else 1
    except (RemoteExecError, OSError, ValueError) as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(cli(sys.argv))
