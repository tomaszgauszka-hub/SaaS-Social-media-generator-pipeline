"""Pure camera / projection / scale math of the UE scene generator (stdlib only — unit-tested with plain CPython).

Unreal conventions used throughout:
  * centimetres; Z up; left-handed: an unrotated actor looks along +X, its right is +Y, its up is +Z;
  * the product stands centred on XY with its base on Z = 0 and its front facing +X (tools/blender/scenes/export.py
    writes FBX so that Blender's −Y front becomes UE +X);
  * rotations are UE rotators in degrees: yaw about Z (+X towards +Y), pitch about the right axis (+ looks up);
  * a camera azimuth of 0 is the product's front (+X side), +90 the viewer's right (−Y side), like the Blender
    generators' camera table, so the same preset reads the same in both engines;
  * the CineCamera filmback is set to the frame's aspect ratio with a 36 mm sensor height (the Blender
    generators' VERTICAL sensor fit), so a lens in mm gives the same field of view in both engines;
  * image coordinates are normalised, u to the right, v DOWN (0..1) — the result.json productBoxes convention.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

SENSOR_HEIGHT_MM = 36.0

Vec = tuple[float, float, float]

#: preset → (base az, az span, base el, el span, fill, lens mm, dolly) — the Blender generators' table;
#: spans scale with the movement speed (ue_job.MOVEMENTS)
CAMERA = {
    "orbit_closeup": (-26.0, 52.0, 12.0, 0.0, 0.60, 65.0, 0.0),
    "orbit_wide": (-34.0, 76.0, 17.0, 0.0, 0.42, 45.0, 0.0),
    "turntable": (-30.0, 0.0, 11.0, 0.0, 0.58, 70.0, 0.0),
    "push_in": (-24.0, 12.0, 10.0, 0.0, 0.46, 55.0, 0.32),
    "crane_up": (-18.0, 6.0, -4.0, 34.0, 0.55, 50.0, 0.0),
    "dolly_side": (90.0, 0.0, 6.0, 0.0, 0.74, 60.0, 0.0),
    "macro_slide": (-22.0, 34.0, 9.0, 4.0, 1.30, 100.0, 0.0),
    "top_down": (-22.0, 40.0, 78.0, 0.0, 0.58, 50.0, 0.0),
    "hero_low": (-32.0, 26.0, 2.0, 6.0, 0.64, 40.0, 0.12),
}
#: macro_slide frames a detail crop of the upper product (UE has no part structure to aim at)
MACRO_TARGET_HEIGHT = 0.68
#: the box may not exceed this share of the frame width (except macro crops)
MAX_WIDTH = 0.9


# ------------------------------------------------------------------------------------------------ vectors ----


def add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale(a: Vec, s: float) -> Vec:
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def length(a: Vec) -> float:
    return math.sqrt(dot(a, a))


def ease_in_out(t: float) -> float:
    """Cubic ease (camera / product moves) — identical to the Blender generators."""
    t = max(0.0, min(1.0, t))
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def rotate_z(p: Vec, deg: float) -> Vec:
    """Rotate about the Z axis through the origin by a UE yaw (degrees, +X towards +Y)."""
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2])


def unwrap_deg(prev: float, cur: float) -> float:
    """cur + k·360 closest to prev — keeps keyframed euler channels continuous (no 359° → 0° flips)."""
    return cur + 360.0 * round((prev - cur) / 360.0)


# ------------------------------------------------------------------------------------------------ camera -----


def direction(az_deg: float, el_deg: float) -> Vec:
    """Unit vector from the target towards the camera: az 0 = front (+X), +90 = viewer's right (−Y), el up."""
    az, el = math.radians(az_deg), math.radians(el_deg)
    return (math.cos(az) * math.cos(el), -math.sin(az) * math.cos(el), math.sin(el))


def look_at_rotation(cam: Vec, target: Vec) -> tuple[float, float]:
    """(pitch, yaw) in degrees of a camera at `cam` looking at `target` (UE FindLookAtRotation, roll 0)."""
    d = sub(target, cam)
    horiz = math.hypot(d[0], d[1])
    if horiz < 1e-9 and abs(d[2]) < 1e-9:
        raise ValueError("camera and target coincide")
    return math.degrees(math.atan2(d[2], horiz)), math.degrees(math.atan2(d[1], d[0]))


