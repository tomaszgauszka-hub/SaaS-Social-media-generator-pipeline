"""The six Unreal template sets as pure descriptions (stdlib only — unit-tested without the editor).

A set description lists engine basic shapes (/Engine/BasicShapes: Cube, Cylinder, Sphere, Cone, Plane — all 100 cm,
pivot at the centre; the Plane is 100×100 cm facing +Z), their transforms and material values, the lights, the
fog, the post-process values and the camera aperture. ue_scene.py spawns exactly what a description says, tags every
actor R3D_SET and stores the description's key; a later job with the same key reuses the set, another product size,
lighting or background rebuilds it automatically — nobody edits an environment by hand to swap the product.

Conventions: centimetres, UE axes (X front of the product, Z up), the product's base on Z = 0 centred on XY, the
camera on the +X side (azimuth 0) or the −Y side (dolly_side). Studio sets scale with the product (unit u = the
product's largest dimension, clamped); interiors keep real-world furniture sizes and put a small product on a
support surface (table, workbench, podium) whose top is Z = 0 — a large product stands on the floor instead.

Light intensities derive from the set's manual exposure (EV100) so a set is balanced at any product size: a light
aimed at the product gets `lux × distance²` candela. The look values are a starting point that has NOT been tuned
against a real UE 5.8 render in this repository — tune them in the editor and carry the numbers back here.
"""

from __future__ import annotations

import hashlib
import json
import math

import ue_math

SET_VERSION = 1
MESHES = ("Cube", "Cylinder", "Sphere", "Cone", "Plane")
LIGHT_KINDS = ("rect", "spot", "point", "directional", "sky")
ROLES = ("key", "fill", "rim", "top", "background", "practical", "sun", "sky", "accent")

#: lighting preset → per-role intensity multipliers, colour temperature override (key/fill/rim/top), EV offset, fog
LIGHTING = {
    "premium_studio": {"mult": {}, "kelvin": None, "ev": 0.0, "fog": 1.0},
    "soft_daylight": {"mult": {"key": 0.85, "fill": 1.6, "rim": 0.6, "top": 1.2, "sky": 1.6, "sun": 0.8},
                      "kelvin": 5600.0, "ev": 0.0, "fog": 0.6},
    "dramatic_rim": {"mult": {"key": 0.55, "fill": 0.25, "rim": 1.9, "top": 0.5, "background": 0.6, "sky": 0.5},
                     "kelvin": None, "ev": -0.3, "fog": 1.3},
    "warm_home": {"mult": {"key": 0.9, "fill": 1.1, "rim": 0.6, "practical": 1.6}, "kelvin": 3400.0, "ev": 0.0,
                  "fog": 0.8},
    "cool_tech": {"mult": {"key": 0.9, "fill": 0.6, "rim": 1.5, "accent": 1.4}, "kelvin": 9000.0, "ev": 0.0,
                  "fog": 1.2},
    "workshop_practical": {"mult": {"fill": 0.8, "practical": 1.5}, "kelvin": 4200.0, "ev": 0.0, "fog": 1.2},
    "high_key": {"mult": {"key": 1.2, "fill": 1.9, "rim": 0.8, "top": 1.5, "background": 1.8, "sky": 1.8},
                 "kelvin": None, "ev": 0.4, "fog": 0.4},
}
#: studio backdrops: background preset → (wall, floor) colours
BACKDROPS = {
    "dark_gradient": ("#0d0d10", "#141417"),
    "light_gradient": ("#d6d7da", "#e7e8ea"),
    "seamless_white": ("#f3f3f3", "#f3f3f3"),
    "soft_pastel": ("#e8dbe6", "#ece4ea"),
}
STUDIO_TEMPLATES = ("UE_LUXURY_STUDIO", "UE_AUTOMOTIVE_CINEMATIC", "UE_TECHNOLOGY_SHOWCASE")
NAMES = {
    "UE_LUXURY_STUDIO": "Luxury Product Studio",
    "UE_AUTOMOTIVE_CINEMATIC": "Automotive Cinematic",
    "UE_MODERN_INTERIOR": "Modern Interior",
    "UE_INDUSTRIAL_WORKSHOP": "Industrial Workshop",
    "UE_TECHNOLOGY_SHOWCASE": "Technology Showcase",
    "UE_ARCHITECTURAL_DEMO": "Architectural Product Demo",
}


# ----------------------------------------------------------------------------------------------- helpers ----


def lux_for_ev(ev100: float) -> float:
    """Illuminance that renders a key-lit surface a little above middle grey at the given manual EV100."""
    return 3.5 * 2.0 ** ev100


def mat(color: str, roughness: float = 0.5, metallic: float = 0.0, specular: float = 0.5,
        emissive: float = 0.0) -> dict:
    return {"color": color.lower(), "roughness": roughness, "metallic": metallic, "specular": specular,
            "emissive": emissive}


def _r(v: float) -> float:
    return round(float(v), 3)


def box(sid: str, lo, hi, material: dict, yaw: float = 0.0) -> dict:
    """An axis-aligned Cube from min to max corner (optionally yawed about its centre)."""
    c = [(lo[i] + hi[i]) / 2.0 for i in range(3)]
    s = [max(0.1, hi[i] - lo[i]) / 100.0 for i in range(3)]
    return {"id": sid, "mesh": "Cube", "location": [_r(v) for v in c], "rotation": [0.0, _r(yaw), 0.0],
            "scale": [round(v, 5) for v in s], "material": material}


