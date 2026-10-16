"""Scene job validation and preset tables for the parametric 3D scene generators (no bpy — unit-tested alone).

A scene job is written by the TypeScript render worker (packages/render3d, contract SceneJob) and names only
values from the closed sets below: templates, camera / lighting / background / environment presets, product
actions, output kinds. Nothing in a job is executed or evaluated — strings select table entries, numbers are
range-checked, paths must be absolute and stay inside the job's output directory or the declared model file.
The same tables are mirrored in packages/render3d/src/contracts/recipe.ts (a TS test compares both).
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass

SCENE_SPEC_VERSION = 1

TEMPLATES = (
    "PRODUCT_HERO",
    "TURNTABLE_360",
    "MACRO_DETAIL",
    "EXPLODED_VIEW",
    "PRODUCT_ASSEMBLY",
    "LIFESTYLE",
    "TECHNICAL",
    "BRAND_ENVIRONMENT",
)
#: templates that show the product's construction — only for models with a real or verified part structure
STRUCTURAL_TEMPLATES = ("EXPLODED_VIEW", "PRODUCT_ASSEMBLY", "TECHNICAL")

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
MOVEMENTS = {"static": 0.0, "slow": 0.6, "medium": 1.0, "fast": 1.6}

#: lighting preset → (studio rig in tools/blender/studio/lighting.py, exposure multiplier, accent kelvin)
LIGHTING = {
    "premium_studio": ("three_point", 1.0, 6500.0),
    "soft_daylight": ("window_daylight", 1.0, 5600.0),
    "dramatic_rim": ("rim_dramatic", 1.0, 6500.0),
    "warm_home": ("warm_practical", 1.0, 3400.0),
    "cool_tech": ("rim_dramatic", 1.1, 9000.0),
    "workshop_practical": ("warm_practical", 1.15, 4200.0),
    "high_key": ("soft_box", 1.0, 6500.0),
}

#: background preset → studio environment (or a gradient sweep built by the scene module)
BACKGROUNDS = {
    "dark_gradient": "dark_premium",
    "light_gradient": "bright_minimal",
    "seamless_white": "bright_minimal",
    "soft_pastel": "soft_pastel",
    "brand_color": "brand_sweep",
    "transparent": "transparent",
    "environment": "environment",
}

#: lifestyle environments: a studio room + the furniture the product stands on (built in scene_env.py)
ENVIRONMENTS = ("kitchen", "bathroom", "workshop", "living_room", "desk", "garage")

#: product actions a model may declare (procedural products declare theirs; imported models declare none)
ACTIONS = (
    "TRIGGER_PRESS",
    "CHUCK_SPIN",
    "LED_ON",
    "CLUTCH_TURN",
    "GEAR_SHIFT",
    "CAP_OPEN",
    "LIGHT_ON",
)

PRODUCT_SOURCES = ("procedural", "file")
MODEL_FORMATS = ("glb", "gltf", "obj", "fbx", "blend")
EXPORT_FORMATS = ("glb", "fbx")
QUALITIES = ("preview", "production")
DEVICES = ("CPU", "GPU", "AUTO")
#: CYCLES everywhere; EEVEE only for fast previews on a GPU workstation (software EGL is far slower than Cycles)
RENDERERS = ("CYCLES", "EEVEE")
FIDELITY = ("VERIFIED_MANUFACTURER", "TECHNICAL_RECONSTRUCTION", "APPROXIMATE_VISUALIZATION", "FICTIONAL_DEMO")
#: a part structure can be shown (exploded / assembly / technical) for these fidelity levels only; a fictional demo
#: product's structure is its own by construction (and the clip is DEMO_ONLY)
STRUCTURE_OK = ("VERIFIED_MANUFACTURER", "TECHNICAL_RECONSTRUCTION", "FICTIONAL_DEMO")

#: render quality profiles: (resolution scale, samples, adaptive threshold, max bounces, frame step)
QUALITY = {
    "preview": {"scale": 0.5, "samples": 24, "threshold": 0.05, "bounces": 6, "denoise": True},
    "production": {"scale": 1.0, "samples": 96, "threshold": 0.012, "bounces": 10, "denoise": True},
}

HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
NAME = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$")


class SceneJobError(ValueError):
    """The job is invalid (exit code 3): nothing was rendered."""


@dataclass(frozen=True)
class ActionSpec:
    kind: str
    start: float
    end: float


def _req(d: dict, key: str, kind, where: str):
    if key not in d:
        raise SceneJobError(f"{where}.{key} is required")
    v = d[key]
    if kind is float:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise SceneJobError(f"{where}.{key} must be a number")
        return float(v)
    if kind is int:
        if isinstance(v, bool) or not isinstance(v, int):
            raise SceneJobError(f"{where}.{key} must be an integer")
        return v
    if not isinstance(v, kind):
        raise SceneJobError(f"{where}.{key} must be {kind.__name__}")
    return v


def _enum(v, allowed, where: str) -> str:
    if v not in allowed:
        raise SceneJobError(f"{where}={v!r} is not one of {', '.join(allowed)}")
    return v


def _range(v: float, lo: float, hi: float, where: str) -> float:
    if not (lo <= v <= hi):
        raise SceneJobError(f"{where}={v} outside [{lo}, {hi}]")
    return v


def _abs_path(p, where: str) -> str:
    if not isinstance(p, str) or not p or "\0" in p or not os.path.isabs(p):
        raise SceneJobError(f"{where} must be an absolute path")
    return os.path.normpath(p)


def inside(child: str, root: str) -> bool:
    child, root = os.path.normcase(os.path.abspath(child)), os.path.normcase(os.path.abspath(root))
    return child == root or child.startswith(root.rstrip(os.sep) + os.sep)


def validate(job: dict) -> dict:
    """Validated, normalised copy of a scene job (raises SceneJobError)."""
    if not isinstance(job, dict):
        raise SceneJobError("job must be an object")
    if job.get("version") != SCENE_SPEC_VERSION:
        raise SceneJobError(f"job.version must be {SCENE_SPEC_VERSION}")
    out: dict = {"version": SCENE_SPEC_VERSION}
    jid = _req(job, "jobId", str, "job")
    if not JOB_ID.match(jid) or ".." in jid:
        raise SceneJobError("job.jobId has invalid characters")
    out["jobId"] = jid
    out["template"] = _enum(job.get("template"), TEMPLATES, "job.template")
    out["quality"] = _enum(job.get("quality", "preview"), QUALITIES, "job.quality")
    out["device"] = _enum(job.get("device", "AUTO"), DEVICES, "job.device")
    out["renderer"] = _enum(job.get("renderer", "CYCLES"), RENDERERS, "job.renderer")
    out["turns"] = _range(float(job.get("turns", 1.0)), 0.1, 4.0, "job.turns")
    fr = job.get("framing", {}) or {}
    if not isinstance(fr, dict):
        raise SceneJobError("job.framing must be an object")
    out["framing"] = {"centerY": _range(float(fr.get("centerY", 0.5)), 0.3, 0.7, "job.framing.centerY"),
                      "fill": None if fr.get("fill") is None else _range(float(fr["fill"]), 0.25, 0.9,
                                                                            "job.framing.fill")}
    out["durationSec"] = _range(_req(job, "durationSec", float, "job"), 0.5, 20.0, "job.durationSec")
    fps = _req(job, "fps", int, "job")
    if fps not in (24, 25, 30, 50, 60):
        raise SceneJobError("job.fps must be 24, 25, 30, 50 or 60")
    out["fps"] = fps
    res = job.get("resolution")
    if (not isinstance(res, list) or len(res) != 2 or any(isinstance(x, bool) or not isinstance(x, int) for x in res)):
        raise SceneJobError("job.resolution must be [width, height]")
    w, h = res
    if not (128 <= w <= 4096 and 128 <= h <= 4096) or w % 2 or h % 2:
        raise SceneJobError("job.resolution: 128–4096 px, even numbers")
    out["resolution"] = [w, h]
    out["seed"] = _range(float(job.get("seed", 1)), 0, 2**31 - 1, "job.seed")
    out["seed"] = int(out["seed"])
    threads = job.get("threads", 0)
    if isinstance(threads, bool) or not isinstance(threads, int) or not (0 <= threads <= 256):
        raise SceneJobError("job.threads must be an integer 0–256")
    out["threads"] = threads
    samples = job.get("samples")
    if samples is not None:
        if isinstance(samples, bool) or not isinstance(samples, int) or not (1 <= samples <= 4096):
            raise SceneJobError("job.samples must be an integer 1–4096")
    out["samples"] = samples

    cam = _req(job, "camera", dict, "job")
    out["camera"] = {
        "preset": _enum(cam.get("preset"), CAMERA_PRESETS, "job.camera.preset"),
        "movement": _enum(cam.get("movement", "slow"), tuple(MOVEMENTS), "job.camera.movement"),
    }
    light = _req(job, "lighting", dict, "job")
    out["lighting"] = {"preset": _enum(light.get("preset"), tuple(LIGHTING), "job.lighting.preset")}
    bg = _req(job, "background", dict, "job")
    background = {"preset": _enum(bg.get("preset"), tuple(BACKGROUNDS), "job.background.preset")}
    for key in ("color", "accent"):
        if bg.get(key) is not None:
            if not isinstance(bg[key], str) or not HEX.match(bg[key]):
                raise SceneJobError(f"job.background.{key} must be #RRGGBB")
            background[key] = bg[key]
    out["background"] = background
    env = job.get("environment")
    out["environment"] = None
    if env is not None:
        if not isinstance(env, dict):
            raise SceneJobError("job.environment must be an object")
        out["environment"] = {"preset": _enum(env.get("preset"), ENVIRONMENTS, "job.environment.preset")}
    if out["template"] == "LIFESTYLE" and out["environment"] is None:
        raise SceneJobError("a LIFESTYLE scene needs job.environment.preset")
    if background["preset"] == "environment" and out["environment"] is None:
        raise SceneJobError("background 'environment' needs job.environment.preset")

    out["product"] = _product(_req(job, "product", dict, "job"))
    focus = job.get("focus")
    if focus is not None and (not isinstance(focus, str) or not NAME.match(focus)):
        raise SceneJobError("job.focus must be a part name")
    out["focus"] = focus
    actions = job.get("actions", [])
    if not isinstance(actions, list) or len(actions) > 8:
        raise SceneJobError("job.actions must be a list of at most 8 actions")
    parsed: list[ActionSpec] = []
    for k, a in enumerate(actions):
        where = f"job.actions[{k}]"
        if not isinstance(a, dict):
            raise SceneJobError(f"{where} must be an object")
        kind = _enum(a.get("kind"), ACTIONS, f"{where}.kind")
        start = _range(_req(a, "startSec", float, where), 0.0, out["durationSec"], f"{where}.startSec")
        end = _range(_req(a, "endSec", float, where), start, out["durationSec"], f"{where}.endSec")
        parsed.append(ActionSpec(kind, start, end))
    out["actions"] = parsed
    if out["template"] in STRUCTURAL_TEMPLATES and not out["product"]["structureVerified"]:
        raise SceneJobError(
            f"{out['template']} shows the product's construction: this model's part structure is not verified"
        )
    if out["template"] in STRUCTURAL_TEMPLATES and out["product"]["fidelity"] not in STRUCTURE_OK:
        raise SceneJobError(
            f"{out['template']} shows the product's construction: it needs a verified part structure "
            f"(fidelity {', '.join(STRUCTURE_OK)}), not {out['product']['fidelity']}"
        )

    outputs = job.get("outputs", {})
    if not isinstance(outputs, dict):
        raise SceneJobError("job.outputs must be an object")
    exports = outputs.get("export", [])
    if not isinstance(exports, list) or any(e not in EXPORT_FORMATS for e in exports):
        raise SceneJobError(f"job.outputs.export: subset of {', '.join(EXPORT_FORMATS)}")
    out["outputs"] = {
        "frames": bool(outputs.get("frames", True)),
        "alpha": bool(outputs.get("alpha", False)) or background["preset"] == "transparent",
        "controlViews": bool(outputs.get("controlViews", False)),
        "blend": bool(outputs.get("blend", False)),
        "export": sorted(set(exports)),
    }
    o = _req(job, "output", dict, "job")
    out["output"] = {"dir": _abs_path(o.get("dir"), "job.output.dir")}
    return out


def _product(p: dict) -> dict:
    src = _enum(p.get("source"), PRODUCT_SOURCES, "job.product.source")
    out: dict = {"source": src, "fidelity": _enum(p.get("fidelity"), FIDELITY, "job.product.fidelity")}
    asset = p.get("assetId", "")
    if not isinstance(asset, str) or (asset and not JOB_ID.match(asset)):
        raise SceneJobError("job.product.assetId has invalid characters")
    out["assetId"] = asset
    # a procedural demo model's parts are its own by construction; an imported model's are verified only when the
    # library record says so (manufacturer CAD with named parts, reviewed by the owner)
    out["structureVerified"] = bool(p.get("structureVerified", src == "procedural"))
    if src == "procedural":
        gen = p.get("generator")
        if not isinstance(gen, str) or not NAME.match(gen):
            raise SceneJobError("job.product.generator must be a generator name")
        out["generator"] = gen
        params = p.get("params", {})
        if not isinstance(params, dict) or len(params) > 32:
            raise SceneJobError("job.product.params must be an object (≤ 32 keys)")
        clean = {}
        for k, v in params.items():
            if not isinstance(k, str) or not NAME.match(k):
                raise SceneJobError(f"job.product.params key {k!r} invalid")
            if isinstance(v, bool) or isinstance(v, (int, float)):
                if isinstance(v, float) and not math.isfinite(v):
                    raise SceneJobError(f"job.product.params.{k} must be finite")
                clean[k] = v
            elif isinstance(v, str) and (HEX.match(v) or NAME.match(v)):
                clean[k] = v
            else:
                raise SceneJobError(f"job.product.params.{k}: number, boolean, #RRGGBB or a name")
        out["params"] = clean
        if out["fidelity"] != "FICTIONAL_DEMO":
            raise SceneJobError("a procedural product is a fictional demo model (fidelity FICTIONAL_DEMO)")
    else:
        out["path"] = _abs_path(p.get("path"), "job.product.path")
        out["format"] = _enum(p.get("format"), MODEL_FORMATS, "job.product.format")
        h = p.get("realHeightM")
        if h is not None:
            h = _range(float(h), 0.005, 5.0, "job.product.realHeightM")
        out["realHeightM"] = h
        out["emitsLight"] = bool(p.get("emitsLight", False))
        hints = p.get("hints", [])
        if not isinstance(hints, list) or any(not isinstance(x, str) or not NAME.match(x) for x in hints):
            raise SceneJobError("job.product.hints must be part-name words")
        out["hints"] = hints[:16]
    return out


def frame_count(duration_sec: float, fps: int) -> int:
    """Frames of a clip: ⌈duration·fps⌉ (at least 2)."""
    return max(2, int(math.ceil(duration_sec * fps - 1e-9)))


def render_size(job: dict) -> tuple[int, int]:
    """Output pixel size for the job's quality (preview renders at half size, even numbers)."""
    s = QUALITY[job["quality"]]["scale"]
    w, h = job["resolution"]
    return max(128, int(round(w * s / 2)) * 2), max(128, int(round(h * s / 2)) * 2)


def smoothstep(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


def ease_in_out(t: float) -> float:
    """Cubic ease (camera / part moves)."""
    t = max(0.0, min(1.0, t))
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def action_progress(action: ActionSpec, t: float) -> float:
    """0 before, 1 after, eased in between (an action of zero length is a step)."""
    if action.end <= action.start:
        return 1.0 if t >= action.start else 0.0
    return ease_in_out((t - action.start) / (action.end - action.start))


def explode_progress(t: float) -> float:
    """Exploded view over the clip: assembled → exploded (0.15–0.45) → hold → reassembled (0.7–0.95)."""
    if t < 0.15:
        return 0.0
    if t < 0.45:
        return ease_in_out((t - 0.15) / 0.30)
    if t < 0.7:
        return 1.0
    if t < 0.95:
        return 1.0 - ease_in_out((t - 0.7) / 0.25)
    return 0.0


def assembly_progress(t: float, order: int, count: int) -> float:
    """Assembly: part `order` (0 = base, already placed) flies in during its own window of the clip."""
    if order == 0 or count <= 1:
        return 1.0
    span = 0.75 / max(1, count - 1)
    start = 0.08 + (order - 1) * span
    return ease_in_out((t - start) / (span * 1.35))