def basis(pitch_deg: float, yaw_deg: float) -> tuple[Vec, Vec, Vec]:
    """(forward, right, up) of a UE rotator with roll 0 — the columns of FRotationMatrix."""
    p, y = math.radians(pitch_deg), math.radians(yaw_deg)
    cp, sp, cy, sy = math.cos(p), math.sin(p), math.cos(y), math.sin(y)
    return (cp * cy, cp * sy, sp), (-sy, cy, 0.0), (-sp * cy, -sp * sy, cp)


@dataclass(frozen=True)
class Lens:
    focal_mm: float
    sensor_w_mm: float
    sensor_h_mm: float


def lens_for(focal_mm: float, width: int, height: int) -> Lens:
    """Filmback matched to the frame: 36 mm sensor height, width by the aspect ratio (no letterbox)."""
    return Lens(focal_mm, SENSOR_HEIGHT_MM * width / height, SENSOR_HEIGHT_MM)


def project(p: Vec, cam: Vec, pitch: float, yaw: float, lens: Lens) -> tuple[float, float, float]:
    """(u, v, depth) of a world point — u right, v down, normalised to the frame; depth along the view axis."""
    fwd, right, up = basis(pitch, yaw)
    d = sub(p, cam)
    x, y, z = dot(d, fwd), dot(d, right), dot(d, up)
    if x <= 1e-9:
        return (math.nan, math.nan, x)
    return (0.5 + (lens.focal_mm * y / x) / lens.sensor_w_mm, 0.5 - (lens.focal_mm * z / x) / lens.sensor_h_mm, x)


def project_box(points: list[Vec], cam: Vec, pitch: float, yaw: float, lens: Lens) -> tuple[float, float, float, float]:
    """Projected bounds (u0, v0, u1, v1) of the points in front of the camera."""
    us: list[float] = []
    vs: list[float] = []
    for p in points:
        u, v, z = project(p, cam, pitch, yaw, lens)
        if z > 1e-9:
            us.append(u)
            vs.append(v)
    if not us:
        raise ValueError("no point in front of the camera")
    return (min(us), min(vs), max(us), max(vs))


def box_corners(lo: Vec, hi: Vec) -> list[Vec]:
    return [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]


def aim_offset_deg(center_y: float, lens: Lens) -> float:
    """Extra camera pitch that moves the aim point from the frame centre to height `center_y` (v down):
    a product placed low in the frame (center_y > 0.5) needs the camera to look up."""
    return math.degrees(math.atan((center_y - 0.5) * lens.sensor_h_mm / lens.focal_mm))


def camera_angles(preset: str, movement: float, t: float) -> tuple[float, float, float]:
    """(az, el, dolly fraction) at clip time t ∈ [0, 1] — the Blender generators' camera plans."""
    az0, az_span, el0, el_span, _fill, _lens, dolly = CAMERA[preset]
    e = ease_in_out(t)
    az = az0 + az_span * movement * (e - 0.5) if preset != "push_in" else az0 + az_span * movement * e
    el = el0 + el_span * movement * e
    return az, el, dolly * movement * e


def product_yaw(preset: str, movement: float, turns: float, t: float) -> float:
    """Product yaw (degrees) at clip time t: a turntable spins `turns` revolutions, a hero shot sweeps gently,
    every other preset keeps the product still and moves the camera."""
    if preset == "turntable":
        return 360.0 * turns * t
    if preset == "hero_low":
        return -6.0 * movement + 12.0 * movement * ease_in_out(t)
    return 0.0


def clamp_fill(fill: float, center_y: float) -> float:
    """The box must stay inside the frame vertically around center_y (4 % margin)."""
    return min(fill, 2.0 * min(center_y, 1.0 - center_y) * 0.96)


def _box_at(points, target, dirv, d, lens, aim) -> tuple[float, float, float, float]:
    cam = add(target, scale(dirv, d))
    pitch, yaw = look_at_rotation(cam, target)
    return project_box(points, cam, pitch + aim, yaw, lens)