def cyl(sid: str, cx: float, cy: float, z0: float, z1: float, radius: float, material: dict) -> dict:
    return {"id": sid, "mesh": "Cylinder", "location": [_r(cx), _r(cy), _r((z0 + z1) / 2.0)],
            "rotation": [0.0, 0.0, 0.0], "scale": [round(2 * radius / 100.0, 5), round(2 * radius / 100.0, 5),
                                                    round(max(0.1, z1 - z0) / 100.0, 5)], "material": material}


def sphere(sid: str, c, radius: float, material: dict) -> dict:
    d = round(2 * radius / 100.0, 5)
    return {"id": sid, "mesh": "Sphere", "location": [_r(v) for v in c], "rotation": [0.0, 0.0, 0.0],
            "scale": [d, d, d], "material": material}


def cone(sid: str, cx: float, cy: float, z0: float, z1: float, radius: float, material: dict,
         flip: bool = False) -> dict:
    """A Cone (apex up; flip=True points the apex down — a lamp shade)."""
    return {"id": sid, "mesh": "Cone", "location": [_r(cx), _r(cy), _r((z0 + z1) / 2.0)],
            "rotation": [180.0 if flip else 0.0, 0.0, 0.0],
            "scale": [round(2 * radius / 100.0, 5), round(2 * radius / 100.0, 5), round((z1 - z0) / 100.0, 5)],
            "material": material}


def plane(sid: str, cx: float, cy: float, z: float, sx: float, sy: float, material: dict) -> dict:
    """A horizontal Plane (floor) of sx × sy cm."""
    return {"id": sid, "mesh": "Plane", "location": [_r(cx), _r(cy), _r(z)], "rotation": [0.0, 0.0, 0.0],
            "scale": [round(sx / 100.0, 5), round(sy / 100.0, 5), 1.0], "material": material}


def light(lid: str, kind: str, role: str, location, target, lux: float, *, kelvin: float | None = 6500.0,
          color: str | None = None, width: float | None = None, height: float | None = None,
          cone_deg: float | None = None, shadows: bool = True) -> dict:
    """A light aimed at `target` whose intensity gives `lux` there (candela = lux · distance², directional = lux)."""
    loc = tuple(float(v) for v in location)
    pitch, yaw = ue_math.look_at_rotation(loc, tuple(float(v) for v in target))
    dist_m = ue_math.length(ue_math.sub(tuple(target), loc)) / 100.0
    if kind in ("rect", "spot", "point"):
        intensity, unit = lux * dist_m * dist_m, "candelas"
    elif kind == "directional":
        intensity, unit = lux, "lux"
    else:
        intensity, unit = lux, "scale"
    out = {"id": lid, "kind": kind, "role": role, "location": [_r(v) for v in loc],
           "rotation": [_r(pitch), _r(yaw), 0.0], "target": [_r(v) for v in target],
           "intensity": round(intensity, 4), "unit": unit, "kelvin": kelvin, "color": color,
           "castShadows": shadows, "attenuationCm": _r(max(500.0, dist_m * 100.0 * 4.0))}
    if width is not None:
        out["width"] = _r(width)
        out["height"] = _r(height if height is not None else width)
    if cone_deg is not None:
        out["coneDeg"] = _r(cone_deg)
    return out


def around(target, az: float, el: float, dist: float):
    return ue_math.add(target, ue_math.scale(ue_math.direction(az, el), dist))


