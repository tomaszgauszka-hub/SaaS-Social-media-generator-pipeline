"""Product import + normalisation (bpy).

The real product model is imported as-is: geometry and PBR materials are never edited (product accuracy). The
only thing the studio adds is a transform hierarchy above it

    ProductPivot (animated: shot angle, turntable, lift)  →  ProductNormalize (static: centre XY, base on Z = 0,
    real-size scale)  →  [PartOffset_k (multi-part moves)]  →  imported objects

and, for light-emitting products, the strength of the model's own emission (the "on" state). A surface without
authored emission never starts to glow — except a translucent part named like a shade / diffuser (see _find_emissive).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

import bpy
import numpy as np
from mathutils import Matrix, Vector

import framing

#: plausible real heights; outside this range a unit mix-up (cm / mm exported as m) is assumed
PLAUSIBLE_M = (0.005, 5.0)
#: object types rendered as surfaces; the non-mesh ones are evaluated to a mesh for bounds and framing
SURFACE_TYPES = ("MESH", "CURVE", "SURFACE", "META", "FONT")
#: emission colour given to a translucent named part that has none (only visible while the light is on)
WARM_GLOW = (1.0, 0.72, 0.42, 1.0)


@dataclass
class Part:
    obj: bpy.types.Object
    offset: bpy.types.Object | None
    centre: tuple[float, float, float]
    volume: float
    #: vertex slice of ProductModel.points
    start: int
    end: int


@dataclass
class EmissiveTarget:
    socket: bpy.types.NodeSocket
    off: float
    on: float


@dataclass
class ProductModel:
    pivot: bpy.types.Object
    normalize: bpy.types.Object
    #: objects with renderable geometry: meshes, and curves / text / surfaces / metaballs that evaluate to faces
    meshes: list[bpy.types.Object]
    parts: list[Part]
    #: every vertex in pivot space (N x 3): centred on XY, base on Z = 0, metres
    points: np.ndarray
    height: float
    radius: float
    scale_applied: float
    emissive: list[EmissiveTarget] = field(default_factory=list)
    emissive_mode: str = "none"
    bulb: tuple[float, float, float] | None = None
    #: points sampled on the surface by area (pivot space): width profiles that vertices alone cannot give
    surface: np.ndarray | None = None

    @property
    def size(self) -> float:
        """Characteristic size S used to scale sets, lights and moves."""
        return max(self.height, 2.0 * self.radius, 1e-3)


def _import(path: str, fmt: str) -> None:
    if fmt in ("glb", "gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif fmt == "obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif fmt == "fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif fmt == "usd":
        bpy.ops.wm.usd_import(filepath=path)
    elif fmt == "blend":
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.objects = [n for n in src.objects]
        for obj in dst.objects:
            # everything the other importers bring in too (curves, text, armatures …); cameras / lights are dropped
            if obj is not None and obj.type not in ("CAMERA", "LIGHT"):
                bpy.context.scene.collection.objects.link(obj)
    else:
        raise ValueError(f"unsupported model format {fmt!r}")


def _world_vertices(obj: bpy.types.Object, depsgraph) -> np.ndarray:
    ev = obj.evaluated_get(depsgraph)
    mesh = ev.to_mesh()
    try:
        n = len(mesh.vertices)
        co = np.empty(n * 3, dtype=np.float64)
        mesh.vertices.foreach_get("co", co)
        co = co.reshape(n, 3)
    finally:
        ev.to_mesh_clear()
    m = np.array(ev.matrix_world, dtype=np.float64)
    return co @ m[:3, :3].T + m[:3, 3]


def _world_triangles(obj: bpy.types.Object, depsgraph) -> np.ndarray:
    """(T, 3, 3) world-space triangles of an object's evaluated mesh."""
    ev = obj.evaluated_get(depsgraph)
    mesh = ev.to_mesh()
    try:
        mesh.calc_loop_triangles()
        nv, nt = len(mesh.vertices), len(mesh.loop_triangles)
        co = np.empty(nv * 3, dtype=np.float64)
        mesh.vertices.foreach_get("co", co)
        idx = np.empty(nt * 3, dtype=np.int64)
        mesh.loop_triangles.foreach_get("vertices", idx)
    finally:
        ev.to_mesh_clear()
    m = np.array(ev.matrix_world, dtype=np.float64)
    co = co.reshape(nv, 3) @ m[:3, :3].T + m[:3, 3]
    return co[idx.reshape(nt, 3)] if nt else np.zeros((0, 3, 3))