def fit_distance(points: list[Vec], target: Vec, az: float, el: float, lens: Lens, fill: float,
                 max_width: float | None, aim: float = 0.0) -> float:
    """Distance on the ray (az, el) from `target` at which the points span `fill` of the frame height and — unless
    max_width is None (a macro crop) — lie inside the central `max_width` of the frame width and inside its height
    (bisection — the projected box shrinks towards the aim point with distance)."""
    if not points:
        raise ValueError("fit_distance needs points")
    dirv = direction(az, el)
    radius = max(length(sub(p, target)) for p in points)
    lo = max(radius * 1.05, 1e-3)

    side = None if max_width is None else (1.0 - max_width) / 2.0

    def too_big(d: float) -> bool:
        b = _box_at(points, target, dirv, d, lens, aim)
        if (b[3] - b[1]) > fill:
            return True
        # contained framing: inside the side margins and the frame height (perspective makes boxes asymmetric)
        return side is not None and (b[0] < side or b[2] > 1.0 - side or b[1] < 0.01 or b[3] > 0.99)

    if not too_big(lo):
        return lo
    hi = lo * 2.0
    while too_big(hi):
        hi *= 2.0
        if hi > radius * 1e4:
            return hi
    for _ in range(48):
        mid = 0.5 * (lo + hi)
        if too_big(mid):
            lo = mid
        else:
            hi = mid
    return hi


@dataclass(frozen=True)
class FramePose:
    frame: int
    camera: Vec
    pitch: float
    yaw: float
    product_yaw: float
    focus_cm: float


