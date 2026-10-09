"""Six lighting presets + the product's own light (bpy).

Lights are placed relative to the camera (the composed camera always looks from the front, -Y) and to the
shot's focus target, in units of the product size S. Every light is specified by the irradiance it delivers at
the target (W/m²), so the exposure is the same for a 5 cm earring and a 2 m floor lamp: power is derived from
the distance (and the emitter area). Inside rooms a light that would end up behind a wall is pulled in along
its ray and its power rescaled.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import bpy
from mathutils import Matrix

import framing

NEUTRAL_K = 6500.0


@dataclass(frozen=True)
class LightSpec:
    role: str  # key | fill | rim | accent | sweep
    kind: str  # AREA | SPOT | SUN
    az: float  # deg around the target (0 = from the camera, +90 = camera right, 180 = behind)
    el: float  # deg above the target
    dist: float  # x S
    irradiance: float  # W/m² at the target for level 1
    size: tuple[float, float] = (1.0, 1.0)  # x S (area lights)
    kelvin: float = NEUTRAL_K
    spot_deg: float = 30.0
    blend: float = 0.5
    spread_deg: float = 180.0


def _strip(role: str, az: float, el: float, dist: float, e: float, kelvin: float = NEUTRAL_K) -> LightSpec:
    return LightSpec(role, "AREA", az, el, dist, e, (0.3, 2.2), kelvin, spread_deg=70.0)


RIGS: dict[str, list[LightSpec]] = {
    "three_point": [
        LightSpec("key", "AREA", -45, 35, 3.2, 2.4, (1.4, 1.4)),
        LightSpec("fill", "AREA", 55, 12, 3.6, 0.7, (2.6, 2.6)),
        _strip("rim", 155, 28, 2.6, 2.2),
    ],
    "rim_dramatic": [
        LightSpec("key", "AREA", -10, 55, 3.0, 0.5, (1.0, 1.0)),
        _strip("rim", -140, 15, 2.4, 3.6),
        _strip("rim", 140, 15, 2.4, 3.6),
        LightSpec("fill", "AREA", 60, 5, 3.6, 0.06, (2.6, 2.6)),
    ],
    "soft_box": [
        LightSpec("key", "AREA", -15, 62, 3.2, 2.6, (3.6, 3.6)),
        LightSpec("fill", "AREA", 40, 5, 3.4, 1.2, (3.0, 3.0)),
        _strip("rim", 180, 35, 2.6, 0.9),
    ],
    "window_daylight": [
        LightSpec("key", "SUN", -72, 24, 1.0, 3.2, kelvin=5400.0),
        LightSpec("fill", "AREA", -60, 20, 4.0, 0.8, (4.0, 4.0), kelvin=9500.0),
        LightSpec("rim", "AREA", 80, 10, 3.0, 0.35, (2.4, 2.4), kelvin=4800.0),
    ],
    "warm_practical": [
        LightSpec("key", "AREA", -60, 14, 3.0, 1.4, (1.2, 1.2), kelvin=3800.0),
        LightSpec("fill", "AREA", 60, 10, 3.4, 0.25, (2.5, 2.5), kelvin=6500.0),
        _strip("rim", 150, 25, 2.6, 1.3, kelvin=3200.0),
    ],
    "top_spot": [
        LightSpec("key", "SPOT", 0, 82, 3.4, 4.0, spot_deg=34.0, blend=0.55),
        _strip("rim", 165, 30, 2.6, 1.3),
        LightSpec("fill", "AREA", 40, 10, 3.6, 0.12, (2.6, 2.6)),
    ],
}

#: present in every rig at level 0 unless a shot raises it
EXTRAS = [
    LightSpec("accent", "SPOT", -25, 38, 2.6, 2.2, spot_deg=18.0, blend=0.7),
    LightSpec("sweep", "AREA", 0, 8, 2.2, 3.4, (0.22, 2.8), spread_deg=60.0),
]

SWEEP_AZ = 80.0


@dataclass
class RigLight:
    spec: LightSpec
    obj: bpy.types.Object
    #: energy (W, or sun strength) at level 1 after placement
    energy: float = 0.0


@dataclass
class Rig:
    preset: str
    lights: list[RigLight] = field(default_factory=list)


def _place(spec: LightSpec, target: framing.Vec, size: float, az: float | None,
           interior: tuple[float, float, float, float, float] | None) -> tuple[framing.Vec, float]:
    """Position of a light and its distance to the target (pulled inside the room walls)."""
    d = framing.direction(spec.az if az is None else az, spec.el)
    dist = spec.dist * size
    if interior is not None:
        x0, x1, y0, y1, z1 = interior
        for _ in range(40):
            p = framing.add(target, framing.scale(d, dist))
            if x0 <= p[0] <= x1 and y0 <= p[1] <= y1 and p[2] <= z1:
                break
            dist *= 0.92
    return framing.add(target, framing.scale(d, dist)), dist


def _orient(obj: bpy.types.Object, pos: framing.Vec, target: framing.Vec) -> None:
    b = framing.look_at(pos, target)
    r, u, f = b.right, b.up, b.forward
    obj.matrix_world = Matrix(((r[0], u[0], -f[0], pos[0]), (r[1], u[1], -f[1], pos[1]),
                               (r[2], u[2], -f[2], pos[2]), (0, 0, 0, 1)))


class Lighting:
    """Builds rigs lazily (one per preset used by the job) and drives their levels per frame."""

    def __init__(self, size: float, interior, light_mult: float):
        self.size = size
        self.interior = interior
        self.mult = light_mult
        self.rigs: dict[str, Rig] = {}
        self.active: Rig | None = None
        self.target: framing.Vec = (0.0, 0.0, 0.0)
        self.dim = 1.0

    def _make(self, preset: str) -> Rig:
        rig = Rig(preset)
        for k, spec in enumerate(RIGS[preset] + EXTRAS):
            data = bpy.data.lights.new(f"{preset}.{spec.role}.{k}", spec.kind)
            data.use_temperature = True
            data.temperature = spec.kelvin
            data.use_shadow = True
            if spec.kind == "AREA":
                data.shape = "RECTANGLE"
                data.size = spec.size[0] * self.size
                data.size_y = spec.size[1] * self.size
                data.spread = math.radians(spec.spread_deg)
            elif spec.kind == "SPOT":
                data.spot_size = math.radians(spec.spot_deg)
                data.spot_blend = spec.blend
                data.shadow_soft_size = 0.05 * self.size
            elif spec.kind == "SUN":
                data.angle = math.radians(3.0)
            obj = bpy.data.objects.new(data.name, data)
            bpy.context.scene.collection.objects.link(obj)
            obj.hide_render = True
            rig.lights.append(RigLight(spec, obj))
        return rig

    def activate(self, preset: str, target: framing.Vec, dim: float = 1.0) -> Rig:
        """Use `preset` for the next shot, aimed at the shot's focus target; other rigs are switched off."""
        if preset not in self.rigs:
            self.rigs[preset] = self._make(preset)
        for name, rig in self.rigs.items():
            for light in rig.lights:
                light.obj.hide_render = name != preset
        rig = self.rigs[preset]
        self.active, self.target, self.dim = rig, target, dim
        for light in rig.lights:
            self._aim(light, None)
        return rig

    def _aim(self, light: RigLight, az: float | None) -> None:
        spec = light.spec
        pos, dist = _place(spec, self.target, self.size, az, self.interior)
        _orient(light.obj, pos, self.target)
        if spec.kind == "SUN":
            light.energy = spec.irradiance
        elif spec.kind == "AREA":
            a2 = spec.size[0] * spec.size[1] * self.size * self.size / math.pi
            light.energy = spec.irradiance * math.pi * (dist * dist + a2)
        else:
            light.energy = spec.irradiance * 4.0 * math.pi * dist * dist

    def set_levels(self, key: float, fill: float, rim: float, accent: float, sweep: float | None,
                   frame: int | None = None) -> None:
        """Light levels for one frame (keyframed when `frame` is given — motion blur)."""
        assert self.active is not None
        levels = {"key": key, "fill": fill, "rim": rim, "accent": accent, "sweep": 0.0 if sweep is None else 1.0}
        for light in self.active.lights:
            if light.spec.role == "sweep" and sweep is not None:
                self._aim(light, SWEEP_AZ * sweep)
            level = levels[light.spec.role]
            light.obj.data.energy = light.energy * level * self.mult * (1.0 if light.spec.role == "accent"
                                                                         else self.dim)
            if frame is not None:
                light.obj.keyframe_insert("location", frame=frame)
                light.obj.keyframe_insert("rotation_euler", frame=frame)
                light.obj.data.keyframe_insert("energy", frame=frame)

    def static_roles_off(self, accent_used: bool, sweep_used: bool) -> None:
        """Hide lights a whole shot never uses (no sampling cost)."""
        assert self.active is not None
        for light in self.active.lights:
            if light.spec.role == "accent" and not accent_used:
                light.obj.hide_render = True
            if light.spec.role == "sweep" and not sweep_used:
                light.obj.hide_render = True


def product_light(pivot: bpy.types.Object, position: framing.Vec, height: float) -> tuple[bpy.types.Object, float]:
    """A warm point light inside the product (a lamp's bulb), parented to the product so it moves with it.
    Returns the object and its energy at level 1 (W)."""
    data = bpy.data.lights.new("ProductLight", "POINT")
    data.use_temperature = True
    data.temperature = 2700.0
    data.shadow_soft_size = max(0.004, 0.03 * height)
    data.use_shadow = True
    obj = bpy.data.objects.new("ProductLight", data)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = pivot
    obj.location = position
    # ~8 W/m² at 0.75 × the product height from the bulb: with the studio rig at RELIGHT_DIM the lamp clearly
    # lights its base and the surface under it (tuned on the walnut lamp in warm_living / bright_minimal)
    energy = 8.0 * 4.0 * math.pi * (0.75 * height) ** 2
    data.energy = 0.0
    return obj, energy
