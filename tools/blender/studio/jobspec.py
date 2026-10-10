"""StudioJob validation — a strict mirror of packages/reel/src/contracts/media.ts (StudioJob / StudioShotSpec)
and plan.ts (ShotParams). Pure python, no bpy.

The job is written by the TypeScript bridge (never by a model), but Blender still trusts nothing: every key is
checked against a closed set (unknown keys are rejected, not ignored), every id against its whitelist, every
number against its bounds. Defaults are applied exactly where zod applies them.
"""

from __future__ import annotations

import json
import math
import os
import re

STUDIO_JOB_VERSION = "studio-job/1"

SHOT_PRESETS = (
    "hero_reveal",
    "turntable",
    "slow_turntable",
    "orbit",
    "macro_push",
    "macro_pull",
    "camera_slide",
    "top_down",
    "low_angle",
    "floating_product",
    "light_sweep",
    "silhouette_reveal",
    "exploded_view",
    "parts_reveal",
    "assembly",
    "feature_highlight",
    "detail_closeup",
    "impact",
    "product_drop",
    "technical_cutaway",
    "cta_hero",
)
TECHNIQUES = ("plate", "sequence", "relight")
ENVIRONMENTS = ("dark_premium", "warm_living", "bright_minimal", "industrial", "natural_daylight", "soft_pastel")
LIGHTING_PRESETS = ("three_point", "rim_dramatic", "soft_box", "window_daylight", "warm_practical", "top_spot")
PRODUCT_ANIMATIONS = ("none", "rotate", "float", "drop", "explode", "assemble", "light_on", "spin_part")
FOCI = ("whole", "top", "middle", "base", "detail")
PROFILES = ("FAST", "QUALITY")
FORMATS = ("glb", "gltf", "obj", "fbx", "usd", "blend")

SHOT_ID = re.compile(r"sh[0-9]{2}")


class JobError(ValueError):
    """The job JSON does not match the StudioJob contract."""


def _fail(path: str, msg: str) -> None:
    raise JobError(f"{path}: {msg}")


def _obj(v, path: str, required: set[str], optional: set[str] = frozenset()) -> dict:
    if not isinstance(v, dict):
        _fail(path, "expected an object")
    unknown = set(v) - required - optional
    if unknown:
        _fail(path, f"unknown key(s) {sorted(unknown)}")
    missing = required - set(v)
    if missing:
        _fail(path, f"missing key(s) {sorted(missing)}")
    return v