def surface_samples(tris: np.ndarray, n: int = 6000, seed: int = 7) -> np.ndarray:
    """`n` points spread over the triangles by area (deterministic): the product's surface, not its vertices."""
    if not len(tris):
        return np.zeros((0, 3))
    area = 0.5 * np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1)
    if area.sum() <= 0:
        return tris.reshape(-1, 3)
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(tris), size=n, p=area / area.sum())
    u = rng.random((n, 2))
    flip = u.sum(axis=1) > 1
    u[flip] = 1 - u[flip]
    t = tris[pick]
    return t[:, 0] + u[:, :1] * (t[:, 1] - t[:, 0]) + u[:, 1:] * (t[:, 2] - t[:, 0])


def _has_surface(obj: bpy.types.Object, depsgraph) -> bool:
    if obj.type == "MESH":
        return len(obj.data.vertices) > 0
    if obj.type not in SURFACE_TYPES:
        return False
    # a bevel profile or a path curve evaluates to edges only: it renders nothing and must not widen the bounds
    ev = obj.evaluated_get(depsgraph)
    mesh = ev.to_mesh()
    try:
        return mesh is not None and len(mesh.polygons) > 0
    finally:
        ev.to_mesh_clear()


def _principled_nodes(mat: bpy.types.Material):
    if not mat or not mat.node_tree:
        return []
    return [n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"]


def import_product(path: str, fmt: str, real_height_m: float | None, emits_light: bool,
                   hints: list[str]) -> ProductModel:
    before = set(bpy.data.objects)
    _import(os.path.abspath(path), fmt)
    new = [o for o in bpy.data.objects if o not in before]
    # the studio lights and frames the product itself: drop cameras / lights shipped inside the model file
    for o in [o for o in new if o.type in ("CAMERA", "LIGHT")]:
        bpy.data.objects.remove(o, do_unlink=True)
    new = [o for o in bpy.data.objects if o not in before]
    dg = bpy.context.evaluated_depsgraph_get()
    meshes = [o for o in new if _has_surface(o, dg)]
    if not meshes:
        raise RuntimeError("the model contains no mesh")

    scene = bpy.context.scene
    pivot = bpy.data.objects.new("ProductPivot", None)
    normalize = bpy.data.objects.new("ProductNormalize", None)
    scene.collection.objects.link(pivot)
    scene.collection.objects.link(normalize)
    normalize.parent = pivot
    for o in new:
        if o.parent is None or o.parent not in new:
            mw = o.matrix_world.copy()
            o.parent = normalize
            o.matrix_world = mw

    dg = bpy.context.evaluated_depsgraph_get()
    pts = np.concatenate([_world_vertices(o, dg) for o in meshes])
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    h = float(hi[2] - lo[2])
    if h <= 0:
        raise RuntimeError("the model is flat (zero height)")
    if real_height_m:
        s = real_height_m / h
    elif h > 200:
        s = 0.001  # millimetres
    elif h > PLAUSIBLE_M[1]:
        s = 0.01  # centimetres
    else:
        s = 1.0
    cx, cy = float(lo[0] + hi[0]) / 2, float(lo[1] + hi[1]) / 2
    normalize.scale = (s, s, s)
    normalize.location = (-cx * s, -cy * s, -float(lo[2]) * s)
    dg.update()

    # per-part points in pivot space (multi-part presets move whole parts)
    parts: list[Part] = []
    chunks = []
    start = 0
    for o in meshes:
        v = _world_vertices(o, dg)
        chunks.append(v)
        plo, phi = v.min(axis=0), v.max(axis=0)
        parts.append(Part(o, None, tuple(((plo + phi) / 2).tolist()), float(np.prod(np.maximum(phi - plo, 1e-6))),
                          start, start + len(v)))
        start += len(v)
    points = np.concatenate(chunks)
    tris = [t for t in (_world_triangles(o, dg) for o in meshes) if len(t)]
    surface = surface_samples(np.concatenate(tris)) if tris else None
    if len(parts) >= 2:
        for k, part in enumerate(parts):
            off = bpy.data.objects.new(f"PartOffset_{k:02d}", None)
            scene.collection.objects.link(off)
            off.parent = normalize
            centre_local = Vector(part.centre)
            off.matrix_world = Matrix.Translation(centre_local)
            off["rest"] = list(off.location)
            mw = part.obj.matrix_world.copy()
            part.obj.parent = off
            part.obj.matrix_world = mw
            part.offset = off

    model = ProductModel(
        pivot=pivot,
        normalize=normalize,
        meshes=meshes,
        parts=parts,
        points=points,
        height=float(points[:, 2].max()),
        radius=float(np.hypot(points[:, 0], points[:, 1]).max()),
        scale_applied=s,
        surface=surface,
    )
    if emits_light:
        _find_emissive(model, new, hints)
        model.bulb = _find_bulb(model, new, hints, dg)
    return model


def hint_pattern(hints: list[str]) -> re.Pattern | None:
    """Case-insensitive hint fragments matched at the start of a word ("led" matches "LED_strip", not "folded")."""
    words = [h.strip().lower() for h in hints if h.strip()]
    return re.compile("|".join(rf"(?<![a-z]){re.escape(w)}" for w in words)) if words else None


def _authored_emission(node) -> bool:
    """The surface already glows: a mapped emission colour, or a non-black colour at a non-zero strength (an
    unset glTF colour is white at strength 0, an OBJ one black at strength 1 — neither emits)."""
    col = node.inputs.get("Emission Color")
    if col is None:
        return False
    return col.is_linked or (float(node.inputs["Emission Strength"].default_value) > 0
                             and max(col.default_value[:3]) > 1e-4)


def _translucent(mat: bpy.types.Material, node) -> bool:
    """Light passes through the surface (transmission or alpha blending): a fabric / frosted shade, a diffuser."""
    tw = node.inputs.get("Transmission Weight")
    if tw is not None and (tw.is_linked or float(tw.default_value) > 1e-3):
        return True
    al = node.inputs.get("Alpha")
    if al is None:
        return False
    if al.is_linked:  # a mapped alpha may be a cut-out mask: only an alpha-blended material counts
        return getattr(mat, "surface_render_method", "") == "BLENDED"
    return float(al.default_value) < 0.999


def _find_emissive(model: ProductModel, objs, hints: list[str]) -> None:
    """Materials that glow when the product's light is on: names matching the hints first, else materials
    whose emission colour is driven by an authored emissive map.

    The real product's look is kept: an authored emission keeps its colour (only its Emission Strength is
    animated, from the authored value up); a named part without one glows only when it is translucent (it gets
    the warm WARM_GLOW colour, at strength 0 while off). An opaque named part (a black metal shade) is left
    untouched — the interior ProductLight lights it physically."""
    pat = hint_pattern(hints)
    mats: list[bpy.types.Material] = []
    for o in model.meshes:
        for slot in o.material_slots:
            if slot.material and slot.material not in mats:
                mats.append(slot.material)
    named = [m for m in mats if pat and pat.search(m.name.lower())]
    if not named and pat:
        # object names only when they single out a part — a hint matching every mesh names the whole product
        objs = [o for o in model.meshes if pat.search(o.name.lower())]
        if objs and len(objs) < len(model.meshes):
            named = [s.material for o in objs for s in o.material_slots if s.material]
            named = list(dict.fromkeys(named))
    mapped = []
    for m in mats:
        for n in _principled_nodes(m):
            col = n.inputs.get("Emission Color")
            if col is not None and col.is_linked:
                mapped.append(m)
                break
    glowing: list[bpy.types.Material] = []
    for m in named:
        for n in _principled_nodes(m):
            col, st = n.inputs.get("Emission Color"), n.inputs["Emission Strength"]
            if col is None or st.is_linked:
                continue
            if _authored_emission(n):
                model.emissive.append(EmissiveTarget(st, float(st.default_value), max(1.2, float(st.default_value))))
            elif _translucent(m, n):
                col.default_value = WARM_GLOW  # unlinked: an authored map would have counted as emission
                model.emissive.append(EmissiveTarget(st, 0.0, 1.2))
            else:
                continue
            if m not in glowing:
                glowing.append(m)
    if glowing:
        model.emissive_mode = "name_hint"
    elif mapped:
        model.emissive_mode = "emissive_map"
        for m in mapped:
            for n in _principled_nodes(m):
                st = n.inputs["Emission Strength"]
                model.emissive.append(EmissiveTarget(st, float(st.default_value), max(5.0, float(st.default_value))))
        glowing = mapped
    for m in glowing:
        # the interior light does the illumination; the glow is the surface's look, not a sampled emitter
        m.cycles.emission_sampling = "NONE"


def _find_bulb(model: ProductModel, objs, hints: list[str], dg) -> tuple[float, float, float]:
    """Bulb position in pivot space: an object named like a bulb, else derived from the geometry."""
    for o in model.meshes:
        if re.search(r"(^|[^a-z])(bulb|led|emitter)([^a-z]|$)", o.name.lower()):
            v = _world_vertices(o, dg)
            c = (v.min(axis=0) + v.max(axis=0)) / 2
            return (float(c[0]), float(c[1]), float(c[2]))
    sample = model.points[:: max(1, len(model.points) // 6000)]
    pos, _ = framing.emitter_spot([tuple(p) for p in sample.tolist()], model.height)
    return pos


def set_product_light_level(model: ProductModel, level: float) -> None:
    for t in model.emissive:
        t.socket.default_value = t.off + (t.on - t.off) * level
