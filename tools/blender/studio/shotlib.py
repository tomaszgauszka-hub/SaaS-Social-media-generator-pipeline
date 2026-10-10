"""Shot library — deterministic keyframe math for the 21 SHOT_PRESETS (pure python, no bpy).

Every preset is a function of normalised time t in [0, 1] and the bounded ShotParams of the plan
(intensity, angleDeg, height, focus, fill, sweepDeg). It returns a ShotState: camera offsets relative to the
COMPOSED camera (the framing the plan asked for), the product's rigid transform, light levels and part
separation. bpy code (studio_main.py) turns a state into object transforms; nothing here touches Blender, so the
whole library is unit-tested with python3 -m unittest.

Rules that keep the product accurate: the product only ever gets rigid motion (rotation about its vertical axis,
lift) — never a non-uniform scale or a deformation; multi-part moves translate whole parts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

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

PRODUCT_ANIMATIONS = ("none", "rotate", "float", "drop", "explode", "assemble", "light_on", "spin_part")
FOCI = ("whole", "top", "middle", "base", "detail")

# ------------------------------------------------------------------------------------------- easing ----


def clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def smoothstep(e0: float, e1: float, x: float) -> float:
    t = clamp01((x - e0) / (e1 - e0)) if e1 != e0 else (1.0 if x >= e1 else 0.0)
    return t * t * (3.0 - 2.0 * t)


def ease_in_out_sine(t: float) -> float:
    return 0.5 - 0.5 * math.cos(math.pi * clamp01(t))


def ease_out_cubic(t: float) -> float:
    return 1.0 - (1.0 - clamp01(t)) ** 3


def ease_out_back(t: float, overshoot: float = 1.4) -> float:
    """0 → 1 with a small overshoot past 1 (camera punch-in)."""
    t = clamp01(t) - 1.0
    return 1.0 + t * t * ((overshoot + 1.0) * t + overshoot)


def ease_out_bounce(t: float, bounce: float = 0.12) -> float:
    """Fall (quadratic, like gravity) to 1 at 70 %, then one small rebound of height `bounce`."""
    t = clamp01(t)
    if t < 0.7:
        return (t / 0.7) ** 2
    u = (t - 0.7) / 0.3
    return 1.0 - bounce * 4.0 * u * (1.0 - u)


# ------------------------------------------------------------------------------------------- params ----

DEFAULT_PARAMS = {
    "intensity": 0.5,
    "angleDeg": -25.0,
    "height": 0.55,
    "focus": "whole",
    "fill": 0.62,
    "sweepDeg": 40.0,
}


def with_defaults(params: dict | None) -> dict:
    out = dict(DEFAULT_PARAMS)
    out.update({k: v for k, v in (params or {}).items() if v is not None})
    return out


# ------------------------------------------------------------------------------------------- presets ---


@dataclass(frozen=True)
class PresetSpec:
    #: needs a model made of several mesh objects
    multi_part: bool = False
    #: nearest feasible preset when the model has a single mesh
    fallback: str | None = None
    #: vertical placement of the product centre in the composed frame (0 top … 1 bottom)
    center_y: float = 0.5
    #: close-up presets frame the detail band when the plan left the focus on "whole"
    detail_when_whole: bool = False
    #: composed camera elevation (deg) overriding params.height, as a function of intensity
    elevation: tuple[float, float] | None = None
    #: params.height is capped (low camera)
    max_height: float | None = None
    #: t at which a still plate is taken (the preset's resting pose)
    plate_t: float = 0.5
    #: the preset itself animates these channels (product animations do not stack on them)
    rotates_product: bool = False
    lifts_product: bool = False


PRESETS: dict[str, PresetSpec] = {
    "hero_reveal": PresetSpec(center_y=0.52, plate_t=1.0),
    "turntable": PresetSpec(rotates_product=True),
    "slow_turntable": PresetSpec(rotates_product=True),
    "orbit": PresetSpec(),
    "macro_push": PresetSpec(detail_when_whole=True, plate_t=1.0),
    "macro_pull": PresetSpec(detail_when_whole=True, plate_t=0.0),
    "camera_slide": PresetSpec(),
    "top_down": PresetSpec(elevation=(50.0, 75.0)),
    "low_angle": PresetSpec(max_height=0.06, center_y=0.47),
    "floating_product": PresetSpec(lifts_product=True, rotates_product=True, plate_t=0.25),
    "light_sweep": PresetSpec(),
    "silhouette_reveal": PresetSpec(plate_t=1.0),
    "exploded_view": PresetSpec(multi_part=True, fallback="orbit", plate_t=1.0),
    "parts_reveal": PresetSpec(multi_part=True, fallback="feature_highlight", plate_t=1.0),
    "assembly": PresetSpec(multi_part=True, fallback="hero_reveal", plate_t=1.0),
    "feature_highlight": PresetSpec(plate_t=1.0),
    "detail_closeup": PresetSpec(detail_when_whole=True),
    "impact": PresetSpec(plate_t=1.0),
    "product_drop": PresetSpec(lifts_product=True, rotates_product=True, plate_t=1.0),
    "technical_cutaway": PresetSpec(multi_part=True, fallback="macro_push", plate_t=1.0),
    "cta_hero": PresetSpec(center_y=0.56, rotates_product=True),
}

assert tuple(PRESETS) == SHOT_PRESETS


def resolve_preset(preset: str, part_count: int) -> tuple[str, str | None]:
    """(preset to render, fallbackPreset or None). Multi-part presets degrade on single-mesh models."""
    if preset not in PRESETS:
        raise ValueError(f"unknown preset {preset!r}")
    spec = PRESETS[preset]
    if spec.multi_part and part_count < 2 and spec.fallback:
        return spec.fallback, spec.fallback
    return preset, None


@dataclass(frozen=True)
class Composition:
    """The composed (hero) framing of a shot — what the camera fit solves for."""

    focus: str
    fill: float
    center_y: float
    #: relative camera height (params.height) or None when `elevation_deg` is fixed
    height: float | None
    elevation_deg: float | None


def composition(preset: str, params: dict) -> Composition:
    p = with_defaults(params)
    spec = PRESETS[preset]
    focus = p["focus"]
    if spec.detail_when_whole and focus == "whole":
        focus = "detail"
    # a plan may move the product down to make room for a text panel above it (params.centerY)
    center_y = float(p["centerY"]) if p.get("centerY") is not None else spec.center_y
    if spec.elevation is not None:
        lo, hi = spec.elevation
        return Composition(focus, p["fill"], center_y, None, lerp(lo, hi, p["intensity"]))
    height = p["height"] if spec.max_height is None else min(p["height"], spec.max_height)
    return Composition(focus, p["fill"], center_y, height, None)


def focus_band(focus: str) -> tuple[float, float]:
    """Height band (share of the product height) each focus frames."""
    return {
        "whole": (0.0, 1.0),
        "top": (0.62, 1.0),
        "middle": (0.3, 0.7),
        "base": (0.0, 0.38),
        "detail": (0.04, 0.3),
    }[focus]


def refine_band(
    z0: float, z1: float, widths: list[float], min_share: float = 0.3, min_height: float = 0.08
) -> tuple[float, float, str | None]:
    """A close-up of a part much narrower than the product (a thin lamp rod) is an abstract blur, not a detail.
    `widths` = the product's horizontal extent in equal height slices (bottom → top). When the requested band is
    mostly thin, the close-up moves to the nearest run of wide slices (a lamp's base → its marble cube, not the
    rod above it). Returns (z0, z1, note) as shares of the product height."""
    n = len(widths)
    wide = min_share * max(widths, default=0.0)
    if n == 0 or wide <= 0:
        return z0, z1, None
    inside = [w for k, w in enumerate(widths) if z0 <= (k + 0.5) / n <= z1] or [0.0]
    if sorted(inside)[len(inside) // 2] >= wide:
        return z0, z1, None
    runs, start = [], None
    for k, w in enumerate([*widths, 0.0]):
        if w >= wide and start is None:
            start = k
        elif w < wide and start is not None:
            runs.append((start / n, k / n))
            start = None
    if not runs:
        return z0, z1, None
    mid = (z0 + z1) / 2
    r0, r1 = min(runs, key=lambda r: abs((r[0] + r[1]) / 2 - mid))
    if r1 - r0 < min_height:
        c = (r0 + r1) / 2
        r0, r1 = max(0.0, c - min_height / 2), min(1.0, c + min_height / 2)
    return r0, r1, f"close-up of a thin band ({z0:.2f}-{z1:.2f} of the height) framed on {r0:.2f}-{r1:.2f}"


@dataclass(frozen=True)
class ShotState:
    # camera, relative to the composed camera
    cam_az: float = 0.0  # deg orbit around the focus target
    cam_el: float = 0.0  # deg added to the composed elevation
    cam_dolly: float = 1.0  # x composed distance (> 1 = farther)
    cam_truck: float = 0.0  # sideways camera + target move, in frame heights (+ = right)
    cam_pedestal: float = 0.0  # vertical camera + target move, in frame heights (+ = up)
    # product (rigid)
    prod_rot: float = 0.0  # deg about Z, added to the shot angle
    prod_lift: float = 0.0  # x product height above its rest
    # lights (multipliers of the preset's levels)
    key: float = 1.0
    fill: float = 1.0
    rim: float = 1.0
    accent: float = 0.0
    sweep: float | None = None  # -1 … 1 position of the moving strip light
    product_light: float = 0.0  # 0 … 1 light inside a light-emitting product
    # parts (multi-part models)
    explode: float = 0.0
    stagger: bool = False
    cutaway: float = 0.0
    spin_part: float = 0.0  # deg of the smallest part about its own axis


def _preset_state(preset: str, t: float, p: dict) -> ShotState:
    i = float(p["intensity"])
    sweep = float(p["sweepDeg"])
    e = ease_in_out_sine(t)
    if preset == "hero_reveal":
        level = lerp(0.35, 1.0, smoothstep(0.0, 0.6, t))
        return ShotState(
            cam_az=-14.0 * i * (1.0 - e),
            cam_dolly=1.0 + (0.08 + 0.22 * i) * (1.0 - ease_out_cubic(t)),
            key=level,
            fill=level,
        )
    if preset == "turntable":
        return ShotState(prod_rot=sweep * (t - 0.5))
    if preset == "slow_turntable":
        return ShotState(prod_rot=0.5 * sweep * (t - 0.5), cam_dolly=1.02 - 0.04 * t)
    if preset == "orbit":
        return ShotState(cam_az=sweep * (e - 0.5), cam_el=4.0 * i * (e - 0.5))
    if preset == "macro_push":
        return ShotState(cam_dolly=1.0 + (0.12 + 0.3 * i) * (1.0 - e))
    if preset == "macro_pull":
        return ShotState(cam_dolly=1.0 + (0.12 + 0.3 * i) * e)
    if preset == "camera_slide":
        side = 1.0 if float(p["angleDeg"]) <= 0 else -1.0
        return ShotState(cam_truck=side * (0.05 + 0.11 * i) * (2.0 * e - 1.0))
    if preset == "top_down":
        return ShotState(cam_az=0.5 * sweep * (e - 0.5))
    if preset == "low_angle":
        return ShotState(cam_dolly=1.08 - 0.08 * e, cam_pedestal=0.02 * (e - 0.5))
    if preset == "floating_product":
        wave = math.sin(2.0 * math.pi * t)
        return ShotState(prod_lift=0.07 + 0.025 * (0.5 + i) * wave, prod_rot=5.0 * (0.5 + i) * wave)
    if preset == "light_sweep":
        return ShotState(sweep=2.0 * e - 1.0, key=0.55, fill=0.6, rim=0.8, cam_dolly=1.03 - 0.03 * e)
    if preset == "silhouette_reveal":
        level = smoothstep(0.2, 0.8, t)
        return ShotState(key=level, fill=level, rim=1.25, cam_dolly=1.05 - 0.05 * e)
    if preset == "exploded_view":
        return ShotState(explode=e * (0.5 + 0.5 * i), cam_az=10.0 * (e - 0.5))
    if preset == "parts_reveal":
        return ShotState(explode=e * (0.5 + 0.5 * i), stagger=True)
    if preset == "assembly":
        return ShotState(explode=(1.0 - e) * (0.5 + 0.5 * i))
    if preset == "feature_highlight":
        return ShotState(
            cam_dolly=1.0 + (0.08 + 0.15 * i) * (1.0 - e), accent=smoothstep(0.05, 0.5, t), key=0.8, fill=0.8
        )
    if preset == "detail_closeup":
        return ShotState(cam_az=(6.0 + 6.0 * i) * (e - 0.5), cam_dolly=1.04 - 0.04 * e)
    if preset == "impact":
        k = ease_out_back(t / 0.28) if t < 0.28 else 1.0
        drift = 0.0 if t < 0.28 else 0.02 * (t - 0.28) / 0.72
        return ShotState(cam_dolly=1.0 + (0.15 + 0.25 * i) * (1.0 - k) - drift)
    if preset == "product_drop":
        fall = ease_out_bounce(t / 0.5)
        return ShotState(prod_lift=0.55 * (1.0 - fall), prod_rot=-10.0 * i * (1.0 - ease_out_cubic(t / 0.6)))
    if preset == "technical_cutaway":
        return ShotState(cutaway=smoothstep(0.1, 0.7, t))
    if preset == "cta_hero":
        return ShotState(cam_dolly=1.05 - 0.05 * e, prod_rot=0.25 * sweep * (t - 0.5), rim=1.1)
    raise ValueError(f"unknown preset {preset!r}")


def light_switch(t: float) -> float:
    """A product light switching on: off until 30 %, on by 42 % (a short LED-like ramp).

    Must equal LIGHT_SWITCH in packages/reel/src/contracts/media.ts (the clip cross-fade and the click SFX)."""
    return smoothstep(0.3, 0.42, t)


def evaluate(
    preset: str,
    t: float,
    params: dict | None = None,
    animation: str = "none",
    *,
    part_count: int = 1,
    emits_light: bool = False,
    lighting: str = "three_point",
) -> tuple[ShotState, dict]:
    """State of a shot at t, plus notes ({"fallbackPreset", "animationFallback"} when degraded).
    `preset` must already be resolved with resolve_preset (multi-part presets on single meshes)."""
    if animation not in PRODUCT_ANIMATIONS:
        raise ValueError(f"unknown product animation {animation!r}")
    p = with_defaults(params)
    t = clamp01(t)
    spec = PRESETS[preset]
    s = _preset_state(preset, t, p)
    notes: dict = {}
    sweep = float(p["sweepDeg"])
    multi = part_count >= 2
    if animation == "rotate" and not spec.rotates_product:
        s = replace(s, prod_rot=s.prod_rot + 0.5 * sweep * (t - 0.5))
    elif animation == "float" and not spec.lifts_product:
        s = replace(s, prod_lift=0.07 + 0.025 * math.sin(2.0 * math.pi * t))
    elif animation == "drop" and not spec.lifts_product:
        s = replace(s, prod_lift=0.55 * (1.0 - ease_out_bounce(t / 0.5)))
    elif animation in ("explode", "assemble"):
        if multi:
            e = ease_in_out_sine(t)
            s = replace(s, explode=e if animation == "explode" else 1.0 - e)
        else:
            notes["animationFallback"] = "none"
    elif animation == "spin_part":
        if multi:
            s = replace(s, spin_part=sweep * (t - 0.5) * 2.0)
        else:
            notes["animationFallback"] = "rotate"
            if not spec.rotates_product:
                s = replace(s, prod_rot=s.prod_rot + 0.5 * sweep * (t - 0.5))
    if emits_light:
        if animation == "light_on":
            s = replace(s, product_light=light_switch(t))
        elif lighting == "warm_practical":
            s = replace(s, product_light=1.0)
    elif animation == "light_on":
        notes["animationFallback"] = "none"
    return s, notes


def plate_state(
    preset: str,
    params: dict | None = None,
    animation: str = "none",
    *,
    part_count: int = 1,
    emits_light: bool = False,
    lighting: str = "three_point",
) -> tuple[ShotState, dict]:
    """The still a plate is rendered from: the preset's resting pose with the camera exactly at the composed
    framing (the move itself is done in FFmpeg) and the lights fully up."""
    spec = PRESETS[preset]
    s, notes = evaluate(
        preset, spec.plate_t, params, animation, part_count=part_count, emits_light=emits_light, lighting=lighting
    )
    s = replace(
        s,
        cam_az=0.0,
        cam_el=0.0,
        cam_dolly=1.0,
        cam_truck=0.0,
        cam_pedestal=0.0,
        key=max(s.key, 1.0) if preset != "light_sweep" else s.key,
        fill=max(s.fill, 1.0) if preset != "light_sweep" else s.fill,
        sweep=0.0 if s.sweep is not None else None,
        accent=1.0 if preset == "feature_highlight" else s.accent,
    )
    if animation == "light_on" and emits_light:
        s = replace(s, product_light=1.0)
    return s, notes


# ------------------------------------------------------------------------------------------- timing ----


def sequence_frame_count(duration_ms: int, render_fps: int) -> int:
    """Frames rendered at k / render_fps for k = 0 … n-1, covering the whole shot (last frame >= duration)."""
    return max(2, math.ceil(duration_ms * render_fps / 1000.0 - 1e-9) + 1)


def sequence_times(duration_ms: int, render_fps: int) -> list[float]:
    """Normalised shot time of every rendered frame (clamped to 1 past the end)."""
    n = sequence_frame_count(duration_ms, render_fps)
    return [clamp01((k * 1000.0 / render_fps) / duration_ms) for k in range(n)]


# ------------------------------------------------------------------------------------------- parts -----


def part_offsets(
    centres: list[tuple[float, float, float]],
    product_centre: tuple[float, float, float],
    size: float,
    explode: float,
    stagger: bool = False,
    cutaway: float = 0.0,
    volumes: list[float] | None = None,
) -> list[tuple[float, float, float]]:
    """Translation of each part: exploded outward from the product centre (staggered by distance for
    parts_reveal); a cutaway lifts the largest part straight up."""
    n = len(centres)
    out: list[tuple[float, float, float]] = []
    dists = [math.dist(c, product_centre) for c in centres]
    order = sorted(range(n), key=lambda k: dists[k])
    rank = {k: r for r, k in enumerate(order)}
    largest = max(range(n), key=lambda k: (volumes or [0.0] * n)[k]) if n else -1
    for k, c in enumerate(centres):
        d = (c[0] - product_centre[0], c[1] - product_centre[1], c[2] - product_centre[2])
        norm = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
        unit = (0.0, 0.0, 1.0) if norm < 1e-6 * max(size, 1e-6) else (d[0] / norm, d[1] / norm, d[2] / norm)
        amount = explode
        if stagger and n > 1:
            start = 0.5 * rank[k] / (n - 1)
            amount = clamp01((explode - start) / (1.0 - start)) if explode > start else 0.0
        mag = 0.35 * size * amount
        off = (unit[0] * mag, unit[1] * mag, unit[2] * mag)
        if cutaway > 0 and k == largest:
            off = (off[0], off[1], off[2] + 0.6 * size * cutaway)
        out.append(off)
    return out
