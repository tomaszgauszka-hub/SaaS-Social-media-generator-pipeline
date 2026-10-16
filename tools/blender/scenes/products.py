"""Products for the scene generators: parametric DEMO models (with a real, named part structure) and imported
model files (catalog / manufacturer models, through the studio's product_import).

A procedural product is a FICTIONAL_DEMO model: its geometry follows the demo product data already in the repo
(packages/creative/src/benchmark/briefs.ts — the 20V drill/driver kit and the Mineral Sun Fluid SPF 50 tube), its
part structure is its own by construction, and every clip made from it is DEMO_ONLY. It must never stand in for
a real product.

Every product exposes the same interface to the scene builder:
    pivot (animated root), parts {name: Part}, points / surface (pivot space), height, radius,
    actions {kind: callable(progress, frame)}, anchors {name: (x, y, z)}.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from typing import Callable

import bpy
import numpy as np
from mathutils import Vector

import modeling as m

Vec = tuple[float, float, float]

GENERATOR_VERSION = {"drill_driver_20v": 1, "cosmetic_tube": 1}


@dataclass
class Part:
    name: str
    objs: list[bpy.types.Object]
    #: the empty that carries the part's animation (explode / assembly / action transforms)
    handle: bpy.types.Object
    role: str  # body | control | detail | accessory | internal
    explode: Vec = (0.0, 0.0, 0.0)
    order: int = 0
    anchor: Vec = (0.0, 0.0, 0.0)
    internal: bool = False
    verified: bool = True


@dataclass
class SceneProduct:
    kind: str  # procedural | file
    name: str
    pivot: bpy.types.Object
    parts: dict[str, Part]
    meshes: list[bpy.types.Object]
    height: float
    radius: float
    points: np.ndarray
    surface: np.ndarray | None
    anchors: dict[str, Vec] = field(default_factory=dict)
    actions: dict[str, Callable[[float, int], None]] = field(default_factory=dict)
    #: materials whose x-ray reveal the TECHNICAL template animates
    reveal_materials: list[bpy.types.Material] = field(default_factory=list)
    generator_version: int = 0
    model: object | None = None  # studio ProductModel for imported files

    @property
    def size(self) -> float:
        return max(self.height, 2.0 * self.radius, 1e-3)

    def part_points(self, name: str) -> np.ndarray:
        objs = self.parts[name].objs
        pts = [_object_points(o) for o in objs]
        pts = [p for p in pts if len(p)]
        return np.concatenate(pts) if pts else np.zeros((0, 3))


def _object_points(obj: bpy.types.Object) -> np.ndarray:
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        n = len(me.vertices)
        co = np.empty(n * 3, dtype=np.float64)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        mw = np.array(obj.matrix_world)
        return co @ mw[:3, :3].T + mw[:3, 3]
    finally:
        ev.to_mesh_clear()


def _surface_samples(meshes: list[bpy.types.Object], n: int = 6000) -> np.ndarray | None:
    tris = []
    dg = bpy.context.evaluated_depsgraph_get()
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            me.calc_loop_triangles()
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            idx = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
            me.loop_triangles.foreach_get("vertices", idx)
            mw = np.array(o.matrix_world)
            w = co @ mw[:3, :3].T + mw[:3, 3]
            tris.append(w[idx.reshape(-1, 3)])
        finally:
            ev.to_mesh_clear()
    if not tris:
        return None
    t = np.concatenate(tris)
    area = 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
    if area.sum() <= 0:
        return None
    rng = np.random.default_rng(7)
    pick = rng.choice(len(t), size=n, p=area / area.sum())
    a, b = rng.random(n), rng.random(n)
    flip = a + b > 1
    a[flip], b[flip] = 1 - a[flip], 1 - b[flip]
    tt = t[pick]
    return tt[:, 0] + a[:, None] * (tt[:, 1] - tt[:, 0]) + b[:, None] * (tt[:, 2] - tt[:, 0])


def _new_empty(name: str, loc: Vec, parent: bpy.types.Object | None) -> bpy.types.Object:
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    e.empty_display_size = 0.01
    if parent is not None:
        e.parent = parent
    e.location = loc
    e["rest"] = list(loc)
    return e


class _Builder:
    """Collects objects into named parts; each part hangs under its own handle empty (placed at `pivot_at`, the
    point the part rotates about) below the product pivot."""

    def __init__(self, name: str):
        self.pivot = _new_empty("ProductPivot", (0.0, 0.0, 0.0), None)
        self.pivot["product"] = name
        self.parts: dict[str, Part] = {}

    def part(self, name: str, objs: list[bpy.types.Object], *, role: str, pivot_at: Vec,
             explode: Vec = (0.0, 0.0, 0.0), order: int = 0, anchor: Vec | None = None,
             internal: bool = False) -> Part:
        handle = _new_empty(f"Part.{name}", pivot_at, self.pivot)
        bpy.context.view_layer.update()  # matrix_world of fresh objects / the handle is stale until updated
        for o in objs:
            mw = o.matrix_world.copy()
            o.parent = handle
            o.matrix_world = mw
            o["part"] = name
        p = Part(name, objs, handle, role, explode, order, anchor or pivot_at, internal)
        self.parts[name] = p
        return p

    def finish(self, name: str, anchors: dict[str, Vec], version: int) -> SceneProduct:
        bpy.context.view_layer.update()
        meshes = [o for p in self.parts.values() for o in p.objs if o.type == "MESH"]
        visible = [o for p in self.parts.values() if not p.internal for o in p.objs if o.type == "MESH"]
        pts = np.concatenate([_object_points(o) for o in visible])
        height = float(pts[:, 2].max())
        radius = float(np.hypot(pts[:, 0], pts[:, 1]).max())
        return SceneProduct("procedural", name, self.pivot, self.parts, meshes, height, radius, pts,
                            _surface_samples(visible), anchors, generator_version=version)


def _rotate_handle(part: Part, axis: int, angle: float, frame: int) -> None:
    rot = [0.0, 0.0, 0.0]
    rot[axis] = angle
    part.handle.rotation_euler = rot
    part.handle.keyframe_insert("rotation_euler", frame=frame)


def _offset_handle(part: Part, delta: Vec, frame: int) -> None:
    rest = part.handle["rest"]
    part.handle.location = (rest[0] + delta[0], rest[1] + delta[1], rest[2] + delta[2])
    part.handle.keyframe_insert("location", frame=frame)


# ------------------------------------------------------------------------------------ 20V drill / driver ----


def drill_driver_20v(params: dict) -> SceneProduct:
    """Cordless drill/driver (demo): 20 V slide battery, 13 mm keyless chuck, 2-speed gearbox selector,
    21 + 1 clutch ring, variable-speed trigger, forward/reverse switch, LED work light at the foot.
    Bit points along −X, battery on the floor (Z = 0). Metres."""
    body_c = params.get("body_color", "#2A2D32")
    accent_c = params.get("accent_color", "#E39B26")
    b = _Builder("drill_driver_20v")
    axis_z = 0.203  # motor axis height

    graphite = m.two_tone("Drill.Housing", body_c, accent_c, 2, axis_z + 0.028, axis_z + 0.05,
                          roughness=0.42, coat=0.25, accent_roughness=0.3, texture=0.12)
    graphite_plain = m.plastic("Drill.Graphite", body_c, 0.45, coat=0.2, texture=0.12)
    amber = m.plastic("Drill.Amber", accent_c, 0.32, coat=0.35)
    rubber = m.rubber("Drill.Rubber", "#17181A")
    gloss_black = m.plastic("Drill.GlossBlack", "#0D0E10", 0.18, coat=0.6)
    chrome = m.metal("Drill.Chrome", "#D9DCE0", 0.12)
    steel = m.metal("Drill.Steel", "#A8ACB2", 0.28, anisotropic=0.4)
    copper = m.metal("Drill.Copper", "#B8723A", 0.3)
    dark_steel = m.metal("Drill.DarkSteel", "#4A4E55", 0.35)
    led_mat = m.emissive_lens("Drill.LED", "#F6F4EE", "#FFF3D6")
    gauge_mat = m.emissive_lens("Drill.Gauge", "#2C3A2F", "#55FF7A")

    # housing (motor body): oval surface of revolution around X
    housing_prof = [(-0.026, 0.0), (-0.026, 0.027), (-0.022, 0.031), (-0.012, 0.0335), (0.02, 0.0355),
                    (0.075, 0.0355), (0.098, 0.034), (0.112, 0.029), (0.12, 0.02), (0.1235, 0.009), (0.124, 0.0)]
    housing = m.revolve("Drill.Housing", housing_prof, axis="X", segments=72, squash=0.9,
                        origin=(0.0, 0.0, axis_z), mat=graphite, cap_start=False, cap_end=False)
    vents = []
    for k in range(5):
        for side in (-1, 1):
            vents.append(m.rounded_box(f"Drill.Vent.{k}.{side}", (0.0032, 0.004, 0.022),
                                       (0.084 + 0.0068 * k, side * 0.0298, axis_z), bevel=0.0012,
                                       mat=gloss_black))
    # handle: lofted oval sections from the foot up into the housing, leaning back toward the battery
    handle_secs = []
    for t in np.linspace(0.0, 1.0, 9):
        z = 0.078 + t * (axis_z - 0.078)
        cx = 0.044 - 0.026 * t
        waist = 1.0 - 0.13 * math.sin(math.pi * min(1.0, t * 1.1))
        handle_secs.append(m.Section((cx, 0.0, z), 0.0315 * waist, 0.0262 * waist, 2.5))
    handle = m.loft("Drill.Handle", handle_secs, segments=40, mat=rubber)
    foot = m.rounded_box("Drill.Foot", (0.118, 0.07, 0.03), (0.03, 0.0, 0.073), bevel=0.011, mat=graphite_plain)
    foot_band = m.rounded_box("Drill.FootBand", (0.12, 0.0715, 0.006), (0.03, 0.0, 0.0605), bevel=0.0025, mat=amber)
    switch = m.cylinder("Drill.DirectionSwitch", 0.0058, 0.073, (0.004, 0.0, 0.171), axis="Y", segments=32,
                        mat=amber, bevel=0.0015)
    trigger = m.rounded_box("Drill.Trigger", (0.017, 0.018, 0.036), (-0.009, 0.0, 0.143), bevel=0.0068,
                            mat=gloss_black, rot=(0.0, math.radians(-14), 0.0))
    selector = m.rounded_box("Drill.GearSelector", (0.026, 0.014, 0.009), (0.034, 0.0, axis_z + 0.0335),
                             bevel=0.004, mat=amber)
    clutch = m.revolve("Drill.Clutch", [(-0.049, 0.0285), (-0.047, 0.0318), (-0.031, 0.0325), (-0.027, 0.0305),
                                        (-0.0255, 0.027)], axis="X", segments=88, ribs=22, rib_depth=0.07,
                       rib_span=(-0.048, -0.028), origin=(0.0, 0.0, axis_z), mat=rubber, cap_start=False,
                       cap_end=False)
    clutch_mark = m.rounded_box("Drill.ClutchMark", (0.012, 0.003, 0.0034), (-0.038, 0.0, axis_z + 0.0326),
                                bevel=0.001, mat=amber)
    chuck = m.revolve("Drill.Chuck", [(-0.0905, 0.0), (-0.0905, 0.0135), (-0.0885, 0.0168), (-0.081, 0.0205),
                                      (-0.066, 0.0232), (-0.052, 0.0236), (-0.0495, 0.0222), (-0.0495, 0.0)],
                      axis="X", segments=96, ribs=36, rib_depth=0.05, rib_span=(-0.08, -0.053),
                      origin=(0.0, 0.0, axis_z), mat=gloss_black)
    nose = m.revolve("Drill.ChuckNose", [(-0.0995, 0.0), (-0.0995, 0.0085), (-0.098, 0.0102), (-0.0915, 0.0128),
                                         (-0.09, 0.0)], axis="X", segments=64, origin=(0.0, 0.0, axis_z),
                     mat=chrome)
    shank = m.revolve("Drill.BitShank", [(-0.0985, 0.0036), (-0.128, 0.0036)], axis="X", segments=6,
                      origin=(0.0, 0.0, axis_z), mat=steel, smooth=False)
    tip = m.revolve("Drill.BitTip", [(-0.128, 0.0036), (-0.131, 0.0033), (-0.139, 0.0022), (-0.143, 0.0009),
                                     (-0.1445, 0.0)], axis="X", segments=48, ribs=4, rib_depth=0.55,
                    rib_span=(-0.145, -0.13), origin=(0.0, 0.0, axis_z), mat=steel, cap_start=False)
    battery = m.rounded_box("Drill.Battery", (0.128, 0.078, 0.058), (0.036, 0.0, 0.029), bevel=0.012,
                            mat=graphite_plain)
    battery_grip = [m.rounded_box(f"Drill.BatteryRib.{k}.{s}", (0.08, 0.0025, 0.0028),
                                  (0.04, s * 0.0392, 0.016 + 0.0085 * k), bevel=0.001, mat=rubber)
                    for k in range(3) for s in (-1, 1)]
    release = m.rounded_box("Drill.BatteryRelease", (0.006, 0.034, 0.012), (-0.0295, 0.0, 0.047), bevel=0.0025,
                            mat=amber)
    gauge = [m.rounded_box(f"Drill.GaugeLED.{k}", (0.003, 0.0055, 0.0034), (0.1003, -0.01 + 0.01 * k, 0.036),
                           bevel=0.0009, mat=gauge_mat) for k in range(3)]
    gauge_btn = m.rounded_box("Drill.GaugeButton", (0.003, 0.009, 0.006), (0.1003, 0.0, 0.024), bevel=0.0012,
                              mat=gloss_black)
    led = m.cylinder("Drill.LED", 0.0062, 0.004, (-0.0285, 0.0, 0.08), axis="X", segments=40, mat=led_mat,
                     bevel=0.001)
    led.rotation_euler = (0.0, math.radians(28), 0.0)
    led_ring = m.revolve("Drill.LEDRing", [(-0.0012, 0.0062), (-0.0012, 0.0082), (0.0012, 0.0082)], axis="X",
                         segments=40, origin=(-0.0285, 0.0, 0.08), mat=chrome, cap_start=False, cap_end=False)
    led_ring.rotation_euler = (0.0, math.radians(28), 0.0)
    # internals (technical visualisation only; never visible otherwise): motor and planetary gearbox
    motor = m.cylinder("Drill.Motor", 0.0225, 0.068, (0.072, 0.0, axis_z), axis="X", segments=48, mat=copper)
    motor_can = m.cylinder("Drill.MotorCan", 0.0235, 0.012, (0.11, 0.0, axis_z), axis="X", segments=48,
                           mat=dark_steel, bevel=0.002)
    gearbox = m.revolve("Drill.Gearbox", [(-0.024, 0.0), (-0.024, 0.021), (0.036, 0.0245), (0.036, 0.0)], axis="X",
                        segments=48, ribs=12, rib_depth=0.05, origin=(0.0, 0.0, axis_z), mat=dark_steel)

    for o in (handle, housing, chuck, clutch, battery):
        m.add_subsurf(o, 1)
    hz = axis_z
    b.part("housing", [housing, handle, foot, foot_band, *vents], role="body", pivot_at=(0.03, 0.0, 0.12),
           order=0, anchor=(0.06, 0.0, hz + 0.02))
    b.part("battery", [battery, *battery_grip, release], role="accessory", pivot_at=(0.036, 0.0, 0.029),
           explode=(0.0, 0.0, -0.11), order=1, anchor=(0.036, -0.039, 0.03))
    b.part("charge_gauge", [*gauge, gauge_btn], role="detail", pivot_at=(0.1003, 0.0, 0.03),
           explode=(0.0, 0.0, -0.11), order=1, anchor=(0.1003, 0.0, 0.032))
    b.part("clutch", [clutch, clutch_mark], role="control", pivot_at=(-0.038, 0.0, hz),
           explode=(-0.034, 0.0, 0.012), order=3, anchor=(-0.038, 0.0, hz + 0.03))
    b.part("chuck", [chuck, nose], role="detail", pivot_at=(-0.07, 0.0, hz), explode=(-0.068, 0.0, 0.03),
           order=4, anchor=(-0.07, 0.0, hz + 0.012))
    b.part("bit", [shank, tip], role="accessory", pivot_at=(-0.12, 0.0, hz), explode=(-0.11, 0.0, 0.05),
           order=5, anchor=(-0.138, 0.0, hz))
    b.part("trigger", [trigger], role="control", pivot_at=(-0.009, 0.0, 0.143), explode=(-0.04, 0.0, -0.025),
           order=2, anchor=(-0.016, 0.0, 0.145))
    b.part("direction_switch", [switch], role="control", pivot_at=(0.004, 0.0, 0.171),
           explode=(0.0, 0.07, 0.0), order=2, anchor=(0.004, 0.037, 0.171))
    b.part("gear_selector", [selector], role="control", pivot_at=(0.034, 0.0, hz + 0.0335),
           explode=(0.0, 0.0, 0.065), order=2, anchor=(0.034, 0.0, hz + 0.037))
    b.part("led", [led, led_ring], role="detail", pivot_at=(-0.0285, 0.0, 0.08), explode=(-0.04, 0.0, -0.03),
           order=2, anchor=(-0.031, 0.0, 0.081))
    b.part("motor", [motor, motor_can], role="internal", pivot_at=(0.078, 0.0, hz), internal=True, order=0)
    b.part("gearbox", [gearbox], role="internal", pivot_at=(0.006, 0.0, hz), internal=True, order=0)
    for name in ("motor", "gearbox"):
        for o in b.parts[name].objs:
            o.hide_render = True
            o.hide_viewport = True

    prod = b.finish("drill_driver_20v", {k: p.anchor for k, p in b.parts.items()}, GENERATOR_VERSION["drill_driver_20v"])
    parts = prod.parts
    prod.reveal_materials = [graphite]

    def trigger_press(p: float, frame: int) -> None:
        _offset_handle(parts["trigger"], (0.0075 * p, 0.0, 0.0), frame)

    spin_state = {"angle": 0.0, "last": None}

    def chuck_spin(p: float, frame: int) -> None:
        # p is the motor speed (0–1); the angle integrates it: ~2.2 visible turns/s at full speed
        last = spin_state["last"]
        dt = 0.0 if last is None else (frame - last) / bpy.context.scene.render.fps
        spin_state["last"] = frame
        spin_state["angle"] += p * 2.2 * 2 * math.pi * dt
        for name in ("chuck", "bit", "motor", "gearbox"):
            _rotate_handle(parts[name], 0, spin_state["angle"], frame)

    def led_on(p: float, frame: int) -> None:
        m.keyframe_emission(led_mat, 18.0 * p, frame)

    def clutch_turn(p: float, frame: int) -> None:
        _rotate_handle(parts["clutch"], 0, -p * 2 * math.pi * 9 / 22, frame)

    def gear_shift(p: float, frame: int) -> None:
        _offset_handle(parts["gear_selector"], (-0.009 * p, 0.0, 0.0), frame)

    prod.actions = {"TRIGGER_PRESS": trigger_press, "CHUCK_SPIN": chuck_spin, "LED_ON": led_on,
                    "CLUTCH_TURN": clutch_turn, "GEAR_SHIFT": gear_shift}
    prod.anchors["gauge"] = (0.1003, 0.0, 0.032)
    m.keyframe_emission(gauge_mat, 0.0, 1)
    m.keyframe_emission(led_mat, 0.0, 1)
    return prod


# ----------------------------------------------------------------------------------------- cosmetic tube ----


def cosmetic_tube(params: dict) -> SceneProduct:
    """Mineral sunscreen fluid tube (demo, 50 ml): stands on its flip-top cap, oval body flattening into a
    serrated crimp seal. The print is a colour band only — product names, claims and SPF copy are text slots of
    the 2D layer, never baked into the 3D clip."""
    base_c = params.get("tube_color", "#F2ECE3")
    band_c = params.get("band_color", "#E8774F")
    band2_c = params.get("band2_color", "#F2B07A")
    cap_c = params.get("cap_color", "#E8774F")
    b = _Builder("cosmetic_tube")
    cap_h = 0.021
    body_top = 0.132

    tube_mat = m.banded_label("Tube.Print", base_c, band_c, band2_c, 2, cap_h + 0.012, body_top - 0.01,
                              roughness=0.3, coat=0.55, line=params.get("line_color", "#C9A26A"))
    crimp_mat = m.plastic("Tube.Crimp", base_c, 0.36, coat=0.3)
    cap_mat = m.plastic("Tube.Cap", cap_c, 0.22, coat=0.7)
    hinge_mat = m.plastic("Tube.Hinge", "#B85A3B", 0.35, coat=0.2)

    # body: round shoulder above the cap, flattening toward the seal
    secs = []
    for t in np.linspace(0.0, 1.0, 22):
        z = cap_h + 0.004 + t * (body_top - cap_h - 0.004)
        s = t ** 1.25
        ru = 0.0196 + (0.0262 - 0.0196) * s
        rv = 0.0196 + (0.0013 - 0.0196) * (s ** 0.9)
        secs.append(m.Section((0.0, 0.0, z), ru, max(rv, 0.0013), 2.0 + 0.6 * s))
    body = m.loft("Tube.Body", secs, segments=64, mat=tube_mat, cap_start=True, cap_end=False)
    shoulder = m.revolve("Tube.Shoulder", [(cap_h - 0.0005, 0.0), (cap_h - 0.0005, 0.0172), (cap_h + 0.002, 0.0188),
                                           (cap_h + 0.0045, 0.0196)], axis="Z", segments=64, mat=crimp_mat,
                         cap_end=False)
    crimp = m.rounded_box("Tube.Crimp", (0.0545, 0.0029, 0.0135), (0.0, 0.0, body_top + 0.0062), bevel=0.0011,
                          mat=crimp_mat)
    serrations = [m.rounded_box(f"Tube.Serration.{k}.{s}", (0.00085, 0.0011, 0.0098),
                                (-0.025 + k * 0.002, s * 0.00155, body_top + 0.0068), bevel=0.0003, mat=crimp_mat)
                  for k in range(26) for s in (-1, 1)]
    cap = m.revolve("Tube.Cap", [(0.0, 0.0), (0.0, 0.0188), (0.0012, 0.0203), (0.004, 0.0209),
                                 (cap_h - 0.0062, 0.0209), (cap_h - 0.0062, 0.0)], axis="Z", segments=72, mat=cap_mat)
    lid = m.revolve("Tube.CapLid", [(cap_h - 0.0058, 0.0), (cap_h - 0.0058, 0.0209), (cap_h - 0.0012, 0.0207),
                                    (cap_h, 0.0196), (cap_h, 0.0)], axis="Z", segments=72, mat=cap_mat)
    hinge = m.rounded_box("Tube.Hinge", (0.0048, 0.012, 0.0052), (0.0204, 0.0, cap_h - 0.006), bevel=0.0012,
                          mat=hinge_mat)
    m.add_subsurf(body, 1)
    b.part("body", [body, shoulder], role="body", pivot_at=(0.0, 0.0, 0.07), order=0,
           anchor=(0.0, -0.012, 0.075))
    b.part("crimp", [crimp, *serrations], role="detail", pivot_at=(0.0, 0.0, body_top + 0.006),
           explode=(0.0, 0.0, 0.03), order=1, anchor=(0.0, -0.0016, body_top + 0.007))
    b.part("cap", [cap, hinge], role="accessory", pivot_at=(0.0, 0.0, 0.008), explode=(0.0, 0.0, -0.035),
           order=2, anchor=(0.0, -0.0209, 0.009))
    b.part("cap_lid", [lid], role="control", pivot_at=(0.0205, 0.0, cap_h - 0.006), explode=(0.0, 0.0, 0.0),
           order=2, anchor=(0.0, -0.0205, cap_h - 0.002))
    prod = b.finish("cosmetic_tube", {k: p.anchor for k, p in b.parts.items()}, GENERATOR_VERSION["cosmetic_tube"])
    parts = prod.parts

    def cap_open(p: float, frame: int) -> None:
        _rotate_handle(parts["cap_lid"], 1, math.radians(-105.0) * p, frame)

    prod.actions = {"CAP_OPEN": cap_open}
    prod.anchors["label"] = (0.0, -0.016, 0.07)
    prod.anchors["hinge"] = (0.0205, 0.0, cap_h - 0.006)
    return prod


GENERATORS = {"drill_driver_20v": drill_driver_20v, "cosmetic_tube": cosmetic_tube}


def build_procedural(name: str, params: dict) -> SceneProduct:
    if name not in GENERATORS:
        raise ValueError(f"unknown product generator {name!r}")
    return GENERATORS[name](params)


# ------------------------------------------------------------------------------------- imported model file ----


def from_file(product: dict) -> SceneProduct:
    """A model file through the studio importer (geometry and materials untouched). Parts are the file's
    objects; they are *not* a verified structure unless the job's fidelity says so (checked by scene_spec)."""
    import product_import  # noqa: PLC0415 — studio module (sys.path set by run.py)

    model = product_import.import_product(product["path"], product["format"], product.get("realHeightM"),
                                          product.get("emitsLight", False), product.get("hints", []))
    parts: dict[str, Part] = {}
    centre = np.array([0.0, 0.0, model.height / 2])
    for k, part in enumerate(model.parts):
        handle = part.offset or model.normalize
        c = np.array(part.centre)
        d = c - centre
        n = float(np.linalg.norm(d)) or 1.0
        explode = tuple((d / n * 0.35 * model.size).tolist())
        name = f"part_{k:02d}"
        handle["rest"] = list(handle.location)
        parts[name] = Part(name, [part.obj], handle, "body", explode, k, tuple(part.centre), verified=False)
    if not parts:
        model.normalize["rest"] = list(model.normalize.location)
        parts["body"] = Part("body", list(model.meshes), model.normalize, "body", verified=False)
    prod = SceneProduct("file", "model", model.pivot, parts, list(model.meshes), model.height, model.radius,
                        model.points, model.surface, {"centre": (0.0, 0.0, model.height / 2)}, model=model)

    if model.emissive:
        def light_on(p: float, frame: int) -> None:
            product_import.set_product_light_level(model, p)
            for t in model.emissive:
                t.socket.keyframe_insert("default_value", frame=frame)

        prod.actions["LIGHT_ON"] = light_on
    return prod


