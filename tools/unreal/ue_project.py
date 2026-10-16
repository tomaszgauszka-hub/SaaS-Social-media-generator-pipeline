"""Set up / check the dedicated Unreal render project (plain CPython — no editor needed, unit-tested).

    python3 tools/unreal/ue_project.py init  <path/to/Render3D.uproject> [--remote-exec] [--lumen]
    python3 tools/unreal/ue_project.py check <path/to/Render3D.uproject>

`init` turns a FRESH blank project (created in the Epic Games Launcher / Unreal Project Browser: Games → Blank,
Blueprint, no starter content) into the render project:
  * refuses anything that looks like an existing game project — C++ modules / a Source folder, content outside
    /Game/Render3D, maps or assets already present — so a real project is never modified;
  * writes the marker Config/DefaultRender3D.ini ([Render3D] DedicatedRenderProject=True) that the adapter
    (detect.ts) and ue_scene.py require before they touch anything;
  * enables the plugins the adapter uses in the .uproject (a backup .uproject.bak is kept): Python Editor Script
    Plugin, Editor Scripting Utilities, Sequencer Scripting, Movie Render Queue (MovieRenderPipeline);
  * --remote-exec: Python remote execution ON, multicast bound to 127.0.0.1, TTL 0 (loopback only) in
    Config/DefaultEngine.ini;
  * --lumen: Lumen GI + reflections and mesh distance fields in Config/DefaultEngine.ini (UE 5 blank projects
    usually have them already).
The plugin and setting names are the ones documented for UE 5.x; verify them in Edit > Plugins / Project Settings
of your 5.8 install (this repository could not run an editor).
"""

from __future__ import annotations

import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import ue_util  # noqa: E402

PLUGINS = ("PythonScriptPlugin", "EditorScriptingUtilities", "SequencerScripting", "MovieRenderPipeline")
#: content folders a fresh blank project may already have (engine-created, empty)
ALLOWED_CONTENT = {"Render3D", "Python", "Collections", "Developers", "__ExternalActors__", "__ExternalObjects__"}
REMOTE_SECTION = "[/Script/PythonScriptPlugin.PythonScriptPluginSettings]"
REMOTE_KEYS = (("bRemoteExecution", "True"), ("RemoteExecutionMulticastGroupEndpoint", "239.0.0.1:6766"),
               ("RemoteExecutionMulticastBindAddress", "127.0.0.1"), ("RemoteExecutionMulticastTtl", "0"))
RENDER_SECTION = "[/Script/Engine.RendererSettings]"
LUMEN_KEYS = (("r.GenerateMeshDistanceFields", "True"), ("r.DynamicGlobalIlluminationMethod", "1"),
              ("r.ReflectionMethod", "1"))
MARKER_TEXT = (f"{ue_util.MARKER_SECTION}\n"
               "; Marker of the dedicated render project of packages/render3d (tools/unreal/ue_project.py).\n"
               "; The adapter only ever modifies a project carrying this marker, and only below /Game/Render3D.\n"
               f"{ue_util.MARKER_KEY}\n")


class ProjectSetupError(ValueError):
    pass


def read_uproject(path: str) -> dict:
    if not path.lower().endswith(".uproject") or not os.path.isfile(path):
        raise ProjectSetupError(f"{path} is not a .uproject file")
    try:
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except ValueError as e:
        raise ProjectSetupError(f"{path} is not valid JSON: {e}") from e
    if not isinstance(data, dict) or "FileVersion" not in data:
        raise ProjectSetupError(f"{path} does not look like an Unreal project file (no FileVersion)")
    return data


def game_project_problems(project_dir: str, data: dict) -> list[str]:
    """Why this project must not be turned into the render project (empty list: a fresh blank project)."""
    problems = []
    if data.get("Modules"):
        problems.append("the project has C++ modules (.uproject Modules)")
    if os.path.isdir(os.path.join(project_dir, "Source")):
        problems.append("the project has a Source folder (C++ code)")
    content = os.path.join(project_dir, "Content")
    if os.path.isdir(content):
        foreign = sorted(n for n in os.listdir(content) if n not in ALLOWED_CONTENT)
        if foreign:
            problems.append(f"the project already has content: {', '.join(foreign[:8])}")
    return problems


