"""End-to-end check of the Blender MCP connection, through the real MCP protocol.

    .tools/mcp-venv/bin/python tools/mcp/check_blender_mcp.py [--blender-python .tools/blender-venv/bin/python]
                                                               [--port 9876] [--no-host] [--out .data/mcp-check]

1. starts the headless addon host (tools/mcp/blender_headless_host.py) unless --no-host (a GUI Blender with the
   addon started already listens on the port);
2. starts the MCP server exactly as Claude Code does (`node tools/mcp/launch.mjs blender`, stdio);
3. MCP initialize → tools/list → get_scene_info → execute_blender_code: create an object, assign a material,
   save the .blend and render a frame → get_scene_info again;
4. verifies the files on disk and prints a JSON report (exit 1 on any failure).

Model-written code goes through the upstream safe mode, so the test script uses only bpy (no os / open).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[2]
REQUIRED_TOOLS = {"get_scene_info", "execute_blender_code", "get_addon_status"}

SCENE_SCRIPT = """
import bpy
scene = bpy.context.scene
for ob in list(scene.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(0.0, 0.0, 0.5), segments=48, ring_count=24)
ob = bpy.context.active_object
ob.name = "MCP_Check_Product"
bpy.ops.object.shade_smooth()
mat = bpy.data.materials.new("MCP_Check_Gold")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.83, 0.62, 0.22, 1.0)
bsdf.inputs["Metallic"].default_value = 1.0
bsdf.inputs["Roughness"].default_value = 0.25
ob.data.materials.append(mat)
bpy.ops.mesh.primitive_plane_add(size=6.0, location=(0.0, 0.0, 0.0))
bpy.context.active_object.name = "MCP_Check_Floor"
bpy.ops.object.light_add(type="AREA", location=(1.5, -1.5, 2.5))
bpy.context.active_object.data.energy = 400.0
bpy.ops.object.camera_add(location=(0.0, -3.2, 1.3), rotation=(1.29, 0.0, 0.0))
scene.camera = bpy.context.active_object
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 8
scene.render.resolution_x = 160
scene.render.resolution_y = 160
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = {png!r}
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath={blend!r})
print("objects", sorted(o.name for o in scene.objects))
print("material", ob.active_material.name)
"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_ready(path: Path, proc: subprocess.Popen, timeout: float = 120.0) -> dict:
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        if proc.poll() is not None:
            raise SystemExit(f"headless host exited with {proc.returncode}")
        time.sleep(0.2)
    raise SystemExit("headless host did not become ready")


def text_of(result) -> str:
    return "\n".join(getattr(c, "text", "") for c in result.content)


async def run_client(port: int, out: Path) -> dict:
    node = "node.exe" if os.name == "nt" else "node"
    params = StdioServerParameters(
        command=node,
        args=[str(ROOT / "tools" / "mcp" / "launch.mjs"), "blender"],
        env={**{k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "USERPROFILE", "SYSTEMROOT")},
             "BLENDER_PORT": str(port)},
        cwd=str(ROOT),
    )
    png = (out / "mcp_render.png").resolve().as_posix()
    blend = (out / "mcp_scene.blend").resolve().as_posix()
    report: dict = {"port": port}
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            report["server"] = {"name": init.serverInfo.name, "version": init.serverInfo.version}
            tools = await session.list_tools()
            names = sorted(t.name for t in tools.tools)
            report["tools"] = names
            missing = REQUIRED_TOOLS - set(names)
            if missing:
                raise SystemExit(f"MCP server lacks tools {sorted(missing)}")
            t0 = time.monotonic()
            before = await session.call_tool("get_scene_info", {})
            report["scene_before"] = text_of(before)[:400]
            res = await session.call_tool(
                "execute_blender_code", {"code": SCENE_SCRIPT.format(png=png, blend=blend)}
            )
            report["execute"] = {"isError": bool(res.isError), "output": text_of(res)[:800]}
            after = await session.call_tool("get_scene_info", {})
            report["scene_after"] = text_of(after)[:600]
            info = await session.call_tool(
                "get_scene_info", {"query": "MCP_Check", "fields": ["location", "size", "materials"]}
            )
            report["object_info"] = text_of(info)[:600]
            status = await session.call_tool("get_addon_status", {})
            report["addon_status"] = text_of(status)[:600]
            report["roundtrip_ms"] = round((time.monotonic() - t0) * 1000)
    checks = {
        "execute_ok": not report["execute"]["isError"],
        "object_created": "MCP_Check_Product" in report["scene_after"],
        "material_assigned": "MCP_Check_Gold" in report["object_info"] or "MCP_Check_Gold" in report["execute"]["output"],
        "blend_saved": Path(blend).is_file() and Path(blend).stat().st_size > 10_000,
        "render_written": Path(png).is_file() and Path(png).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n",
    }
    report["checks"] = checks
    report["files"] = {"png": png, "blend": blend}
    report["ok"] = all(checks.values())
    return report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--blender-python", default=str(ROOT / ".tools" / "blender-venv" / "bin" / "python"))
    ap.add_argument("--blender-bin", default=None, help="use `blender -b` instead of the bpy module")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--no-host", action="store_true", help="a Blender with the addon already listens on --port")
    ap.add_argument("--out", default=str(ROOT / ".data" / "mcp-check"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    port = args.port or (9876 if args.no_host else free_port())
    host_proc = None
    try:
        if not args.no_host:
            ready = out / "host.ready.json"
            ready.unlink(missing_ok=True)
            hostpy = str(ROOT / "tools" / "mcp" / "blender_headless_host.py")
            cmd = (
                [args.blender_bin, "-b", "--factory-startup", "--python", hostpy, "--"]
                if args.blender_bin
                else [args.blender_python, "-B", hostpy]
            ) + ["--port", str(port), "--ready-file", str(ready)]
            host_proc = subprocess.Popen(cmd, cwd=ROOT, stdout=open(out / "host.log", "w"), stderr=subprocess.STDOUT)
            host = wait_ready(ready, host_proc)
        else:
            host = {"external": True}
        report = asyncio.run(run_client(port, out))
        report["host"] = host
    finally:
        if host_proc and host_proc.poll() is None:
            host_proc.terminate()
            try:
                host_proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                host_proc.kill()
    (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
