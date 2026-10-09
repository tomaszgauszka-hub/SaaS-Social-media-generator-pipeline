"""Pure camera math of the product studio (no bpy, stdlib only — unit-tested with python3 -m unittest).

Conventions (match Blender):
  * world is Z-up, the product stands centred on XY with its base on Z = 0;
  * the composed camera looks from the front (-Y) towards +Y — the shot's azimuth is applied by rotating the
    product, so sets and light rigs are always designed relative to the camera;
  * camera.sensor_fit = VERTICAL with a 36 mm sensor height: on a 9:16 frame the long side is a full-frame 36 mm;
  * lens shift is in units of the larger frame side (here the height), like Blender's shift_x / shift_y;
  * image coordinates are normalised, u to the right, v DOWN (0..1), the NormRect convention of the TS bridge.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

SENSOR_HEIGHT_MM = 36.0

Vec = tuple[float, float, float]


def add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale(a: Vec, s: float) -> Vec:
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def length(a: Vec) -> float:
    return math.sqrt(dot(a, a))


def normalize(a: Vec) -> Vec:
    n = length(a)
    if n < 1e-12:
        raise ValueError("cannot normalise a zero vector")
    return scale(a, 1.0 / n)


def rotate_z(p: Vec, deg: float) -> Vec:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2])


def direction(az_deg: float, el_deg: float) -> Vec:
    """Unit vector from the target towards the camera. az 0 = front (-Y), +90 = right (+X); el up."""
    az, el = math.radians(az_deg), math.radians(el_deg)
    return (math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))


@dataclass(frozen=True)
class Basis:
    """Camera axes in world space: Blender camera local X = right, local Y = up, local -Z = forward."""

    right: Vec
    up: Vec
    forward: Vec

    def matrix3(self) -> tuple[Vec, Vec, Vec]:
        """Rows of the 3x3 rotation matrix whose columns are (right, up, -forward)."""
        r, u, f = self.right, self.up, self.forward
        return ((r[0], u[0], -f[0]), (r[1], u[1], -f[1]), (r[2], u[2], -f[2]))


def look_at(cam: Vec, target: Vec) -> Basis:
    fwd = normalize(sub(target, cam))
    world_up: Vec = (0.0, 0.0, 1.0) if abs(fwd[2]) < 0.999 else (0.0, 1.0, 0.0)
    right = normalize(cross(fwd, world_up))
    up = cross(right, fwd)
    return Basis(right, up, fwd)


@dataclass(frozen=True)
class Lens:
    lens_mm: float
    width: int
    height: int
    shift_x: float = 0.0
    shift_y: float = 0.0
    sensor_height_mm: float = SENSOR_HEIGHT_MM

    @property
    def sensor_width_mm(self) -> float:
        return self.sensor_height_mm * self.width / self.height


def project(p: Vec, cam: Vec, basis: Basis, lens: Lens) -> tuple[float, float, float]:
    """(u, v, depth) — u right, v down, normalised to the frame; depth along the view axis (m)."""
    d = sub(p, cam)
    x, y, z = dot(d, basis.right), dot(d, basis.up), dot(d, basis.forward)
    if z <= 1e-9:
        return (math.nan, math.nan, z)
    big = max(lens.width, lens.height)
    u = 0.5 + (lens.lens_mm * x / z) / lens.sensor_width_mm - lens.shift_x * big / lens.width
    v = 0.5 - (lens.lens_mm * y / z) / lens.sensor_height_mm + lens.shift_y * big / lens.height
    return (u, v, z)


def project_box(points: list[Vec], cam: Vec, basis: Basis, lens: Lens) -> tuple[float, float, float, float]:
    """Projected bounds (u0, v0, u1, v1) of points in front of the camera."""
    us: list[float] = []
    vs: list[float] = []
    for p in points:
        u, v, z = project(p, cam, basis, lens)
        if z > 1e-9:
            us.append(u)
            vs.append(v)
    if not us:
        raise ValueError("no point in front of the camera")
    return (min(us), min(vs), max(us), max(vs))


def bounds(points: list[Vec]) -> tuple[Vec, Vec]:
    xs, ys, zs = zip(*points)
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


@dataclass(frozen=True)
class Fit:
    distance: float
    camera: Vec
    target: Vec
    basis: Basis
    shift_x: float
    shift_y: float
    elevation_deg: float
    #: projected focus box after the shift (u0, v0, u1, v1)
    box: tuple[float, float, float, float]

    @property
    def focus_distance(self) -> float:
        return dot(sub(self.target, self.camera), self.basis.forward)


def _extent(points: list[Vec], target: Vec, dirv: Vec, d: float, lens: Lens) -> tuple[float, float, float, float]:
    cam = add(target, scale(dirv, d))
    return project_box(points, cam, look_at(cam, target), lens)


def _solve(f, lo: float, hi: float, goal: float, iters: int = 42) -> float:
    """Bisection for f(d) == goal where f decreases with d (projected size shrinks with distance)."""
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if f(mid) > goal:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def fit_camera(
    points: list[Vec],
    target: Vec,
    az_deg: float,
    el_deg: float,
    lens_mm: float,
    width: int,
    height: int,
    fill: float,
    center: tuple[float, float] = (0.5, 0.5),
    max_width: float | None = 0.92,
) -> Fit:
    """Camera on the ray (az, el) from `target` so the points span `fill` of the frame height (and at most
    `max_width` of its width), then lens-shifted so their projected box is centred on `center`."""
    if not points:
        raise ValueError("fit_camera needs points")
    lens = Lens(lens_mm, width, height)
    dirv = direction(az_deg, el_deg)
    radius = max(length(sub(p, target)) for p in points)
    lo = max(radius * 1.05, 1e-3)
    hi = lo * 4
    vert = lambda d: (lambda b: b[3] - b[1])(_extent(points, target, dirv, d, lens))  # noqa: E731
    horiz = lambda d: (lambda b: b[2] - b[0])(_extent(points, target, dirv, d, lens))  # noqa: E731
    while vert(hi) > fill and hi < radius * 1e4:
        hi *= 2
    d = lo if vert(lo) <= fill else _solve(vert, lo, hi, fill)
    if max_width is not None and horiz(d) > max_width:
        hi2 = d * 2
        while horiz(hi2) > max_width and hi2 < radius * 1e4:
            hi2 *= 2
        d = _solve(horiz, d, hi2, max_width)
    cam = add(target, scale(dirv, d))
    basis = look_at(cam, target)
    u0, v0, u1, v1 = project_box(points, cam, basis, lens)
    big = max(width, height)
    shift_x = ((u0 + u1) / 2 - center[0]) * width / big
    shift_y = (center[1] - (v0 + v1) / 2) * height / big
    shifted = Lens(lens_mm, width, height, shift_x, shift_y)
    return Fit(d, cam, target, basis, shift_x, shift_y, el_deg, project_box(points, cam, basis, shifted))


def fit_at_height(
    points: list[Vec],
    target: Vec,
    az_deg: float,
    camera_z: float,
    lens_mm: float,
    width: int,
    height: int,
    fill: float,
    center: tuple[float, float] = (0.5, 0.5),
    max_width: float | None = 0.92,
) -> Fit:
    """Like fit_camera, but the elevation is solved so the fitted camera sits at `camera_z` (a few
    fixed-point iterations: the distance depends on the elevation and vice versa)."""
    el = 0.0
    fit = fit_camera(points, target, az_deg, el, lens_mm, width, height, fill, center, max_width)
    for _ in range(8):
        s = max(-0.94, min(0.97, (camera_z - target[2]) / fit.distance))
        nel = math.degrees(math.asin(s))
        if abs(nel - el) < 0.01:
            break
        el = nel
        fit = fit_camera(points, target, az_deg, el, lens_mm, width, height, fill, center, max_width)
    return fit


def frame_height_at(distance: float, lens_mm: float, sensor_height_mm: float = SENSOR_HEIGHT_MM) -> float:
    """World height covered by the frame at `distance` (m)."""
    return distance * sensor_height_mm / lens_mm


def plate_lens(lens: Lens, overscan: float) -> Lens:
    """The plate camera: same optical axis, `overscan` x wider field and resolution, shift rescaled so the
    composed frame is exactly the central 1/overscan of the plate."""
    return Lens(
        lens.lens_mm,
        int(round(lens.width * overscan)),
        int(round(lens.height * overscan)),
        lens.shift_x / overscan,
        lens.shift_y / overscan,
        lens.sensor_height_mm * overscan,
    )


def subsample(points: list[Vec], limit: int) -> list[Vec]:
    """Deterministic stride subsample that always keeps the extreme points of each axis."""
    if len(points) <= limit:
        return list(points)
    stride = len(points) / float(limit)
    out = [points[int(i * stride)] for i in range(limit)]
    for axis in range(3):
        out.append(min(points, key=lambda p: p[axis]))
        out.append(max(points, key=lambda p: p[axis]))
    return out


def emitter_spot(points: list[Vec], height: float) -> tuple[Vec, float]:
    """Where a light-emitting product's bulb sits, from its geometry: inside the widest upper section
    (a lamp's shade), 42 % up that section. Returns (position, soft radius)."""
    if not points or height <= 0:
        return ((0.0, 0.0, 0.6 * max(height, 0.0)), 0.01)
    upper = [p for p in points if p[2] >= 0.3 * height]
    radius = max((math.hypot(p[0], p[1]) for p in upper), default=0.0)
    wide = [p for p in upper if math.hypot(p[0], p[1]) >= 0.6 * radius] if radius > 1e-6 else []
    if not wide:
        return ((0.0, 0.0, 0.6 * height), max(0.004, 0.05 * height))
    z0 = min(p[2] for p in wide)
    z1 = max(p[2] for p in wide)
    if z1 - z0 < 0.04 * height:  # a flat disc, not a shade: the light sits just below it
        return ((0.0, 0.0, max(0.0, z0 - 0.06 * height)), max(0.004, 0.12 * radius))
    return ((0.0, 0.0, z0 + 0.42 * (z1 - z0)), max(0.004, 0.15 * radius))