def add_plugins(data: dict, names=PLUGINS) -> tuple[dict, list[str]]:
    """The .uproject data with the plugins enabled (existing entries switched on, others appended)."""
    plugins = [dict(p) for p in data.get("Plugins", []) if isinstance(p, dict)]
    changed = []
    for name in names:
        hit = next((p for p in plugins if p.get("Name") == name), None)
        if hit is None:
            plugins.append({"Name": name, "Enabled": True})
            changed.append(name)
        elif not hit.get("Enabled"):
            hit["Enabled"] = True
            changed.append(name)
    out = dict(data)
    out["Plugins"] = plugins
    return out, changed


def ini_set(text: str, section: str, pairs) -> str:
    """Set key=value pairs inside an ini section (section created when missing; other lines untouched)."""
    lines = text.splitlines()
    try:
        start = next(i for i, ln in enumerate(lines) if ln.strip() == section)
    except StopIteration:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(section)
        lines.extend(f"{k}={v}" for k, v in pairs)
        return "\n".join(lines) + "\n"
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("[")), len(lines))
    body = lines[start + 1:end]
    for k, v in pairs:
        idx = next((i for i, ln in enumerate(body) if ln.split("=", 1)[0].strip() == k), None)
        if idx is None:
            insert_at = len(body)
            while insert_at > 0 and not body[insert_at - 1].strip():
                insert_at -= 1
            body.insert(insert_at, f"{k}={v}")
        else:
            body[idx] = f"{k}={v}"
    return "\n".join(lines[:start + 1] + body + lines[end:]) + "\n"


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8-sig") as fh:
            return fh.read()
    except OSError:
        return ""


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


def init(uproject: str, remote_exec: bool = False, lumen: bool = False) -> dict:
    uproject = os.path.abspath(uproject)
    project_dir = os.path.dirname(uproject)
    data = read_uproject(uproject)
    config = os.path.join(project_dir, "Config")
    already = ue_util.is_dedicated_project(config)
    if not already:
        problems = game_project_problems(project_dir, data)
        if problems:
            raise ProjectSetupError("refusing to modify this project — create a new blank project for rendering: "
                                    + "; ".join(problems))
    new, changed = add_plugins(data)
    if changed:
        shutil.copyfile(uproject, uproject + ".bak")
        _write(uproject, json.dumps(new, indent="\t") + "\n")
    _write(os.path.join(config, ue_util.MARKER_FILE), MARKER_TEXT)
    engine_ini = os.path.join(config, "DefaultEngine.ini")
    if remote_exec or lumen:
        text = _read(engine_ini)
        if remote_exec:
            text = ini_set(text, REMOTE_SECTION, REMOTE_KEYS)
        if lumen:
            text = ini_set(text, RENDER_SECTION, LUMEN_KEYS)
        _write(engine_ini, text)
    return {"ok": True, "project": uproject, "pluginsEnabled": changed, "marker": os.path.join(config, ue_util.MARKER_FILE),
            "remoteExec": remote_exec, "lumen": lumen, "wasDedicated": already}


def check(uproject: str) -> dict:
    uproject = os.path.abspath(uproject)
    data = read_uproject(uproject)
    config = os.path.join(os.path.dirname(uproject), "Config")
    listed = {p.get("Name"): bool(p.get("Enabled")) for p in data.get("Plugins", []) if isinstance(p, dict)}
    engine_ini = _read(os.path.join(config, "DefaultEngine.ini"))
    return {"project": uproject, "dedicated": ue_util.is_dedicated_project(config),
            "engineAssociation": data.get("EngineAssociation"),
            "plugins": {n: listed.get(n, False) for n in PLUGINS},
            "remoteExecSection": REMOTE_SECTION in engine_ini}


def cli(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}
    if len(args) != 2 or args[0] not in ("init", "check"):
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    try:
        out = init(args[1], "--remote-exec" in flags, "--lumen" in flags) if args[0] == "init" else check(args[1])
    except ProjectSetupError as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        return 3
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(cli(sys.argv))
