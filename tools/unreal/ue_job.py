"""UE scene job validation and preset tables (pure CPython — no `unreal`, unit-tested with python3 -m unittest).

A UE scene job is written by the TypeScript adapter (packages/render3d/src/engines/unreal/job.ts) and handed to
ue_scene.py running inside UnrealEditor-Cmd. It names values from the closed sets below and bounded numbers only.
Nothing in a job is ever executed or evaluated: strings select table entries, numbers are range-checked, unknown
keys are rejected, and the only paths a job may carry are
  * output.dir                 absolute; everything the render writes stays inside it,
  * product.path               absolute; the one model file that is imported (.fbx / .glb),
  * product.bakedTextures.*    absolute; inside output.dir (the adapter copies baked maps there first).

The tables mirror packages/render3d/src/contracts/recipe.ts (a vitest compares both).
"""

from __future__ import annotations

import math
import os
import re

UE_SCENE_VERSION = 1
JOB_KIND = "ue_scene"

TEMPLATES = (
    "UE_LUXURY_STUDIO",
    "UE_AUTOMOTIVE_CINEMATIC",
    "UE_MODERN_INTERIOR",
    "UE_INDUSTRIAL_WORKSHOP",
    "UE_TECHNOLOGY_SHOWCASE",
    "UE_ARCHITECTURAL_DEMO",
)
CAMERA_PRESETS = (
    "orbit_closeup",
    "orbit_wide",
    "turntable",
    "push_in",
    "crane_up",
    "dolly_side",
    "macro_slide",
    "top_down",
    "hero_low",
)
#: movement speed → span multiplier of the camera / product move (same factors as the Blender generators)
MOVEMENTS = {"static": 0.0, "slow": 0.6, "medium": 1.0, "fast": 1.6}
LIGHTING_PRESETS = (
    "premium_studio",
    "soft_daylight",
    "dramatic_rim",
    "warm_home",
    "cool_tech",
    "workshop_practical",
    "high_key",
)
BACKGROUND_PRESETS = (
    "dark_gradient",
    "light_gradient",
    "seamless_white",
    "soft_pastel",
    "brand_color",
    "transparent",
    "environment",
)
ENVIRONMENT_PRESETS = ("kitchen", "bathroom", "workshop", "living_room", "desk", "garage")
ACTIONS = ("TRIGGER_PRESS", "CHUCK_SPIN", "LED_ON", "CLUTCH_TURN", "GEAR_SHIFT", "CAP_OPEN", "LIGHT_ON")
QUALITIES = ("preview", "production")
FIDELITY = ("VERIFIED_MANUFACTURER", "TECHNICAL_RECONSTRUCTION", "APPROXIMATE_VISUALIZATION", "FICTIONAL_DEMO")
MODEL_FORMATS = ("fbx", "glb")
FPS_VALUES = (24, 25, 30, 50, 60)
#: Movie Render Queue executors usable from a script: in-editor PIE render, or a separate -game render process
EXECUTORS = ("pie", "new_process")
#: global illumination: auto = Lumen when the project / hardware supports it, else screen-space
GI_MODES = ("auto", "lumen", "screen_space")
#: material compatibility statuses of tools/blender/scenes/export.py
MATERIAL_STATUSES = ("PBR_DIRECT", "NEEDS_BAKE", "APPROXIMATED", "UNSUPPORTED")
BAKE_CHANNELS = ("baseColor", "roughness", "metallic", "normal")
TEXTURE_EXTS = (".png", ".jpg", ".jpeg", ".tga", ".exr")

#: render size per quality: preview renders at half size (even numbers, ≥ 128 px) — like the Blender generators
QUALITY_SCALE = {"preview": 0.5, "production": 1.0}

HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
NAME = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
#: a material name as Blender / the importer writes it (no control characters, bounded)
MATERIAL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,119}$")

TOP_KEYS = {
    "version", "kind", "jobId", "template", "quality", "durationSec", "fps", "resolution", "seed", "turns",
    "camera", "framing", "lighting", "background", "environment", "focus", "actions", "product", "render",
    "output", "interactive",
}


class UeJobError(ValueError):
    """The job is invalid (exit code 3): nothing was imported or rendered."""


# ------------------------------------------------------------------------------------------- primitives ----


def _keys(d: dict, allowed: set, where: str) -> None:
    extra = sorted(str(k) for k in d if k not in allowed)
    if extra:
        raise UeJobError(f"{where}: unknown key(s) {', '.join(extra)}")


def _obj(v, where: str) -> dict:
    if not isinstance(v, dict):
        raise UeJobError(f"{where} must be an object")
    return v


