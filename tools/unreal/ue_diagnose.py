"""Editor diagnostics for the UE adapter: engine version, which Python APIs exist (and which renamed variant),
detectable plugins, rendering capabilities, remote-execution settings and whether this is the dedicated project.

Run inside the editor of the render project — any of
    UnrealEditor-Cmd <Render3D.uproject> -run=pythonscript -script=<abs>/tools/unreal/ue_diagnose.py
    UnrealEditor-Cmd <Render3D.uproject> -ExecutePythonScript="<abs>/ue_diagnose.py <out.json> --quit"
    Python remote execution (packages/render3d remote-exec.ts / tools/unreal/remote_exec.py diagnose)
    the editor's Output Log (Cmd: py "<abs>/ue_diagnose.py")
Output: <out.json> argument, else $R3D_UE_DIAG_OUT, else <Project>/Saved/Render3D/diagnose.json.

The report never assumes an API from an older engine: every feature is probed (ue_compat.API_CHECKS) and the
variant found is named. `build_report` is pure (any module-like object) and unit-tested with a fake `unreal`.
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(globals().get("__file__") or os.environ.get("R3D_UE_TOOLS", "") + "/x"))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import ue_compat  # noqa: E402
import ue_mrq  # noqa: E402
import ue_util  # noqa: E402

DIAG_VERSION = "ue-diagnose/1"
#: plugins the adapter needs → a class whose presence proves the plugin is loaded (fallback detection)
EXPECTED_PLUGINS = {
    "PythonScriptPlugin": None,  # this script runs: the plugin is loaded
    "EditorScriptingUtilities": "EditorAssetLibrary",
    "SequencerScripting": "MovieSceneScriptingDoubleChannel",
    "MovieRenderPipeline": "MoviePipelineQueueSubsystem",
    "LevelSequenceEditor": "LevelSequenceEditorSubsystem",
    "Interchange": "InterchangeManager",
}
#: names that suggest an AI-assistant / MCP integration is installed (reported, never assumed)
AI_HINT = re.compile(r"(mcp|model.?context|ai.?assist|assistant|copilot|llm|chatgpt|claude|genai)", re.I)
RENDER_CVARS = ("r.GenerateMeshDistanceFields", "r.RayTracing", "r.DynamicGlobalIlluminationMethod",
                "r.ReflectionMethod", "r.Lumen.HardwareRayTracing", "Interchange.FeatureFlags.Import.FBX",
                "Interchange.FeatureFlags.Import.GLTF")


def uproject_plugins(uproject_path: str | None) -> dict[str, bool]:
    """Plugins listed in the .uproject (name → Enabled)."""
    if not uproject_path:
        return {}
    try:
        with open(uproject_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    out = {}
    for p in data.get("Plugins", []) if isinstance(data, dict) else []:
        if isinstance(p, dict) and isinstance(p.get("Name"), str):
            out[p["Name"]] = bool(p.get("Enabled", False))
    return out


def plugin_report(module, enabled_names: list[str] | None, listed: dict[str, bool]) -> dict:
    """Expected plugins: enabled per the engine's plugin list when readable, else the .uproject / a class probe."""
    expected = {}
    for name, probe in EXPECTED_PLUGINS.items():
        if enabled_names is not None:
            expected[name] = {"enabled": name in enabled_names, "method": "PluginBlueprintLibrary"}
        elif name in listed:
            expected[name] = {"enabled": listed[name], "method": "uproject"}
        elif probe is None:
            expected[name] = {"enabled": True, "method": "running"}
        else:
            expected[name] = {"enabled": ue_compat.has_path(module, probe), "method": f"class probe {probe}"}
    names = enabled_names if enabled_names is not None else [n for n, on in listed.items() if on]
    return {
        "expected": expected,
        "enabled": sorted(names),
        "enabledSource": "PluginBlueprintLibrary" if enabled_names is not None else "uproject",
        "aiIntegrationCandidates": sorted(n for n in names if AI_HINT.search(n)),
    }


