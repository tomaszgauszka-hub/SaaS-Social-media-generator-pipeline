# Blender MCP setup

Claude Code talks to Blender through the open-source **MCP for Blender** server (`mcp-for-blender`, MIT,
github.com/ahujasid/blender-mcp — the PyPI package was renamed from `blender-mcp`). This repo pins one reviewed
release, hardens how it is started and adds a headless host for machines without a display.

MCP is for **interactive** work: building and testing scenes and procedures with Claude. Serial production never
goes through MCP: the render worker runs saved recipes (`tools/blender/scenes`) as plain processes without any
conversation (see [3D_RENDER_WORKER.md](3D_RENDER_WORKER.md)).

```
Claude Code ──stdio──▶ node tools/mcp/launch.mjs blender ──▶ .tools/mcp-venv/…/mcp-for-blender (2.1.9, pinned)
                                                                  │ TCP 127.0.0.1:9876 (JSON)
                                       Blender GUI with the add-on ┘  or  tools/mcp/blender_headless_host.py
```

## What is pinned and hardened

| Item                                                  | Where                                                                                 | Effect                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server version + every dependency, with sha256 hashes | `tools/mcp/requirements-blender-mcp.txt`                                              | `uv pip install --require-hashes`: a changed or substituted package does not install                                                              |
| Reviewed add-on file                                  | `ADDON_SHA256` in `tools/mcp/blender_headless_host.py`                                | the setup scripts and the headless host refuse any other `addon.py`                                                                               |
| Minimal environment                                   | `tools/mcp/launch.mjs`                                                                | the MCP server gets PATH/HOME/proxy only — no API keys or tokens from your shell                                                                  |
| Telemetry off                                         | `DISABLE_TELEMETRY=1`, `BLENDER_MCP_DISABLE_TELEMETRY=1`, `MCP_DISABLE_TELEMETRY=1`   | no prompts, code or screenshots leave the machine (it is also opt-in upstream)                                                                    |
| No self-update                                        | `BLENDERMCP_NO_UPDATE_CHECK=1` (server, add-on, launcher)                             | the add-on never replaces itself from the internet                                                                                                |
| Safe mode                                             | `BLENDER_MCP_SAFE_MODE=1`                                                             | model-written `execute_blender_code` scripts pass the upstream AST allowlist (no `os`, `subprocess`, `open`, `eval`, handlers, add-on installs …) |
| Loopback only                                         | `BLENDER_HOST` must be `127.0.0.1` / `localhost` / `::1`                              | the control socket is never exposed on the network                                                                                                |
| Third-party asset / paid generators off               | headless host forces Poly Haven, Sketchfab, Poly Pizza, Hyper3D, Hunyuan3D, Tripo off | no unlicensed downloads, no paid generation calls                                                                                                 |

There is exactly one Blender MCP server (no competing integrations). The repo also registers `render3d`, a thin
orchestration server over the 3D pipeline (recipes, routing, renders through the worker, library reads) — it does
not control Blender directly and has no code-execution or approval tool.

## Windows (Blender 4.3 or newer)

```powershell
# from the repository root, in PowerShell
powershell -ExecutionPolicy Bypass -File scripts\setup-3d.ps1 -Check
#   -BlenderExe "C:\Program Files\Blender Foundation\Blender 4.3\blender.exe"   (else the newest install is used)
#   -InstallUv   installs uv with winget if it is missing
```

The script: creates `.tools\mcp-venv` (Python 3.11 via uv) with the hash-locked requirements, verifies the add-on
hash, installs the add-on into `%APPDATA%\Blender Foundation\Blender\<version>\scripts\addons\blender_mcp.py`,
enables it headlessly (saved in your user preferences), writes `.tools\start-blender-mcp.cmd` (starts Blender with
the update check off), prints the `.env` lines for the worker and, with `-Check`, runs the end-to-end check below.

Then start Blender with `.tools\start-blender-mcp.cmd`, open the sidebar (**N**) → **MCP** → **Start Server**
(port 9876), and in Claude Code run `claude mcp list` — approve the project servers `blender` and `render3d` once
(they come from the repo's `.mcp.json`; project servers always need your approval).

## Linux / macOS

```bash
scripts/setup-3d.sh --check                       # bpy module only (headless)
scripts/setup-3d.sh --blender "$(which blender)"  # also install + enable the add-on in a desktop Blender
```

## Headless (render station, CI, cloud)

The upstream add-on refuses to start in background mode, because Blender's event loop — which runs its queued
commands — does not run there. `tools/mcp/blender_headless_host.py` runs the **unchanged** add-on command
handlers on the main thread itself:

```bash
.tools/blender-venv/bin/python tools/mcp/blender_headless_host.py --port 9876          # bpy module
blender -b --factory-startup --python tools/mcp/blender_headless_host.py -- --port 9876 # Blender executable
```

Options: `--blend scene.blend` (open a scene), `--ready-file f.json`, `--idle-exit 600`.

## Verify

```bash
.tools/mcp-venv/bin/python tools/mcp/check_blender_mcp.py                         # starts its own headless host
.tools/mcp-venv/bin/python tools/mcp/check_blender_mcp.py --blender-python .tools/blender43-venv/bin/python
.tools/mcp-venv/bin/python tools/mcp/check_blender_mcp.py --no-host --port 9876   # a GUI Blender already listening
```

It launches the MCP server exactly as Claude Code does (`node tools/mcp/launch.mjs blender`, stdio), then over the
MCP protocol: `initialize` → `tools/list` → `get_scene_info` → `execute_blender_code` (creates an object, assigns a
PBR material, renders a frame, saves the `.blend`, under safe mode) → `get_scene_info` / `get_addon_status`, and
checks the files on disk. Report: `.data/mcp-check/report.json`.

Verified in this repository's cloud environment (no GPU, no display): Blender **5.2.2** and **4.3.0** (bpy
modules) — all checks passed; `claude mcp list` reported the server `Connected`; a headless Claude Code session
(`claude -p … --mcp-config`) called `get_scene_info` and returned Blender's scene header. Not verified here:
Blender GUI on Windows (no Windows host) — run `scripts\setup-3d.ps1 -Check` once on the workstation.

## Restarting connections / troubleshooting

| Symptom                                       | Fix                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `claude mcp list`: blender ⏸ pending approval | run `claude` in the repo and approve the project servers                                                                         |
| blender ✗ failed / timeout                    | start Blender **first** and click _Start Server_ (or start the headless host), then `/mcp` → reconnect                           |
| `refusing to load … sha256`                   | the add-on changed: review the new release, update `ADDON_SHA256` and the hashes in `requirements-blender-mcp.txt` together      |
| `refusing to bind 0.0.0.0`                    | the socket is loopback-only by design                                                                                            |
| `execute_blender_code` rejected by safe mode  | the script used a blocked construct (imports other than bpy/bmesh/mathutils/pure stdlib, `open`, `eval` …) — rewrite it with bpy |
| port 9876 in use                              | another Blender has the server running: stop it, or use `BLENDER_PORT` (launcher) + `--port` (host)                              |

## Security notes

- The add-on's socket accepts commands from **any local process** while it runs (upstream design). Run it only
  while you work with it; never forward port 9876.
- Safe mode guards what the _model_ can be talked into; it is not a sandbox around Blender. Do not paste
  untrusted scripts into Blender.
- Production renders do not use MCP at all: closed-set recipes → validated JSON → `tools/blender/scenes/run.py`.