def _num(v, where: str, lo: float, hi: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise UeJobError(f"{where} must be a number")
    if not (lo <= v <= hi):
        raise UeJobError(f"{where}={v} outside [{lo}, {hi}]")
    return float(v)


def _int(v, where: str, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise UeJobError(f"{where} must be an integer")
    if not (lo <= v <= hi):
        raise UeJobError(f"{where}={v} outside [{lo}, {hi}]")
    return v


def _enum(v, allowed, where: str) -> str:
    if not isinstance(v, str) or v not in allowed:
        raise UeJobError(f"{where}={v!r} is not one of {', '.join(allowed)}")
    return v


def _bool(v, where: str) -> bool:
    if not isinstance(v, bool):
        raise UeJobError(f"{where} must be true or false")
    return v


def _hex(v, where: str) -> str:
    if not isinstance(v, str) or not HEX.match(v):
        raise UeJobError(f"{where} must be #RRGGBB")
    return v


def abs_path(p, where: str) -> str:
    """A normalised absolute path (no NUL, no control characters)."""
    if not isinstance(p, str) or not p or len(p) > 1024 or any(ord(c) < 32 for c in p) or not os.path.isabs(p):
        raise UeJobError(f"{where} must be an absolute path")
    return os.path.normpath(p)


def inside(child: str, root: str) -> bool:
    """child is root or below it (case-insensitive where the OS is)."""
    c = os.path.normcase(os.path.abspath(child))
    r = os.path.normcase(os.path.abspath(root))
    return c == r or c.startswith(r.rstrip("\\/") + os.sep)


# ------------------------------------------------------------------------------------------- validation ----


def validate_job(job) -> dict:
    """Validated, normalised copy of a UE scene job (raises UeJobError)."""
    job = _obj(job, "job")
    _keys(job, TOP_KEYS, "job")
    if job.get("version") != UE_SCENE_VERSION:
        raise UeJobError(f"job.version must be {UE_SCENE_VERSION}")
    if job.get("kind") != JOB_KIND:
        raise UeJobError(f"job.kind must be {JOB_KIND!r}")
    out: dict = {"version": UE_SCENE_VERSION, "kind": JOB_KIND}
    jid = job.get("jobId")
    if not isinstance(jid, str) or not SAFE_ID.match(jid) or ".." in jid:
        raise UeJobError("job.jobId: letters, digits, _ . - only (max 120), no '..'")
    out["jobId"] = jid
    out["template"] = _enum(job.get("template"), TEMPLATES, "job.template")
    out["quality"] = _enum(job.get("quality", "preview"), QUALITIES, "job.quality")
    out["durationSec"] = _num(job.get("durationSec"), "job.durationSec", 0.5, 20.0)
    fps = job.get("fps")
    if isinstance(fps, bool) or fps not in FPS_VALUES:
        raise UeJobError("job.fps must be 24, 25, 30, 50 or 60")
    out["fps"] = int(fps)
    res = job.get("resolution")
    if not isinstance(res, list) or len(res) != 2:
        raise UeJobError("job.resolution must be [width, height]")
    w = _int(res[0], "job.resolution[0]", 128, 4096)
    h = _int(res[1], "job.resolution[1]", 128, 4096)
    if w % 2 or h % 2:
        raise UeJobError("job.resolution: even numbers")
    out["resolution"] = [w, h]
    out["seed"] = _int(job.get("seed", 1), "job.seed", 0, 2**31 - 1)
    out["turns"] = _num(job.get("turns", 1.0), "job.turns", 0.1, 4.0)

    cam = _obj(job.get("camera"), "job.camera")
    _keys(cam, {"preset", "movement"}, "job.camera")
    out["camera"] = {
        "preset": _enum(cam.get("preset"), CAMERA_PRESETS, "job.camera.preset"),
        "movement": _enum(cam.get("movement", "slow"), tuple(MOVEMENTS), "job.camera.movement"),
    }
    fr = _obj(job.get("framing", {}), "job.framing")
    _keys(fr, {"centerY", "fill"}, "job.framing")
    fill = fr.get("fill")
    out["framing"] = {
        "centerY": _num(fr.get("centerY", 0.5), "job.framing.centerY", 0.3, 0.7),
        "fill": None if fill is None else _num(fill, "job.framing.fill", 0.25, 0.9),
    }
    light = _obj(job.get("lighting"), "job.lighting")
    _keys(light, {"preset"}, "job.lighting")
    out["lighting"] = {"preset": _enum(light.get("preset"), LIGHTING_PRESETS, "job.lighting.preset")}
    bg = _obj(job.get("background"), "job.background")
    _keys(bg, {"preset", "color", "accent"}, "job.background")
    background = {"preset": _enum(bg.get("preset"), BACKGROUND_PRESETS, "job.background.preset"),
                  "color": None, "accent": None}
    for key in ("color", "accent"):
        if bg.get(key) is not None:
            background[key] = _hex(bg[key], f"job.background.{key}")
    out["background"] = background
    env = job.get("environment")
    out["environment"] = None
    if env is not None:
        env = _obj(env, "job.environment")
        _keys(env, {"preset"}, "job.environment")
        out["environment"] = {"preset": _enum(env.get("preset"), ENVIRONMENT_PRESETS, "job.environment.preset")}
    if background["preset"] == "environment" and out["environment"] is None:
        raise UeJobError("background 'environment' needs job.environment.preset")
    focus = job.get("focus")
    if focus is not None and (not isinstance(focus, str) or not NAME.match(focus)):
        raise UeJobError("job.focus must be a part name")
    out["focus"] = focus
    out["actions"] = _actions(job.get("actions", []), out["durationSec"])

    o = _obj(job.get("output"), "job.output")
    _keys(o, {"dir"}, "job.output")
    out_dir = abs_path(o.get("dir"), "job.output.dir")
    if os.path.dirname(out_dir) == out_dir:
        raise UeJobError("job.output.dir must not be a filesystem root")
    out["output"] = {"dir": out_dir}
    out["product"] = _product(_obj(job.get("product"), "job.product"), out_dir)
    out["render"] = _render(_obj(job.get("render", {}), "job.render"))
    out["interactive"] = _bool(job.get("interactive", False), "job.interactive")
    return out


def _actions(actions, duration: float) -> list[dict]:
    if not isinstance(actions, list) or len(actions) > 8:
        raise UeJobError("job.actions must be a list of at most 8 actions")
    parsed = []
    for k, a in enumerate(actions):
        where = f"job.actions[{k}]"
        a = _obj(a, where)
        _keys(a, {"kind", "startSec", "endSec"}, where)
        kind = _enum(a.get("kind"), ACTIONS, f"{where}.kind")
        start = _num(a.get("startSec"), f"{where}.startSec", 0.0, duration)
        end = _num(a.get("endSec"), f"{where}.endSec", start, duration)
        parsed.append({"kind": kind, "startSec": start, "endSec": end})
    return parsed


def _product(p: dict, out_dir: str) -> dict:
    _keys(p, {"assetId", "path", "format", "sha256", "dimensionsM", "fidelity", "frontYawDeg", "materialReport",
              "bakedTextures"}, "job.product")
    asset = p.get("assetId")
    if not isinstance(asset, str) or not SAFE_ID.match(asset) or ".." in asset:
        raise UeJobError("job.product.assetId has invalid characters")
    path = abs_path(p.get("path"), "job.product.path")
    fmt = _enum(p.get("format"), MODEL_FORMATS, "job.product.format")
    if os.path.splitext(path)[1].lower() != "." + fmt:
        raise UeJobError(f"job.product.path must be a .{fmt} file")
    sha = p.get("sha256")
    if not isinstance(sha, str) or not SHA256.match(sha):
        raise UeJobError("job.product.sha256 must be a lowercase sha256 hex digest")
    dims = p.get("dimensionsM")
    if dims is not None:
        if not isinstance(dims, list) or len(dims) != 3:
            raise UeJobError("job.product.dimensionsM must be [x, y, z] in metres")
        dims = [_num(d, f"job.product.dimensionsM[{i}]", 0.001, 50.0) for i, d in enumerate(dims)]
    out = {
        "assetId": asset,
        "path": path,
        "format": fmt,
        "sha256": sha,
        "dimensionsM": dims,
        "fidelity": _enum(p.get("fidelity"), FIDELITY, "job.product.fidelity"),
        "frontYawDeg": _num(p.get("frontYawDeg", 0.0), "job.product.frontYawDeg", -180.0, 180.0),
        "materialReport": _material_report(p.get("materialReport")),
        "bakedTextures": _baked(p.get("bakedTextures", {}), out_dir),
    }
    return out


def _material_report(rep):
    if rep is None:
        return None
    rep = _obj(rep, "job.product.materialReport")
    _keys(rep, {"materials", "counts", "ueReady"}, "job.product.materialReport")
    rows = rep.get("materials")
    if not isinstance(rows, list) or len(rows) > 64:
        raise UeJobError("job.product.materialReport.materials must be a list (≤ 64)")
    clean = []
    for k, r in enumerate(rows):
        where = f"job.product.materialReport.materials[{k}]"
        r = _obj(r, where)
        _keys(r, {"material", "status", "notes", "textures", "baseColor", "roughness", "metallic"}, where)
        name = r.get("material")
        if not isinstance(name, str) or not MATERIAL_NAME.match(name):
            raise UeJobError(f"{where}.material must be a material name")
        notes = r.get("notes", [])
        if not isinstance(notes, list) or len(notes) > 16 or any(
                not isinstance(n, str) or len(n) > 300 or any(ord(c) < 32 for c in n) for n in notes):
            raise UeJobError(f"{where}.notes must be ≤ 16 short strings")
        textures = r.get("textures", [])
        if not isinstance(textures, list) or len(textures) > 32 or any(
                not isinstance(t, str) or len(t) > 200 or any(ord(c) < 32 for c in t) for t in textures):
            raise UeJobError(f"{where}.textures must be ≤ 32 image names")
        row = {"material": name, "status": _enum(r.get("status"), MATERIAL_STATUSES, f"{where}.status"),
               "notes": list(notes), "textures": list(textures), "baseColor": None, "roughness": None,
               "metallic": None}
        if r.get("baseColor") is not None:
            row["baseColor"] = _hex(r["baseColor"], f"{where}.baseColor")
        for key in ("roughness", "metallic"):
            if r.get(key) is not None:
                row[key] = _num(r[key], f"{where}.{key}", 0.0, 1.0)
        clean.append(row)
    return {"materials": clean}


def _baked(baked, out_dir: str) -> dict:
    baked = _obj(baked, "job.product.bakedTextures")
    if len(baked) > 64:
        raise UeJobError("job.product.bakedTextures: at most 64 materials")
    out = {}
    for name, maps in baked.items():
        if not isinstance(name, str) or not MATERIAL_NAME.match(name):
            raise UeJobError(f"job.product.bakedTextures key {name!r} is not a material name")
        maps = _obj(maps, f"job.product.bakedTextures.{name}")
        _keys(maps, set(BAKE_CHANNELS), f"job.product.bakedTextures.{name}")
        clean = {}
        for ch, path in maps.items():
            where = f"job.product.bakedTextures.{name}.{ch}"
            path = abs_path(path, where)
            if not inside(path, out_dir) or path == out_dir:
                raise UeJobError(f"{where} must be inside job.output.dir")
            if os.path.splitext(path)[1].lower() not in TEXTURE_EXTS:
                raise UeJobError(f"{where} must be an image ({', '.join(TEXTURE_EXTS)})")
            clean[ch] = path
        out[name] = clean
    return out


def _render(r: dict) -> dict:
    _keys(r, {"executor", "gi", "maxRenderSec", "warmUpFrames", "spatialSamples", "temporalSamples",
              "setupOnly"}, "job.render")
    out = {
        "executor": _enum(r.get("executor", "pie"), EXECUTORS, "job.render.executor"),
        "gi": _enum(r.get("gi", "auto"), GI_MODES, "job.render.gi"),
        "maxRenderSec": _num(r.get("maxRenderSec", 3600), "job.render.maxRenderSec", 10, 172800),
        "warmUpFrames": None,
        "spatialSamples": None,
        "temporalSamples": None,
        "setupOnly": _bool(r.get("setupOnly", False), "job.render.setupOnly"),
    }
    if r.get("warmUpFrames") is not None:
        out["warmUpFrames"] = _int(r["warmUpFrames"], "job.render.warmUpFrames", 0, 256)
    for key in ("spatialSamples", "temporalSamples"):
        if r.get(key) is not None:
            out[key] = _int(r[key], f"job.render.{key}", 1, 64)
    return out


# ------------------------------------------------------------------------------------------ derived values ----


def frame_count(duration_sec: float, fps: int) -> int:
    """Frames of a clip: ⌈duration·fps⌉ (at least 2) — the Blender generators' rule."""
    return max(2, int(math.ceil(duration_sec * fps - 1e-9)))


def render_size(quality: str, resolution: list[int]) -> tuple[int, int]:
    """Output pixel size for the quality (preview at half size, even numbers, ≥ 128 px)."""
    s = QUALITY_SCALE[quality]
    w, h = resolution
    return max(128, int(round(w * s / 2)) * 2), max(128, int(round(h * s / 2)) * 2)


def job_path_from(argv: list[str], environ) -> str:
    """The job file: the first argument after the script (`ue_scene.py <job.json>`), else $R3D_UE_JOB.

    UnrealEditor-Cmd -ExecutePythonScript="<script> <args>" puts the arguments in sys.argv[1:]; the adapter passes
    the job through the environment instead, so no path ever has to be quoted on the editor's command line."""
    args = [a for a in argv[1:] if a and not a.startswith("--")]
    path = args[0] if args else environ.get("R3D_UE_JOB", "")
    if not path:
        raise UeJobError("no job: pass <job.json> or set R3D_UE_JOB")
    return abs_path(path, "job file")