def camera_plan(preset: str, movement: float, turns: float, framing: dict, dims_cm: Vec, width: int,
                height: int, n_frames: int) -> dict:
    """Per-frame camera + product poses, product boxes and anchor tracks for a placed product (bounds centred on
    XY, base on Z = 0, dims_cm = its size). Pure: ue_scene keys exactly these poses into the Level Sequence, so
    the boxes describe the rendered frames (up to the oriented-bounds approximation of the product)."""
    if n_frames < 2:
        raise ValueError("a clip has at least 2 frames")
    dx, dy, dz = dims_cm
    size = max(dims_cm)
    lo, hi = (-dx / 2, -dy / 2, 0.0), (dx / 2, dy / 2, dz)
    corners = box_corners(lo, hi)
    az0, _azs, _el0, _els, fill0, focal, _dolly = CAMERA[preset]
    lens = lens_for(focal, width, height)
    center_y = framing.get("centerY", 0.5)
    macro = preset == "macro_slide"
    if macro:
        fill = fill0
    else:  # the requested fill, limited so the box (grown by a dolly-in at the end) stays inside the frame
        grow = 1.0 / max(0.2, 1.0 - _dolly * movement)
        fill = min(framing.get("fill") or fill0, clamp_fill(1.0, center_y) / grow)
    aim = aim_offset_deg(center_y, lens)
    target = (0.0, 0.0, dz * (MACRO_TARGET_HEIGHT if macro else 0.5))
    span = max(dx, dy)

    def pts_at(t: float) -> list[Vec]:
        yaw = product_yaw(preset, movement, turns, t)
        if preset == "turntable":  # the whole spin must stay in frame
            return [rotate_z(p, yaw + 45.0 * k) for k in range(8) for p in corners]
        return [rotate_z(p, yaw) for p in corners]

    def target_at(t: float) -> Vec:
        if preset != "dolly_side":
            return target
        az = camera_angles(preset, movement, t)[0]
        right = (-math.sin(math.radians(az)), -math.cos(math.radians(az)), 0.0)
        return add(target, scale(right, span * 0.16 * movement * (ease_in_out(t) - 0.5)))

    def fit(aim_deg: float) -> float:
        """Base distance: the fill holds at the dolly-free distance, the containment at every sample's actual
        (dollied) distance."""
        d_max = 0.0
        for t in (0.0, 0.25, 0.5, 0.75, 1.0):
            az, el, dolly = camera_angles(preset, movement, t)
            pts, tgt = pts_at(t), target_at(t)
            d_max = max(d_max, fit_distance(pts, tgt, az, el, lens, fill, None, aim_deg))
            if not macro:
                d_max = max(d_max, fit_distance(pts, tgt, az, el, lens, 10.0, MAX_WIDTH, aim_deg)
                            / max(0.2, 1.0 - dolly))
        return d_max

    dist = fit(aim)
    if not macro:
        # perspective shifts the projected box off the aim point: correct the aim at mid-clip so the box centre
        # sits on center_y, refitting each time (a macro crop is aimed at a detail, not centred)
        for _ in range(3):
            az, el, dolly = camera_angles(preset, movement, 0.5)
            tgt = target_at(0.5)
            cam = add(tgt, scale(direction(az, el), dist * (1.0 - dolly)))
            pitch, yaw = look_at_rotation(cam, tgt)
            bx = project_box(pts_at(0.5), cam, pitch + aim, yaw, lens)
            err = center_y - (bx[1] + bx[3]) / 2.0
            if abs(err) < 0.002:
                break
            aim += math.degrees(math.atan(err * lens.sensor_h_mm / lens.focal_mm))
            dist = fit(aim)
    floor_clear = 1.0 + 0.02 * size
    poses: list[FramePose] = []
    boxes: list[list[float]] = []
    center_track: list = []
    top_track: list = []
    prev_yaw = None
    for f in range(n_frames):
        t = f / (n_frames - 1)
        az, el, dolly = camera_angles(preset, movement, t)
        tgt = target_at(t)
        d = dist * (1.0 - dolly)
        pos = add(tgt, scale(direction(az, el), d))
        if pos[2] < floor_clear:
            pos = (pos[0], pos[1], floor_clear)
        pitch, yaw = look_at_rotation(pos, tgt)
        pitch += aim
        if prev_yaw is not None:
            yaw = unwrap_deg(prev_yaw, yaw)
        prev_yaw = yaw
        pyaw = product_yaw(preset, movement, turns, t)  # continuous by construction (no unwrap needed)
        poses.append(FramePose(f, pos, pitch, yaw, pyaw, length(sub(tgt, pos))))
        pts = [rotate_z(p, pyaw) for p in corners]
        try:
            u0, v0, u1, v1 = project_box(pts, pos, pitch, yaw, lens)
            boxes.append([round(u0, 4), round(v0, 4), round(u1, 4), round(v1, 4)])
        except ValueError:
            boxes.append([0.0, 0.0, 0.0, 0.0])
        for track, point in ((center_track, (0.0, 0.0, dz / 2)), (top_track, (0.0, 0.0, dz))):
            u, v, z = project(point, pos, pitch, yaw, lens)
            track.append([round(u, 4), round(v, 4)] if z > 0 and not math.isnan(u) else None)
    return {
        "preset": preset,
        "lens": lens,
        "lensMm": focal,
        "fill": round(fill, 4),
        "centerY": center_y,
        "aimOffsetDeg": round(aim, 4),
        "distanceCm": round(dist, 3),
        "target": target,
        "poses": poses,
        "productBoxes": boxes,
        "anchorTracks": {"center": center_track, "top": top_track},
        "startAzDeg": az0,
    }


# ------------------------------------------------------------------------------------------ scale + place ----

#: plausible unit errors of an imported model: factor → explanation
UNIT_FACTORS = (
    (100.0, "model in metres read as centimetres (×100)"),
    (0.01, "model in centimetres scaled as metres (×0.01)"),
    (10.0, "model in decimetres / millimetre-cm mix-up (×10)"),
    (0.1, "model in millimetres read as centimetres (×0.1)"),
    (2.54, "model in inches read as centimetres (×2.54)"),
    (1.0 / 2.54, "model in centimetres read as inches (÷2.54)"),
)
MISMATCH_TOLERANCE = 0.10