def _num(v, path: str, lo: float | None = None, hi: float | None = None, *, integer: bool = False,
         positive: bool = False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        _fail(path, "expected a finite number")
    if integer and float(v) != math.floor(v):
        _fail(path, "expected an integer")
    if positive and v <= 0:
        _fail(path, "expected a positive number")
    if lo is not None and v < lo:
        _fail(path, f"must be >= {lo}")
    if hi is not None and v > hi:
        _fail(path, f"must be <= {hi}")
    return int(v) if integer else float(v)


def _str(v, path: str, max_len: int | None = None) -> str:
    if not isinstance(v, str):
        _fail(path, "expected a string")
    if "\x00" in v:
        _fail(path, "NUL byte in string")
    if max_len is not None and len(v) > max_len:
        _fail(path, f"longer than {max_len} characters")
    return v


def _enum(v, path: str, options: tuple[str, ...]) -> str:
    if v not in options:
        _fail(path, f"expected one of {list(options)}")
    return v


def _bool(v, path: str) -> bool:
    if not isinstance(v, bool):
        _fail(path, "expected a boolean")
    return v


def validate_params(v, path: str) -> dict:
    keys = {"intensity", "angleDeg", "height", "focus", "fill", "sweepDeg"}
    _obj(v, path, set(), keys)
    return {
        "intensity": _num(v.get("intensity", 0.5), f"{path}.intensity", 0, 1),
        "angleDeg": _num(v.get("angleDeg", -25), f"{path}.angleDeg", -180, 180),
        "height": _num(v.get("height", 0.55), f"{path}.height", -0.2, 1.6),
        "focus": _enum(v.get("focus", "whole"), f"{path}.focus", FOCI),
        "fill": _num(v.get("fill", 0.62), f"{path}.fill", 0.25, 2.5),
        "sweepDeg": _num(v.get("sweepDeg", 40), f"{path}.sweepDeg", 0, 360),
    }


def validate_shot(v, path: str) -> dict:
    keys = {"id", "preset", "technique", "durationMs", "params", "productAnimation", "lighting", "renderFps",
            "overscan"}
    _obj(v, path, keys, {"travelX"})
    sid = _str(v["id"], f"{path}.id")
    if not SHOT_ID.fullmatch(sid):
        _fail(f"{path}.id", "expected sh + two digits")
    extra = {"travelX": _num(v["travelX"], f"{path}.travelX", 0, 0.5)} if "travelX" in v else {}
    return {
        "id": sid,
        "preset": _enum(v["preset"], f"{path}.preset", SHOT_PRESETS),
        "technique": _enum(v["technique"], f"{path}.technique", TECHNIQUES),
        "durationMs": _num(v["durationMs"], f"{path}.durationMs", 300, 10_000, integer=True),
        "params": validate_params(v["params"], f"{path}.params"),
        "productAnimation": _enum(v["productAnimation"], f"{path}.productAnimation", PRODUCT_ANIMATIONS),
        "lighting": _enum(v["lighting"], f"{path}.lighting", LIGHTING_PRESETS),
        "renderFps": _num(v["renderFps"], f"{path}.renderFps", 6, 60, integer=True),
        "overscan": _num(v["overscan"], f"{path}.overscan", 1, 1.6),
        **extra,
    }


def validate_job(raw) -> dict:
    """Validated, normalised copy of a StudioJob (defaults applied). Raises JobError."""
    _obj(raw, "job", {"version", "jobKey", "product", "environment", "profile", "output", "camera", "shots",
                      "seed"})
    if raw["version"] != STUDIO_JOB_VERSION:
        _fail("job.version", f"expected {STUDIO_JOB_VERSION!r}")
    p = _obj(raw["product"], "job.product", {"modelPath", "modelSha", "format", "emitsLight"},
             {"realHeightM", "emissiveHints"})
    hints = p.get("emissiveHints", [])
    if not isinstance(hints, list) or len(hints) > 12:
        _fail("job.product.emissiveHints", "expected at most 12 strings")
    product = {
        "modelPath": _str(p["modelPath"], "job.product.modelPath"),
        "modelSha": _str(p["modelSha"], "job.product.modelSha"),
        "format": _enum(p["format"], "job.product.format", FORMATS),
        "emitsLight": _bool(p["emitsLight"], "job.product.emitsLight"),
        "emissiveHints": [_str(h, f"job.product.emissiveHints[{k}]", 40) for k, h in enumerate(hints)],
    }
    if "realHeightM" in p:
        product["realHeightM"] = _num(p["realHeightM"], "job.product.realHeightM", positive=True)
    o = _obj(raw["output"], "job.output", {"dir", "width", "height"})
    c = _obj(raw["camera"], "job.camera", {"lensMm", "dof", "motionBlur"})
    dof = _obj(c["dof"], "job.camera.dof", {"enabled", "fStop"})
    shots = raw["shots"]
    if not isinstance(shots, list) or not 1 <= len(shots) <= 8:
        _fail("job.shots", "expected 1 to 8 shots")
    job = {
        "version": STUDIO_JOB_VERSION,
        "jobKey": _str(raw["jobKey"], "job.jobKey"),
        "product": product,
        "environment": _enum(raw["environment"], "job.environment", ENVIRONMENTS),
        "profile": _enum(raw["profile"], "job.profile", PROFILES),
        "output": {
            "dir": _str(o["dir"], "job.output.dir"),
            "width": _num(o["width"], "job.output.width", 270, 2160, integer=True),
            "height": _num(o["height"], "job.output.height", 480, 3840, integer=True),
        },
        "camera": {
            "lensMm": _num(c["lensMm"], "job.camera.lensMm", 18, 200),
            "dof": {
                "enabled": _bool(dof["enabled"], "job.camera.dof.enabled"),
                "fStop": _num(dof["fStop"], "job.camera.dof.fStop", 0.95, 22),
            },
            "motionBlur": _bool(c["motionBlur"], "job.camera.motionBlur"),
        },
        "shots": [validate_shot(s, f"job.shots[{k}]") for k, s in enumerate(shots)],
        "seed": _num(raw["seed"], "job.seed", 0, 2**31 - 1, integer=True),
    }
    ids = [s["id"] for s in job["shots"]]
    if len(set(ids)) != len(ids):
        _fail("job.shots", "shot ids must be unique")
    return job


def _reject_constant(name: str):
    raise JobError(f"job: non-finite number {name} is not valid JSON")


def load_job(path: str) -> dict:
    """Read, parse and validate a job file; the model file must exist."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh, parse_constant=_reject_constant)
    job = validate_job(raw)
    model = job["product"]["modelPath"]
    if not os.path.isfile(model):
        _fail("job.product.modelPath", f"no such file {model!r}")
    return job


def load_profiles(path: str | None = None) -> dict:
    """Render settings per BlenderProfile (profiles.json, cross-checked against StudioProfileDefaults in TS)."""
    path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles.json")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)