# ------------------------------------------------------------------------------------------------ hashes ----


def geometry_hash(prod: SceneProduct) -> str:
    """sha256 of the evaluated product geometry (vertices rounded to 0.01 mm, face indices) — independent of
    object names and of the scene around it."""
    h = hashlib.sha256()
    dg = bpy.context.evaluated_depsgraph_get()
    for o in sorted(prod.meshes, key=lambda o: o.name):
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            mw = np.array(o.matrix_world)
            w = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
            h.update(np.round(w * 1e5).astype(np.int64).tobytes())
            idx = np.empty(sum(len(p.vertices) for p in me.polygons), dtype=np.int64)
            me.polygons.foreach_get("vertices", idx)
            h.update(idx.tobytes())
        finally:
            ev.to_mesh_clear()
    return h.hexdigest()


def material_hash(prod: SceneProduct) -> str:
    """sha256 of every product material's node graph (node types, input values, links, image file names)."""
    h = hashlib.sha256()
    mats = sorted({s.material for o in prod.meshes for s in o.material_slots if s.material}, key=lambda m_: m_.name)
    for mat in mats:
        h.update(mat.name.split(".0")[0].encode())
        if not mat.node_tree:
            continue
        for n in sorted(mat.node_tree.nodes, key=lambda n: n.name):
            h.update(n.bl_idname.encode())
            if getattr(n, "image", None) is not None:
                h.update(n.image.filepath.encode())
            for i in n.inputs:
                v = getattr(i, "default_value", None)
                if v is None:
                    continue
                try:
                    vals = list(v)
                except TypeError:
                    vals = [v]
                h.update(repr([round(float(x), 5) if isinstance(x, (int, float)) else str(x) for x in vals]).encode())
        for l in mat.node_tree.links:
            h.update(f"{l.from_node.name}:{l.from_socket.identifier}>{l.to_node.name}:{l.to_socket.identifier}".encode())
    return h.hexdigest()


def missing_textures(prod: SceneProduct) -> list[str]:
    """Images referenced by product materials that have no pixels (file not found / failed to load)."""
    out = []
    for o in prod.meshes:
        for s in o.material_slots:
            if not s.material or not s.material.node_tree:
                continue
            for n in s.material.node_tree.nodes:
                img = getattr(n, "image", None)
                if img is not None and not img.has_data:
                    try:
                        img.pixels[0]
                    except (IndexError, RuntimeError):
                        pass
                    if not img.has_data:
                        out.append(img.name)
    return sorted(set(out))


def anchor_world(prod: SceneProduct, name: str) -> Vec:
    """Rest position of an anchor (pivot space): a part's point of interest, or a named product point."""
    if name in prod.parts:
        return prod.parts[name].anchor
    if name in prod.anchors:
        return prod.anchors[name]
    raise KeyError(name)