def build_report(module, project: dict, cvars: dict, enabled_plugins: list[str] | None, engine_version: str,
                 remote: dict | None) -> dict:
    variants = ue_compat.resolve(module)
    missing = ue_compat.missing_required(variants)
    plugins = plugin_report(module, enabled_plugins, uproject_plugins(project.get("uproject")))
    gi, gi_warning = ue_mrq.choose_gi("auto", cvars)
    warnings = []
    if not project.get("dedicated"):
        warnings.append("this is not the dedicated render project (Config/DefaultRender3D.ini marker missing): "
                        "ue_scene.py refuses to run here")
    for name, st in plugins["expected"].items():
        if not st["enabled"] and name in ("EditorScriptingUtilities", "SequencerScripting", "MovieRenderPipeline"):
            warnings.append(f"plugin {name} is not enabled")
    if gi_warning:
        warnings.append(gi_warning)
    if variants.get("mrqConfig") == "MoviePipelineMasterConfig":
        warnings.append("old Movie Render Queue naming (MoviePipelineMasterConfig): an engine before 5.1?")
    if remote is not None:
        bind = str(remote.get("multicastBindAddress", ""))
        if remote.get("enabled") and bind not in ("127.0.0.1", "localhost", ""):
            warnings.append(f"Python remote execution binds to {bind}: set the Multicast Bind Address to 127.0.0.1")
        if remote.get("enabled") and int(remote.get("multicastTtl", 0) or 0) != 0:
            warnings.append("Python remote execution multicast TTL is not 0: messages can leave this machine")
    renames = {k: variants[k] for k in ("actors", "levels", "editorWorld", "assets", "mrqConfig", "sequenceAddTrack",
                                        "sequenceBindingId", "sectionChannels", "mrqRenderWithInstance")}
    return {
        "ok": not missing and bool(project.get("dedicated")),
        "tool": DIAG_VERSION,
        "engineVersion": engine_version,
        "python": sys.version.split()[0],
        "apis": variants,
        "missingRequired": missing,
        "variantsFound": renames,
        "movieRenderGraph": variants.get("movieRenderGraph") is not None,
        "plugins": plugins,
        "project": project,
        "rendering": {"cvars": cvars, "gi": gi},
        "remoteExecution": remote,
        "warnings": warnings,
    }


def _remote_settings(ue) -> dict | None:
    cls = getattr(ue, "PythonScriptPluginSettings", None)
    if cls is None:
        return None
    try:
        s = ue.get_default_object(cls)
    except Exception:  # noqa: BLE001
        return None
    out = {}
    for key, prop in (("enabled", "remote_execution"), ("multicastGroupEndpoint", "remote_execution_multicast_group_endpoint"),
                      ("multicastBindAddress", "remote_execution_multicast_bind_address"),
                      ("multicastTtl", "remote_execution_multicast_ttl")):
        try:
            v = s.get_editor_property(prop)
            out[key] = v if isinstance(v, (bool, int, float)) else str(v)
        except Exception:  # noqa: BLE001
            out[key] = None
    return out


def collect(ue) -> dict:
    """Probe the running editor (needs the real `unreal` module)."""
    api = ue_compat.Api(ue)
    cfg = api.project_config_dir()
    try:
        uproject = api.full_path(ue.Paths.get_project_file_path())
    except Exception:  # noqa: BLE001
        uproject = None
    project = {"dir": api.project_dir(), "uproject": uproject, "configDir": cfg,
               "dedicated": ue_util.is_dedicated_project(cfg), "markerFile": ue_util.MARKER_FILE}
    cvars = {name: api.cvar_int(name) for name in RENDER_CVARS}
    return build_report(ue, project, cvars, api.enabled_plugins(), api.engine_version(), _remote_settings(ue))


def output_path(argv: list[str], environ, saved_dir: str | None) -> str:
    args = [a for a in argv[1:] if a and not a.startswith("--")]
    if args:
        return os.path.normpath(os.path.abspath(args[0]))
    if environ.get("R3D_UE_DIAG_OUT"):
        return os.path.normpath(os.path.abspath(environ["R3D_UE_DIAG_OUT"]))
    if saved_dir:
        return os.path.join(saved_dir, "Render3D", "diagnose.json")
    return os.path.abspath("diagnose.json")


def main(argv: list[str], environ=os.environ) -> int:
    print(f"R3D_STARTED script=ue_diagnose pid={os.getpid()}", flush=True)
    ue = ue_compat.unreal
    if ue is None:
        print(json.dumps({"ok": False, "error": "not_in_editor",
                          "message": "ue_diagnose.py runs inside the Unreal Editor (the `unreal` module)"}),
              file=sys.stderr)
        return 1
    report = collect(ue)
    try:
        saved = ue_compat.Api(ue).project_saved_dir()
    except Exception:  # noqa: BLE001
        saved = None
    path = output_path(argv, environ, saved)
    if not path.lower().endswith(".json"):
        print(json.dumps({"ok": False, "error": "bad_output", "message": "output must be a .json file"}),
              file=sys.stderr)
        return 3
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ue_util.atomic_write_json(path, report)
    print(f"DIAGNOSE {path}", flush=True)
    print(json.dumps({k: report[k] for k in ("ok", "engineVersion", "missingRequired", "warnings")}), flush=True)
    return 0


if __name__ == "__main__" or __name__ not in ("ue_diagnose",):  # also the editor's file runner (see ue_scene)
    _code = main(sys.argv)
    if "--quit" in sys.argv and ue_compat.unreal is not None:
        try:
            ue_compat.unreal.SystemLibrary.quit_editor()
        except Exception:  # noqa: BLE001
            os._exit(_code)