def darken(hex_color: str, k: float) -> str:
    rgb = [int(hex_color[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{max(0, min(255, int(round(c * k)))):02x}" for c in rgb)


def _finish(desc: dict, lighting: str) -> dict:
    """Apply the lighting preset (per-role multipliers, colour temperature, EV offset, fog) and compute the key."""
    mod = LIGHTING[lighting]
    for lt in desc["lights"]:
        lt["intensity"] = round(lt["intensity"] * mod["mult"].get(lt["role"], 1.0), 4)
        if mod["kelvin"] is not None and lt["role"] in ("key", "fill", "rim", "top") and lt["color"] is None:
            lt["kelvin"] = mod["kelvin"]
    desc["post"]["exposureEv100"] = round(desc["post"]["exposureEv100"] + mod["ev"], 3)
    if desc["fog"] is not None:
        desc["fog"]["density"] = round(desc["fog"]["density"] * mod["fog"], 5)
    desc["lighting"] = lighting
    canon = json.dumps({k: v for k, v in desc.items() if k != "key"}, sort_keys=True)
    desc["key"] = hashlib.sha256(f"set/{SET_VERSION}:{canon}".encode()).hexdigest()[:16]
    return desc


def _base(template: str, warnings: list[str]) -> dict:
    return {"version": SET_VERSION, "template": template, "name": NAMES[template], "shapes": [], "lights": [],
            "fog": None, "post": {}, "camera": {}, "skyAtmosphere": False, "cameraVolume": None,
            "warnings": warnings}


def _studio_colors(background: dict, warnings: list[str], default_dark: tuple[str, str]) -> tuple[str, str, str | None]:
    """(wall, floor, accent) of a studio set for the background preset."""
    preset = background["preset"]
    accent = background.get("accent")
    if preset == "brand_color":
        c = background.get("color") or "#1d3557"
        if not background.get("color"):
            warnings.append("background brand_color without a colour: #1d3557 used")
        return c, darken(c, 0.55), accent
    if preset == "transparent":
        warnings.append("transparent background is not rendered by the UE adapter (PNG without alpha): "
                        "dark backdrop used — use the Blender path for alpha clips")
        return default_dark[0], default_dark[1], accent
    if preset == "environment":
        warnings.append("background 'environment' on a studio template: the studio backdrop is used")
        return default_dark[0], default_dark[1], accent
    wall, floor = BACKDROPS[preset]
    return wall, floor, accent


def _studio_unit(dims) -> float:
    return max(8.0, min(600.0, max(dims)))


def _foot_radius(dims) -> float:
    return math.hypot(dims[0], dims[1]) / 2.0


# --------------------------------------------------------------------------------------------- templates ----


def luxury_studio(dims, background, environment, warnings) -> dict:
    """Dark glossy stage, a stone plinth (top = Z 0) with a brass ring, soft key, strip rims, background pool."""
    d = _base("UE_LUXURY_STUDIO", warnings)
    u = _studio_unit(dims)
    wall, floor, accent = _studio_colors(background, warnings, BACKDROPS["dark_gradient"])
    ph = 0.35 * u
    pr = max(0.75 * u, 1.15 * _foot_radius(dims))
    tgt = (0.0, 0.0, dims[2] * 0.5)
    ev = 9.0
    key = lux_for_ev(ev)
    d["shapes"] += [
        plane("floor", 0, 0, -ph, 60 * u, 60 * u, mat(floor, 0.16, specular=0.65)),
        cyl("plinth", 0, 0, -ph, 0.0, pr, mat("#1b1b1d", 0.32, specular=0.55)),
        cyl("plinth_ring", 0, 0, -ph, -ph + 0.025 * u, pr * 1.04, mat(accent or "#b08d57", 0.25, metallic=1.0)),
        box("backdrop", (-12.5 * u, -16 * u, -ph), (-12 * u, 16 * u, 12 * u), mat(wall, 0.85)),
        box("side_left", (-12 * u, 15.5 * u, -ph), (14 * u, 16 * u, 12 * u), mat(darken(wall, 0.8), 0.9)),
        box("side_right", (-12 * u, -16 * u, -ph), (14 * u, -15.5 * u, 12 * u), mat(darken(wall, 0.8), 0.9)),
    ]
    d["lights"] += [
        light("key", "rect", "key", around(tgt, -35, 30, 3.2 * u), tgt, key, kelvin=5600, width=1.6 * u,
              height=1.2 * u),
        light("fill", "rect", "fill", around(tgt, 60, 15, 4.0 * u), tgt, 0.35 * key, kelvin=6000, width=2 * u),
        light("rim_left", "rect", "rim", around(tgt, 150, 20, 2.5 * u), tgt, 2.4 * key, width=0.25 * u,
              height=2.2 * u),
        light("rim_right", "rect", "rim", around(tgt, -150, 20, 2.5 * u), tgt, 2.4 * key, width=0.25 * u,
              height=2.2 * u),
        light("top", "rect", "top", around(tgt, 0, 85, 3.0 * u), tgt, 0.6 * key, width=2 * u),
        light("backdrop_pool", "spot", "background", (-4 * u, 0, 6 * u), (-12 * u, 0, 1.5 * u), 0.8 * key,
              kelvin=6500, cone_deg=35, shadows=False),
        light("sky", "sky", "sky", (0, 0, 8 * u), (0, 0, 0), 0.15, kelvin=None),
    ]
    d["fog"] = {"density": 0.012, "heightFalloff": 0.2, "color": darken(wall, 1.2), "volumetric": False,
                "startCm": _r(2 * u)}
    d["post"] = {"exposureEv100": ev, "bloom": 0.35, "vignette": 0.45, "contrast": 1.05, "saturation": 1.0}
    d["camera"] = {"fstop": 4.0}
    d["cameraVolume"] = [[_r(-11 * u), _r(-15 * u), _r(-ph + 1)], [_r(13.5 * u), _r(15 * u), _r(11.5 * u)]]
    return d


def automotive_cinematic(dims, background, environment, warnings) -> dict:
    """Polished concrete hall, a low metal turntable disc (top = Z 0), overhead strip array, low side rims,
    volumetric haze."""
    d = _base("UE_AUTOMOTIVE_CINEMATIC", warnings)
    u = _studio_unit(dims)
    wall, floor, accent = _studio_colors(background, warnings, ("#1a1b1e", "#3a3c40"))
    if background["preset"] in BACKDROPS and background["preset"] != "dark_gradient":
        floor = darken(floor, 0.8)
    dh = 0.04 * u
    dr = max(0.85 * u, 1.1 * _foot_radius(dims))
    tgt = (0.0, 0.0, dims[2] * 0.5)
    ev = 8.0
    key = lux_for_ev(ev)
    d["shapes"] += [
        plane("floor", 0, 0, -dh, 80 * u, 80 * u, mat(floor, 0.28, specular=0.55)),
        cyl("turntable", 0, 0, -dh, 0.0, dr, mat("#2a2c30", 0.35, metallic=0.6)),
        cyl("turntable_edge", 0, 0, -dh, -dh * 0.5, dr * 1.015, mat(accent or "#9aa0a8", 0.2, metallic=1.0)),
        box("back_wall", (-15 * u, -18 * u, -dh), (-14.5 * u, 18 * u, 10 * u), mat(wall, 0.9)),
        box("side_left", (-14.5 * u, 17.5 * u, -dh), (16 * u, 18 * u, 10 * u), mat(wall, 0.9)),
        box("side_right", (-14.5 * u, -18 * u, -dh), (16 * u, -17.5 * u, 10 * u), mat(wall, 0.9)),
    ]
    for k in range(5):  # overhead strip array along the product's length (visible as reflections)
        y = (k - 2) * 0.6 * u
        d["shapes"].append(box(f"strip_{k}", (-0.8 * u, y - 0.04 * u, 3.3 * u), (0.8 * u, y + 0.04 * u, 3.34 * u),
                               mat("#ffffff", 0.5, emissive=8.0)))
        d["lights"].append(light(f"strip_light_{k}", "rect", "top", (0, y, 3.25 * u), (0, y * 0.3, dims[2] * 0.6),
                                 0.45 * key, kelvin=6500, width=1.6 * u, height=0.08 * u))
    d["lights"] += [
        light("key", "rect", "key", around(tgt, -40, 25, 4.0 * u), tgt, key, kelvin=6000, width=3 * u,
              height=1.2 * u),
        light("rim_left", "rect", "rim", (-0.5 * u, 3.0 * u, 0.6 * u), tgt, 1.8 * key, width=2.5 * u,
              height=0.2 * u),
        light("rim_right", "rect", "rim", (-0.5 * u, -3.0 * u, 0.6 * u), tgt, 1.8 * key, width=2.5 * u,
              height=0.2 * u),
        light("fill", "rect", "fill", around(tgt, 25, 8, 5.0 * u), tgt, 0.25 * key, width=3 * u, height=1.5 * u),
        light("sky", "sky", "sky", (0, 0, 8 * u), (0, 0, 0), 0.1, kelvin=None),
    ]
    d["fog"] = {"density": 0.02, "heightFalloff": 0.15, "color": "#1e2228", "volumetric": True,
                "startCm": _r(1.5 * u)}
    d["post"] = {"exposureEv100": ev, "bloom": 0.5, "vignette": 0.5, "contrast": 1.1, "saturation": 0.95}
    d["camera"] = {"fstop": 5.6}
    d["cameraVolume"] = [[_r(-14 * u), _r(-17 * u), _r(-dh + 1)], [_r(15.5 * u), _r(17 * u), _r(9.5 * u)]]
    return d


def technology_showcase(dims, background, environment, warnings) -> dict:
    """Black gloss floor with an emissive grid, a pedestal with a glowing ring, vertical light panels, cool haze."""
    d = _base("UE_TECHNOLOGY_SHOWCASE", warnings)
    u = _studio_unit(dims)
    wall, floor, accent = _studio_colors(background, warnings, ("#07080b", "#07080b"))
    glow = accent or (background.get("color") if background["preset"] == "brand_color" else None) or "#2bd6ff"
    ph = 0.06 * u
    pr = max(0.7 * u, 1.12 * _foot_radius(dims))
    tgt = (0.0, 0.0, dims[2] * 0.5)
    ev = 8.0
    key = lux_for_ev(ev)
    d["shapes"] += [
        plane("floor", 0, 0, -ph, 60 * u, 60 * u, mat(darken(floor, 0.9) if background["preset"] == "dark_gradient"
                                                     else floor, 0.12, specular=0.7)),
        cyl("pedestal", 0, 0, -ph, 0.0, pr, mat("#111318", 0.2, metallic=0.4)),
        cyl("pedestal_ring", 0, 0, -ph * 0.6, -ph * 0.45, pr * 1.03, mat(glow, 0.4, emissive=6.0)),
        box("back_wall", (-12.5 * u, -16 * u, -ph), (-12 * u, 16 * u, 10 * u), mat(wall, 0.8)),
    ]
    for k in range(9):  # floor grid (thin emissive lines), clear of the pedestal
        off = (k - 4) * 1.2 * u
        if abs(off) < pr * 1.3:
            continue
        d["shapes"].append(box(f"grid_x_{k}", (-10 * u, off - 0.006 * u, -ph), (10 * u, off + 0.006 * u, -ph + 0.002 * u),
                               mat(glow, 0.5, emissive=1.5)))
        d["shapes"].append(box(f"grid_y_{k}", (off - 0.006 * u, -10 * u, -ph), (off + 0.006 * u, 10 * u, -ph + 0.002 * u),
                               mat(glow, 0.5, emissive=1.5)))
    for k, y in enumerate((-2.2 * u, 0.0, 2.2 * u)):
        d["shapes"].append(box(f"panel_{k}", (-6.1 * u, y - 0.25 * u, -ph), (-6.0 * u, y + 0.25 * u, 4 * u),
                               mat(glow, 0.5, emissive=4.0)))
    d["lights"] += [
        light("key", "rect", "key", around(tgt, -30, 25, 3.0 * u), tgt, key, kelvin=8500, width=1.4 * u),
        light("rim_left", "rect", "rim", around(tgt, 140, 18, 2.6 * u), tgt, 2.0 * key, color=glow,
              width=0.2 * u, height=2.0 * u),
        light("rim_right", "rect", "rim", around(tgt, -140, 18, 2.6 * u), tgt, 2.0 * key, color=glow,
              width=0.2 * u, height=2.0 * u),
        light("top", "rect", "top", around(tgt, 0, 88, 3.0 * u), tgt, 0.5 * key, kelvin=9000, width=1.5 * u),
        light("accent", "point", "accent", (-5.5 * u, 0, 2 * u), tgt, 0.3 * key, color=glow, shadows=False),
        light("sky", "sky", "sky", (0, 0, 8 * u), (0, 0, 0), 0.08, kelvin=None),
    ]
    d["fog"] = {"density": 0.03, "heightFalloff": 0.25, "color": darken(glow, 0.25), "volumetric": True,
                "startCm": _r(1.5 * u)}
    d["post"] = {"exposureEv100": ev, "bloom": 0.8, "vignette": 0.5, "contrast": 1.12, "saturation": 1.05}
    d["camera"] = {"fstop": 4.0}
    d["cameraVolume"] = [[_r(-11.5 * u), _r(-15.5 * u), _r(-ph + 1)], [_r(15 * u), _r(15.5 * u), _r(9.5 * u)]]
    return d


def _support(dims, max_h: float = 60.0, max_w: float = 120.0) -> bool:
    """A small product goes on a support surface (table / bench / podium); a large one stands on the floor."""
    return dims[2] <= max_h and max(dims[0], dims[1]) <= max_w


def _room(d: dict, dims, floor_z: float, palette: dict, *, open_top: bool, window_side: float = 1.0) -> dict:
    """A room around the product: floor, back wall (−X), a side wall with a window opening (+Y or −Y), the front
    (+X) and the camera side (−Y for dolly_side) left open far enough for every camera preset."""
    size = max(dims)
    half = max(400.0, 4.5 * size + 50.0)   # room half-size around the product (fast orbits stay inside)
    back = -max(220.0, 1.8 * size + 120.0)   # back wall plane (x)
    height = max(300.0, 2.6 * dims[2] + 120.0)
    ceil = floor_z + height
    side_y = window_side * half
    t = 15.0  # wall thickness
    d["shapes"] += [
        plane("floor", (back + 2 * half) / 2, 0, floor_z, 2 * half - back + 200, 2 * half + 200,
              mat(palette["floor"], palette.get("floorRough", 0.6))),
        box("back_wall", (back - t, -half, floor_z), (back, half, ceil), mat(palette["wall"], 0.9)),
    ]
    # window wall (opening 40 %–75 % of the height, a third of the depth) built from four pieces
    w0, w1 = back + 0.25 * (2 * half), back + 0.6 * (2 * half)
    z0, z1 = floor_z + 0.3 * height, floor_z + 0.8 * height
    ys = (side_y, side_y + t) if window_side > 0 else (side_y - t, side_y)
    wm = mat(palette["wall"], 0.9)
    d["shapes"] += [
        box("side_wall_a", (back, ys[0], floor_z), (w0, ys[1], ceil), wm),
        box("side_wall_b", (w1, ys[0], floor_z), (2 * half, ys[1], ceil), wm),
        box("side_wall_low", (w0, ys[0], floor_z), (w1, ys[1], z0), wm),
        box("side_wall_high", (w0, ys[0], z1), (w1, ys[1], ceil), wm),
        box("window_frame", (w0, ys[0] - 2, z0 - 3), (w1, ys[1] + 2, z0), mat("#2b2d30", 0.4, metallic=0.7)),
    ]
    if not open_top:
        d["shapes"].append(box("ceiling", (back, -half, ceil), (2 * half, half, ceil + t), mat(palette["wall"], 0.95)))
    window_c = ((w0 + w1) / 2, side_y, (z0 + z1) / 2)
    y_lo = -half + 10 + (t if window_side < 0 else 0.0)
    y_hi = half - 10 - (t if window_side > 0 else 0.0)
    d["cameraVolume"] = [[_r(back + 10), _r(y_lo), _r(floor_z + 5)],
                         [_r(2 * half - 10), _r(y_hi), _r((ceil - 10) if not open_top else ceil + 4 * size)]]
    return {"back": back, "half": half, "ceil": ceil, "window": window_c, "windowSize": (w1 - w0, z1 - z0)}


INTERIOR_PALETTES = {
    "living_room": {"wall": "#e9e4da", "floor": "#8b6a4e", "support": "#a07850", "accent": "#5b7f6e",
                    "supportH": 75.0, "supportName": "side_table"},
    "kitchen": {"wall": "#ecebe7", "floor": "#9a958d", "support": "#e8e6e1", "supportRough": 0.25,
                "accent": "#3f4a52", "supportH": 90.0, "supportName": "counter"},
    "bathroom": {"wall": "#dfe3e4", "floor": "#c9cdcf", "support": "#f2f2f0", "supportRough": 0.2,
                 "accent": "#6f8f9b", "supportH": 85.0, "supportName": "vanity"},
    "desk": {"wall": "#dcd8d0", "floor": "#7a634f", "support": "#5d4433", "accent": "#c06a3d",
             "supportH": 74.0, "supportName": "desk"},
}


def modern_interior(dims, background, environment, warnings) -> dict:
    """A daylit modern room: the product on a side table / counter / vanity / desk (top = Z 0) — or on the floor
    when it is furniture-sized — sofa, plant, rug, wall art and a pendant lamp; sun + window light + fill."""
    d = _base("UE_MODERN_INTERIOR", warnings)
    env = (environment or {}).get("preset", "living_room")
    if env not in INTERIOR_PALETTES:
        warnings.append(f"environment {env!r} has no modern interior variant: living_room used")
        env = "living_room"
    pal = dict(INTERIOR_PALETTES[env])
    accent = background.get("accent") or (background.get("color") if background["preset"] == "brand_color"
                                           else None) or pal["accent"]
    if background["preset"] not in ("environment", "brand_color"):
        warnings.append(f"background {background['preset']!r} does not apply to an interior: the room is the "
                        "background")
    on_support = _support(dims)
    sh = pal["supportH"] if on_support else 0.5  # a floor-standing product stands on a 5 mm rug (top = Z 0)
    floor_z = -sh
    room = _room(d, dims, floor_z, pal, open_top=not (on_support and max(dims) <= 40.0))
    tgt = (0.0, 0.0, dims[2] * 0.5)
    if on_support:
        tw = max(110.0, 2.4 * max(dims[0], dims[1]))
        td = max(55.0, 2.0 * min(dims[0], dims[1]) + 20)
        sm = mat(pal["support"], pal.get("supportRough", 0.55))
        d["shapes"].append(box(pal["supportName"], (-td / 2, -tw / 2, -4.0), (td / 2, tw / 2, 0.0), sm))
        for k, (x, y) in enumerate(((-td / 2 + 5, -tw / 2 + 5), (-td / 2 + 5, tw / 2 - 5), (td / 2 - 5, -tw / 2 + 5),
                                    (td / 2 - 5, tw / 2 - 5))):
            d["shapes"].append(box(f"leg_{k}", (x - 2.5, y - 2.5, floor_z), (x + 2.5, y + 2.5, -4.0),
                                   mat(darken(pal["support"], 0.6), 0.5)))
    else:
        rx = 1.3 * max(dims[0], dims[1]) + 40
        ry = 1.0 * max(dims[0], dims[1]) + 40
        d["shapes"].append(box("rug", (-rx, -ry, floor_z), (rx, ry, 0.0), mat("#cfc6b8", 0.95)))
    back = room["back"]
    fr = _foot_radius(dims)
    px, py = -(fr + 45.0), fr + 45.0  # pendant lamp beside (never over) the product
    pz = max(floor_z + 190.0, dims[2] + 40.0)
    sofa_x = back + 60.0
    sy = 0.45 * room["half"]
    sofa = mat("#7d8a8c", 0.9)
    d["shapes"] += [
        box("sofa_base", (sofa_x - 45, sy - 110, floor_z), (sofa_x + 45, sy + 110, floor_z + 42), sofa),
        box("sofa_back", (sofa_x - 45, sy - 110, floor_z + 42), (sofa_x - 25, sy + 110, floor_z + 85), sofa),
        box("sofa_arm_a", (sofa_x - 45, sy - 110, floor_z + 42), (sofa_x + 45, sy - 92, floor_z + 62), sofa),
        box("sofa_arm_b", (sofa_x - 45, sy + 92, floor_z + 42), (sofa_x + 45, sy + 110, floor_z + 62), sofa),
        box("cushion", (sofa_x - 22, sy + 20, floor_z + 42), (sofa_x - 4, sy + 70, floor_z + 80), mat(accent, 0.9)),
        cyl("plant_pot", back + 45, -0.55 * room["half"], floor_z, floor_z + 45, 22, mat("#d9d4cc", 0.6)),
        sphere("plant_leaves", (back + 45, -0.55 * room["half"], floor_z + 95), 48, mat("#4f6b45", 0.85)),
        box("wall_art", (back, -60, floor_z + 140), (back + 3, 60, floor_z + 210), mat(accent, 0.7)),
        cyl("pendant_cord", px, py, pz + 22, room["ceil"], 0.6, mat("#222222", 0.5)),
        cone("pendant_shade", px, py, pz, pz + 22, 18, mat("#1f1f1f", 0.4, metallic=0.5), flip=True),
    ]
    ev = 7.5
    key = lux_for_ev(ev)
    wx, wy, wz = room["window"]
    ww, wh = room["windowSize"]
    d["lights"] += [
        light("window", "rect", "key", (wx, wy - 5, wz), tgt, key, kelvin=6000, width=ww, height=wh),
        light("sun", "directional", "sun", (wx, wy + 400, wz + 400), tgt, 2.5 * key, kelvin=5800),
        light("fill", "rect", "fill", around(tgt, 10, 20, 260.0 + 1.5 * max(dims)), tgt, 0.3 * key, kelvin=5600,
              width=120, height=120),
        light("pendant", "point", "practical", (px, py, pz - 2), tgt, 0.25 * key, kelvin=2900),
        light("sky", "sky", "sky", (0, 0, room["ceil"] + 200), (0, 0, 0), 1.0, kelvin=None),
    ]
    d["fog"] = {"density": 0.004, "heightFalloff": 0.2, "color": "#d8d4cc", "volumetric": False, "startCm": 50.0}
    d["post"] = {"exposureEv100": ev, "bloom": 0.25, "vignette": 0.3, "contrast": 1.0, "saturation": 1.0}
    d["camera"] = {"fstop": 2.8}
    d["environment"] = env
    return d


WORKSHOP_PALETTES = {
    "workshop": {"wall": "#7a5a4a", "floor": "#6e6c69", "floorRough": 0.85, "board": "#8c7a5e"},
    "garage": {"wall": "#8d8f91", "floor": "#5f6266", "floorRough": 0.7, "board": "#6f7377"},
}


def industrial_workshop(dims, background, environment, warnings) -> dict:
    """A workbench (top = Z 0) in front of a pegboard with tool silhouettes, metal shelving, a hanging industrial
    lamp, a fluorescent tube and dusty volumetric haze; garage variant with grey walls and a roll-up door."""
    d = _base("UE_INDUSTRIAL_WORKSHOP", warnings)
    env = (environment or {}).get("preset", "workshop")
    if env not in WORKSHOP_PALETTES:
        warnings.append(f"environment {env!r} has no workshop variant: workshop used")
        env = "workshop"
    pal = WORKSHOP_PALETTES[env]
    accent = background.get("accent") or "#c8532c"
    if background["preset"] not in ("environment", "brand_color"):
        warnings.append(f"background {background['preset']!r} does not apply to a workshop: the room is the "
                        "background")
    on_support = _support(dims, 70.0, 140.0)
    bench_h = 90.0 if on_support else 0.0
    floor_z = -bench_h
    room = _room(d, dims, floor_z, pal, open_top=True, window_side=-1.0)
    tgt = (0.0, 0.0, dims[2] * 0.5)
    bd = max(70.0, 2.0 * min(dims[0], dims[1]) + 30)
    bw = max(160.0, 2.6 * max(dims[0], dims[1]))
    steel = mat("#3b3f44", 0.4, metallic=0.8)
    if on_support:
        d["shapes"] += [
            box("bench_top", (-bd / 2, -bw / 2, -5.0), (bd / 2, bw / 2, 0.0), mat("#8a6b47", 0.65)),
            box("bench_shelf", (-bd / 2 + 5, -bw / 2 + 5, floor_z + 18), (bd / 2 - 5, bw / 2 - 5, floor_z + 21), steel),
        ]
        for k, (x, y) in enumerate(((-bd / 2 + 4, -bw / 2 + 4), (-bd / 2 + 4, bw / 2 - 4), (bd / 2 - 4, -bw / 2 + 4),
                                    (bd / 2 - 4, bw / 2 - 4))):
            d["shapes"].append(box(f"bench_leg_{k}", (x - 3, y - 3, floor_z), (x + 3, y + 3, -5.0), steel))
    back = room["back"]
    board_x = back + 2.0
    d["shapes"].append(box("pegboard", (back, -bw / 2 - 40, floor_z + 100), (board_x, bw / 2 + 40, floor_z + 230),
                           mat(pal["board"], 0.8)))
    for i in range(6):  # tool silhouettes on the board
        y = -bw / 2 + 20 + i * (bw / 5.5)
        d["shapes"].append(box(f"tool_{i}", (board_x, y - 4, floor_z + 140 + (i % 2) * 25),
                               (board_x + 3, y + 4, floor_z + 190 + (i % 3) * 10),
                               mat("#2d3033" if i % 2 else accent, 0.45, metallic=0.6 if i % 2 else 0.0)))
    sx = back + 40.0
    sy = 0.6 * room["half"]
    for k in range(4):
        z = floor_z + 10 + k * 55
        d["shapes"].append(box(f"shelf_{k}", (sx - 25, sy - 60, z), (sx + 25, sy + 60, z + 3), steel))
        d["shapes"].append(box(f"crate_{k}", (sx - 18, sy - 50 + 12 * k, z + 3), (sx + 12, sy - 10 + 12 * k, z + 30),
                               mat(("#556b2f", "#8b5a2b", "#4a5560", "#7a6a4f")[k], 0.85)))
    if env == "garage":
        for k in range(8):  # roll-up door ribs on the back wall
            z = floor_z + 15 + k * 28
            d["shapes"].append(box(f"door_rib_{k}", (back, 0.2 * room["half"], z), (back + 4, 0.75 * room["half"], z + 20),
                                   mat("#a3a6a9", 0.5, metallic=0.5)))
    lamp_z = max(dims[2] + 80.0, 110.0)
    d["shapes"] += [
        cyl("lamp_cord", 0, 0, lamp_z + 30, lamp_z + 400, 0.7, mat("#1d1d1d", 0.5)),
        cone("lamp_shade", 0, 0, lamp_z, lamp_z + 30, 24, mat("#2e4a3a", 0.35, metallic=0.6), flip=True),
        box("tube", (back + 80, -60, room["ceil"] - 30), (back + 86, 60, room["ceil"] - 26),
            mat("#ffffff", 0.5, emissive=10.0)),
    ]
    ev = 7.0
    key = lux_for_ev(ev)
    wx, wy, wz = room["window"]
    ww, wh = room["windowSize"]
    d["lights"] += [
        light("lamp", "spot", "practical", (0, 0, lamp_z - 2), tgt, 1.2 * key, kelvin=3800, cone_deg=55),
        light("key", "rect", "key", around(tgt, -35, 28, 200.0 + 1.6 * max(dims)), tgt, 0.7 * key, kelvin=5000,
              width=90, height=70),
        light("window", "rect", "fill", (wx, wy + 5, wz), tgt, 0.45 * key, kelvin=6200, width=ww, height=wh),
        light("tube_light", "rect", "top", (back + 83, 0, room["ceil"] - 32), tgt, 0.3 * key, kelvin=4800, width=120,
              height=6),
        light("rim", "rect", "rim", around(tgt, 155, 25, 180.0 + 1.2 * max(dims)), tgt, 1.4 * key, kelvin=4200,
              width=40, height=120),
        light("sky", "sky", "sky", (0, 0, room["ceil"] + 200), (0, 0, 0), 0.6, kelvin=None),
    ]
    d["fog"] = {"density": 0.035, "heightFalloff": 0.3, "color": "#3a3128", "volumetric": True, "startCm": 40.0}
    d["post"] = {"exposureEv100": ev, "bloom": 0.25, "vignette": 0.4, "contrast": 1.08, "saturation": 0.95}
    d["camera"] = {"fstop": 3.5}
    d["environment"] = env
    return d


def architectural_demo(dims, background, environment, warnings) -> dict:
    """A bright gallery hall: polished concrete, a white podium (top = Z 0), a tall mullioned window wall letting
    the sun in, concrete columns, a bench and a planter; sky atmosphere + sun + sky light."""
    d = _base("UE_ARCHITECTURAL_DEMO", warnings)
    if background["preset"] not in ("environment", "brand_color", "light_gradient", "seamless_white"):
        warnings.append(f"background {background['preset']!r} does not apply to the architectural hall")
    accent = background.get("accent") or (background.get("color") if background["preset"] == "brand_color"
                                           else None) or "#c9b79c"
    on_support = _support(dims, 80.0, 160.0)
    ph = 60.0 if on_support else 0.0
    floor_z = -ph
    size = max(dims)
    half = max(650.0, 5.5 * size + 100.0)
    back = -max(320.0, 2.0 * size + 150.0)
    height = max(600.0, 3.0 * dims[2] + 200.0)
    tgt = (0.0, 0.0, dims[2] * 0.5)
    concrete = mat("#b9b6b0", 0.35, specular=0.5)
    plaster = mat("#efede8", 0.9)
    d["shapes"] += [
        plane("floor", 0, 0, floor_z, 2 * half + 400, 2 * half + 400, concrete),
        box("back_wall", (back - 20, -half, floor_z), (back, half, floor_z + height), plaster),
    ]
    if on_support:
        pw = max(80.0, 1.8 * max(dims[0], dims[1]))
        d["shapes"].append(box("podium", (-pw / 2, -pw / 2, floor_z), (pw / 2, pw / 2, 0.0), mat("#f4f3f0", 0.4)))
    # window wall on +Y: vertical mullions + transoms with open bays between them (sunlight passes)
    wy = half
    bays = 7
    x0, x1 = back, half
    for i in range(bays + 1):
        x = x0 + (x1 - x0) * i / bays
        d["shapes"].append(box(f"mullion_{i}", (x - 6, wy, floor_z), (x + 6, wy + 12, floor_z + height),
                               mat("#2b2d30", 0.4, metallic=0.7)))
    for j, z in enumerate((floor_z + 0.05 * height, floor_z + 0.55 * height, floor_z + height - 10)):
        d["shapes"].append(box(f"transom_{j}", (x0, wy, z - 5), (x1, wy + 12, z + 5),
                               mat("#2b2d30", 0.4, metallic=0.7)))
    for k in range(3):
        cx = back + 0.35 * (half - back) * (k + 0.6)
        d["shapes"].append(cyl(f"column_{k}", cx, -0.7 * half, floor_z, floor_z + height, 28, concrete))
    d["shapes"] += [
        box("bench", (back + 60, 0.35 * half, floor_z), (back + 110, 0.35 * half + 200, floor_z + 45),
            mat("#6b5643", 0.6)),
        box("planter", (back + 60, -0.35 * half - 70, floor_z), (back + 130, -0.35 * half, floor_z + 60),
            mat(accent, 0.7)),
        sphere("planter_green", (back + 95, -0.35 * half - 35, floor_z + 110), 55, mat("#56724a", 0.85)),
    ]
    ev = 11.0
    key = lux_for_ev(ev)
    d["lights"] += [
        light("sun", "directional", "sun", (0.3 * half, wy + 800, 900 + floor_z), tgt, 2.2 * key, kelvin=5600),
        light("sky", "sky", "sky", (0, 0, floor_z + height + 300), (0, 0, 0), 1.0, kelvin=None),
        light("fill", "rect", "fill", around(tgt, 15, 18, 300.0 + 1.6 * size), tgt, 0.35 * key, kelvin=6000,
              width=200, height=200),
        light("key", "rect", "key", around(tgt, -40, 30, 260.0 + 1.4 * size), tgt, 0.6 * key, kelvin=5600,
              width=150, height=150),
    ]
    d["skyAtmosphere"] = True
    d["fog"] = {"density": 0.002, "heightFalloff": 0.1, "color": "#cfd8e0", "volumetric": False, "startCm": 200.0}
    d["post"] = {"exposureEv100": ev, "bloom": 0.2, "vignette": 0.2, "contrast": 1.0, "saturation": 1.0}
    d["camera"] = {"fstop": 5.6}
    d["cameraVolume"] = [[_r(back + 15), _r(-half + 15), _r(floor_z + 5)], [_r(half - 15), _r(wy - 15),
                                                                             _r(floor_z + height + 4 * size)]]
    return d


BUILDERS = {
    "UE_LUXURY_STUDIO": luxury_studio,
    "UE_AUTOMOTIVE_CINEMATIC": automotive_cinematic,
    "UE_MODERN_INTERIOR": modern_interior,
    "UE_INDUSTRIAL_WORKSHOP": industrial_workshop,
    "UE_TECHNOLOGY_SHOWCASE": technology_showcase,
    "UE_ARCHITECTURAL_DEMO": architectural_demo,
}


def describe_set(template: str, lighting: str, background: dict, environment: dict | None, dims_cm) -> dict:
    """The set for a template, lighting preset, background and the placed product's size (cm)."""
    if template not in BUILDERS:
        raise ValueError(f"unknown template {template!r}")
    if lighting not in LIGHTING:
        raise ValueError(f"unknown lighting preset {lighting!r}")
    dims = tuple(round(float(v), 1) for v in dims_cm)  # 1 mm buckets: tiny scale noise keeps the same set
    if min(dims) <= 0:
        raise ValueError("product dimensions must be positive")
    warnings: list[str] = []
    desc = BUILDERS[template](dims, background, environment, warnings)
    desc["productDimsCm"] = list(dims)
    return _finish(desc, lighting)


def aim_error_deg(lt: dict) -> float:
    """Angle between a light's forward axis and the direction to its target (0 = aimed exactly)."""
    fwd, _r_, _u = ue_math.basis(lt["rotation"][0], lt["rotation"][1])
    to = ue_math.sub(tuple(lt["target"]), tuple(lt["location"]))
    n = ue_math.length(to)
    if n < 1e-9:
        return 0.0
    c = max(-1.0, min(1.0, ue_math.dot(fwd, ue_math.scale(to, 1.0 / n))))
    return math.degrees(math.acos(c))


def shape_aabb(s: dict) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Conservative world AABB of a set shape (rotated shapes: the bounding sphere)."""
    loc = s["location"]
    ext = [v * 50.0 for v in s["scale"]]
    if s["mesh"] == "Plane":  # infinitely thin
        ext[2] = 0.01
    if any(abs(a) > 1e-6 for a in s["rotation"]):
        r = math.sqrt(sum(e * e for e in ext))
        ext = [r, r, r]
    return (tuple(loc[i] - ext[i] for i in range(3)), tuple(loc[i] + ext[i] for i in range(3)))  # type: ignore