def normalise_scale(measured_cm: Vec, expected_m: list[float] | None) -> dict:
    """Uniform scale that brings an imported model to the product's declared dimensions.

    The largest measured dimension is matched to the largest declared one (orientation-agnostic); a factor close to
    a classic unit error is named as such. Any size mismatch over 10 % is reported, and so are proportions that do
    not match the declaration (wrong model / lying on its side) — the model is rescaled to the declared size but the
    warnings travel with the clip so QA and the owner see them.
    """
    warnings: list[str] = []
    m = [float(v) for v in measured_cm]
    if min(m) < 0 or max(m) <= 1e-6:
        raise ValueError("the imported model has empty bounds")
    if expected_m is None:
        if max(m) < 0.5 or max(m) > 2000.0:
            warnings.append(f"imported model is {max(m):.2f} cm across and no real dimensions are declared: "
                            "check the export units")
        return {"scale": 1.0, "expectedCm": None, "mismatchPct": None, "unitCorrection": None,
                "warnings": warnings}
    e = [float(v) * 100.0 for v in expected_m]
    ratio = max(e) / max(m)
    mismatch = abs(ratio - 1.0)
    unit = None
    if mismatch > MISMATCH_TOLERANCE:
        for factor, why in UNIT_FACTORS:
            if abs(ratio / factor - 1.0) <= MISMATCH_TOLERANCE:
                unit = why
                break
    if unit is not None:
        warnings.append(f"unit error corrected: {unit}")
    elif mismatch > MISMATCH_TOLERANCE:
        warnings.append(f"model size differs from the declared dimensions by {mismatch * 100:.0f} % — "
                        "rescaled to the declared size; check the model")
    scaled = sorted(v * ratio for v in m)
    want = sorted(e)
    for k in range(3):
        if want[k] > 1e-6 and abs(scaled[k] / want[k] - 1.0) > MISMATCH_TOLERANCE:
            warnings.append("model proportions do not match the declared dimensions "
                            f"({', '.join(f'{v:.1f}' for v in scaled)} cm vs {', '.join(f'{v:.1f}' for v in want)} cm)")
            break
    else:
        if e[2] > 1e-6 and abs(m[2] * ratio / e[2] - 1.0) > MISMATCH_TOLERANCE:
            warnings.append(f"model height {m[2] * ratio:.1f} cm vs declared {e[2]:.1f} cm: is it lying on its side?")
    return {"scale": ratio, "expectedCm": [round(v, 3) for v in e], "mismatchPct": round(mismatch * 100.0, 2),
            "unitCorrection": unit, "warnings": warnings}


def placement(bounds_lo: Vec, bounds_hi: Vec, s: float) -> Vec:
    """Relative location of the product meshes under the pivot so the scaled bounds are centred on XY with the
    base on Z = 0 (bounds measured with the product's rotation applied and scale 1)."""
    cx = (bounds_lo[0] + bounds_hi[0]) / 2.0
    cy = (bounds_lo[1] + bounds_hi[1]) / 2.0
    return (-cx * s, -cy * s, -bounds_lo[2] * s)


def rotated_aabb(lo: Vec, hi: Vec, yaw_deg: float) -> tuple[Vec, Vec]:
    """World AABB of a local box rotated about Z by a UE yaw (the product's front correction)."""
    pts = [rotate_z(p, yaw_deg) for p in box_corners(lo, hi)]
    return (tuple(min(p[i] for p in pts) for i in range(3)),  # type: ignore[return-value]
            tuple(max(p[i] for p in pts) for i in range(3)))


def union_bounds(boxes: list[tuple[Vec, Vec]]) -> tuple[Vec, Vec]:
    """Union of (min, max) boxes."""
    if not boxes:
        raise ValueError("no bounds")
    lo = tuple(min(b[0][i] for b in boxes) for i in range(3))
    hi = tuple(max(b[1][i] for b in boxes) for i in range(3))
    return lo, hi  # type: ignore[return-value]


def import_front_yaw(fmt: str, interchange_fbx: bool) -> float:
    """Yaw that turns an imported product's front to +X.

    FBX through the legacy importer with Force Front X Axis: already +X (0°). FBX through Interchange (which does not
    take the legacy option) keeps the FBX −Y forward axis, i.e. the front lands on +Y → −90°. glTF goes through
    Interchange, whose axis conversion has not been verified against UE 5.8 here: 0° and a warning; the job's
    product.frontYawDeg corrects any remaining offset.
    """
    if fmt == "fbx":
        return -90.0 if interchange_fbx else 0.0
    return 0.0
