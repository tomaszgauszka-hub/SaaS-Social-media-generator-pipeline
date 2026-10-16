"""Headless host for the "MCP for Blender" addon (pinned release, hash-verified).

The upstream addon (mcp-for-blender, MIT) only starts its socket server in an interactive Blender: in background
mode (`blender -b`, or the `bpy` Python module) Blender never runs the timer that executes queued commands, so the
addon refuses to start. Render stations and CI have no display, so this host runs the *unchanged* addon command
handlers on the main thread itself:

    python  tools/mcp/blender_headless_host.py [--port 9876] [--blend scene.blend]      (bpy module)
    blender -b --factory-startup --python tools/mcp/blender_headless_host.py -- [--port 9876]

Hardening (this file is the only place that decides it):
  * the addon file must match the pinned SHA-256 of the reviewed release — a modified or updated addon is refused
    (re-review it and update ADDON_SHA256 together with tools/mcp/requirements-blender-mcp.txt);
  * the socket binds to a loopback address only, never 0.0.0.0;
  * every third-party asset / generation integration (Poly Haven, Sketchfab, Poly Pizza, Hyper3D Rodin, Hunyuan3D,
    Tripo) is forced off: no downloads of unlicensed assets, no paid generation calls from this host;
  * telemetry consent is forced off and the addon's self-update check is disabled.

The interactive GUI path (Windows/macOS/Linux desktop) uses the same pinned addon installed into Blender — see
docs/BLENDER_MCP_SETUP.md. Production renders never go through MCP: the worker runs saved recipes
(tools/blender/scenes) as plain processes.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import signal
import socket
import sys
import threading
import time
from pathlib import Path

ADDON_PACKAGE = "mcp-for-blender"
ADDON_VERSION = "2.1.9"
ADDON_SHA256 = "eb0facf69781a30e69792532087d8d41c6a14fcd323353250abe7988ee297fa5"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
INTEGRATIONS_OFF = (
    "blendermcp_use_polyhaven",
    "blendermcp_use_hyper3d",
    "blendermcp_use_sketchfab",
    "blendermcp_use_polypizza",
    "blendermcp_use_hunyuan3d",
    "blendermcp_use_tripo",
)


def script_args(argv: list[str]) -> list[str]:
    """Arguments after `--` when run by a Blender executable, else everything after the script name."""
    return argv[argv.index("--") + 1 :] if "--" in argv else argv[1:]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def find_addon(explicit: str | None) -> Path:
    """The addon bundled with the pinned package: --addon, $BLENDER_MCP_ADDON, or the repo's MCP venv."""
    if explicit:
        return Path(explicit)
    env = os.environ.get("BLENDER_MCP_ADDON")
    if env:
        return Path(env)
    root = Path(__file__).resolve().parents[2]
    venv = root / ".tools" / "mcp-venv"
    for site in sorted(venv.glob("lib/python3*/site-packages")) + [venv / "Lib" / "site-packages"]:
        cand = site / "blender_mcp" / "bundled" / "addon.py"
        if cand.is_file():
            return cand
    raise SystemExit(
        f"{ADDON_PACKAGE} {ADDON_VERSION} is not installed in .tools/mcp-venv — run scripts/setup-3d.sh "
        "(or scripts/setup-3d.ps1 on Windows), or pass --addon <path to addon.py>"
    )


def load_addon(path: Path, expected_sha: str = ADDON_SHA256):
    actual = sha256(path)
    if actual != expected_sha:
        raise SystemExit(
            f"refusing to load {path}: sha256 {actual} is not the reviewed {ADDON_PACKAGE} {ADDON_VERSION} "
            f"addon ({expected_sha})"
        )
    spec = importlib.util.spec_from_file_location("blender_mcp_addon", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def harden_scene(bpy) -> None:
    """Third-party asset sources and paid generators off (the addon re-reads these on every command)."""
    for scene in bpy.data.scenes:
        for prop in INTEGRATIONS_OFF:
            if hasattr(scene, prop):
                setattr(scene, prop, False)


class HeadlessHost:
    """Runs the addon's BlenderMCPServer without Blender's event loop: socket thread + main-thread drain."""

    def __init__(self, addon, host: str, port: int):
        if host not in LOOPBACK:
            raise SystemExit(f"refusing to bind {host}: the Blender MCP socket is loopback-only")
        self.addon = addon
        self.server = addon.BlenderMCPServer(host=host, port=port)
        self.stop_event = threading.Event()

    def start(self) -> None:
        s = self.server
        s.running = True
        s.socket = socket.socket(socket.AF_INET6 if ":" in s.host else socket.AF_INET, socket.SOCK_STREAM)
        s.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.socket.bind((s.host, s.port))
        s.socket.listen(5)
        s.server_thread = threading.Thread(target=s._server_loop, daemon=True)
        s.server_thread.start()

    def serve(self, bpy, idle_exit_s: float = 0.0) -> None:
        last_activity = time.monotonic()
        while not self.stop_event.is_set():
            harden_scene(bpy)  # a command may open another .blend
            busy = not self.server.command_queue.empty()
            self.server._drain_command_queue()
            now = time.monotonic()
            if busy:
                last_activity = now
            elif idle_exit_s > 0 and now - last_activity > idle_exit_s:
                print(f"BLENDER_MCP_HOST idle for {idle_exit_s:.0f}s — exiting", flush=True)
                break
            time.sleep(0.02)

    def stop(self) -> None:
        self.stop_event.set()
        try:
            self.server.stop()
        except Exception:  # noqa: BLE001 — best effort on shutdown
            pass


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default=os.environ.get("BLENDER_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("BLENDER_PORT", "9876")))
    ap.add_argument("--addon", default=None, help="addon.py of the pinned release (default: .tools/mcp-venv)")
    ap.add_argument("--blend", default=None, help="open this .blend before serving")
    ap.add_argument("--ready-file", default=None, help="write {host, port, blender} here once listening")
    ap.add_argument("--idle-exit", type=float, default=0.0, help="exit after N idle seconds (0 = never)")
    args = ap.parse_args(script_args(argv))

    os.environ["BLENDERMCP_NO_UPDATE_CHECK"] = "1"
    import bpy  # noqa: PLC0415 — only importable inside Blender / with the bpy module

    addon = load_addon(find_addon(args.addon))
    addon.register()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=str(Path(args.blend).resolve()))
    harden_scene(bpy)
    for scene in bpy.data.scenes:
        if hasattr(scene, "blendermcp_port"):
            scene.blendermcp_port = args.port

    host = HeadlessHost(addon, args.host, args.port)
    host.start()
    signal.signal(signal.SIGTERM, lambda *_: host.stop_event.set())
    signal.signal(signal.SIGINT, lambda *_: host.stop_event.set())
    info = {
        "host": args.host,
        "port": args.port,
        "blender": bpy.app.version_string,
        "addon": f"{ADDON_PACKAGE} {ADDON_VERSION}",
        "protocol": getattr(addon, "ADDON_PROTOCOL_VERSION", None),
        "pid": os.getpid(),
    }
    if args.ready_file:
        Path(args.ready_file).write_text(json.dumps(info), encoding="utf-8")
    print("BLENDER_MCP_HOST ready " + json.dumps(info), flush=True)
    try:
        host.serve(bpy, args.idle_exit)
    finally:
        host.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
