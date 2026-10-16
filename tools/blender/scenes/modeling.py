"""Procedural modelling toolkit (bpy + bmesh) for the parametric demo products.

Shapes are built from analytic sections so they stay smooth at any render size and export cleanly (quads, no
n-gons except caps, consistent normals):

  revolve(...)  — a profile [(axial position, radius)] swept around an axis, with optional rib / knurl modulation
  loft(...)     — superellipse sections (ellipse → rounded rectangle) stacked along an arbitrary path
  rounded_box() — a box with a (non-destructive) bevel modifier

Every builder returns a mesh object with UVs (exporters and UE need them) and smooth shading.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import bmesh
import bpy
from mathutils import Vector

Vec = tuple[float, float, float]


def _link(name: str, bm: bmesh.types.BMesh, mat: bpy.types.Material | None, smooth: bool = True,
          parent: bpy.types.Object | None = None) -> bpy.types.Object:
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for f in bm.faces:
        f.smooth = smooth
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if mat is not None:
        me.materials.append(mat)
    if parent is not None:
        obj.parent = parent
    return obj


def _uv_cylindrical(bm: bmesh.types.BMesh, rings: list[list], seam_u: bool = True) -> None:
    """UVs for a ring grid: u around, v along (normalised by ring index)."""
    uv = bm.loops.layers.uv.verify()
    index = {}
    n_rings = len(rings)
    for i, ring in enumerate(rings):
        n = len(ring)
        for j, v in enumerate(ring):
            index[v.index] = (j / n, i / max(1, n_rings - 1))
    for f in bm.faces:
        us = [index.get(l.vert.index, (0.5, 0.5))[0] for l in f.loops]
        wrap = seam_u and (max(us) - min(us) > 0.5)
        for l in f.loops:
            u, v = index.get(l.vert.index, (0.5, 0.5))
            if wrap and u < 0.5:
                u += 1.0
            l[uv].uv = (u, v)


def _bridge(bm: bmesh.types.BMesh, a: list, b: list) -> None:
    n = len(a)
    for j in range(n):
        bm.faces.new((a[j], a[(j + 1) % n], b[(j + 1) % n], b[j]))


def _cap(bm: bmesh.types.BMesh, ring: list, centre: Vec, flip: bool) -> None:
    c = bm.verts.new(centre)
    n = len(ring)
    for j in range(n):
        tri = (ring[j], ring[(j + 1) % n], c)
        bm.faces.new(tri[::-1] if flip else tri)


def revolve(name: str, profile: list[tuple[float, float]], *, axis: str = "Z", segments: int = 64,
            mat: bpy.types.Material | None = None, ribs: int = 0, rib_depth: float = 0.0,
            rib_span: tuple[float, float] | None = None, squash: float = 1.0, origin: Vec = (0.0, 0.0, 0.0),
            cap_start: bool = True, cap_end: bool = True, parent=None, smooth: bool = True) -> bpy.types.Object:
    """Surface of revolution. `profile`: [(t, r)] with t along `axis`; `ribs` grooves around the axis (depth as a
    fraction of r) limited to the `rib_span` t-range; `squash` scales the secondary radial axis (oval bodies)."""
    bm = bmesh.new()
    rings: list[list] = []
    for t, r in profile:
        ring = []
        for j in range(segments):
            a = 2 * math.pi * j / segments
            rr = r
            if ribs and (rib_span is None or rib_span[0] <= t <= rib_span[1]):
                rr = r * (1.0 - rib_depth * (0.5 - 0.5 * math.cos(ribs * a)) ** 2)
            c, s = rr * math.cos(a), rr * math.sin(a) * squash
            if axis == "Z":
                p = (origin[0] + c, origin[1] + s, origin[2] + t)
            elif axis == "X":
                p = (origin[0] + t, origin[1] + s, origin[2] + c)
            else:  # Y
                p = (origin[0] + c, origin[1] + t, origin[2] + s)
            ring.append(bm.verts.new(p))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        _bridge(bm, a, b)
    ax = {"X": 0, "Y": 1, "Z": 2}[axis]

    def centre(t: float) -> Vec:
        c = list(origin)
        c[ax] += t
        return (c[0], c[1], c[2])

    if cap_start and profile[0][1] > 1e-6:
        _cap(bm, rings[0], centre(profile[0][0]), flip=True)
    if cap_end and profile[-1][1] > 1e-6:
        _cap(bm, rings[-1], centre(profile[-1][0]), flip=False)
    bm.verts.index_update()
    _uv_cylindrical(bm, rings)
    return _link(name, bm, mat, smooth, parent)


@dataclass(frozen=True)
class Section:
    """A superellipse section: centre, semi-axes along the local u / v directions, exponent (2 = ellipse,
    4+ = rounded rectangle) and the local frame (u, v unit vectors, normal = u × v)."""

    centre: Vec
    ru: float
    rv: float
    n: float = 2.0
    u: Vec = (1.0, 0.0, 0.0)
    v: Vec = (0.0, 1.0, 0.0)


def superellipse(ru: float, rv: float, n: float, segments: int) -> list[tuple[float, float]]:
    pts = []
    e = 2.0 / n
    for j in range(segments):
        a = 2 * math.pi * j / segments
        c, s = math.cos(a), math.sin(a)
        pts.append((ru * math.copysign(abs(c) ** e, c), rv * math.copysign(abs(s) ** e, s)))
    return pts


def loft(name: str, sections: list[Section], *, segments: int = 48, mat=None, cap_start: bool = True,
         cap_end: bool = True, parent=None, smooth: bool = True) -> bpy.types.Object:
    bm = bmesh.new()
    rings = []
    for s in sections:
        ring = []
        for a, b in superellipse(float(s.ru), float(s.rv), float(s.n), segments):
            p = Vector([float(x) for x in s.centre]) + float(a) * Vector(s.u) + float(b) * Vector(s.v)
            ring.append(bm.verts.new(p))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        _bridge(bm, a, b)
    if cap_start:
        _cap(bm, rings[0], sections[0].centre, flip=True)
    if cap_end:
        _cap(bm, rings[-1], sections[-1].centre, flip=False)
    bm.verts.index_update()
    _uv_cylindrical(bm, rings)
    return _link(name, bm, mat, smooth, parent)


def rounded_box(name: str, size: Vec, loc: Vec, *, bevel: float, segments: int = 4, mat=None,
                parent=None, rot: Vec = (0.0, 0.0, 0.0)) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:  # box projection UVs
        n = f.normal
        axes = (1, 2) if abs(n.x) > 0.5 else (0, 2) if abs(n.y) > 0.5 else (0, 1)
        for l in f.loops:
            co = l.vert.co
            l[uv].uv = (co[axes[0]] / max(size) + 0.5, co[axes[1]] / max(size) + 0.5)
    obj = _link(name, bm, mat, True, parent)
    obj.location = loc
    obj.rotation_euler = rot
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = min(bevel, 0.49 * min(size))
    mod.segments = segments
    mod.limit_method = "NONE"
    mod.harden_normals = False
    return obj


def cylinder(name: str, radius: float, depth: float, loc: Vec, *, axis: str = "Z", segments: int = 48,
             mat=None, parent=None, bevel: float = 0.0) -> bpy.types.Object:
    """A capped cylinder centred on `loc` along `axis` (optionally with softened rims)."""
    h = depth / 2
    if bevel > 0:
        b = min(bevel, 0.45 * radius, 0.45 * depth)
        prof = [(-h, 0.0), (-h, radius - b), (-h + 0.3 * b, radius - 0.3 * b), (-h + b, radius),
                (h - b, radius), (h - 0.3 * b, radius - 0.3 * b), (h, radius - b), (h, 0.0)]
        prof = [p for p in prof if p[1] > 1e-7] or [(-h, radius), (h, radius)]
        return revolve(name, prof, axis=axis, segments=segments, mat=mat, origin=loc, parent=parent)
    return revolve(name, [(-h, radius), (h, radius)], axis=axis, segments=segments, mat=mat, origin=loc,
                   parent=parent)


def add_subsurf(obj: bpy.types.Object, levels: int = 1) -> None:
    mod = obj.modifiers.new("Subdivision", "SUBSURF")
    mod.levels = levels
    mod.render_levels = levels


def set_origin(obj: bpy.types.Object, point: Vec) -> None:
    """Move the object's origin to `point` (world) without moving its geometry — pivots for moving parts."""
    mw = obj.matrix_world.copy()
    local = mw.inverted() @ Vector(point)
    obj.data.transform(__import__("mathutils").Matrix.Translation(-local))
    obj.location = mw @ local


# --------------------------------------------------------------------------------------------- materials ----


def _principled(name: str):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    return mat, nt, bsdf


def _set(bsdf, **inputs) -> None:
    names = {
        "base": "Base Color",
        "metallic": "Metallic",
        "roughness": "Roughness",
        "coat": "Coat Weight",
        "coat_roughness": "Coat Roughness",
        "specular": "Specular IOR Level",
        "transmission": "Transmission Weight",
        "ior": "IOR",
        "alpha": "Alpha",
        "emission": "Emission Color",
        "emission_strength": "Emission Strength",
        "anisotropic": "Anisotropic",
        "sheen": "Sheen Weight",
        "subsurface": "Subsurface Weight",
    }
    for k, v in inputs.items():
        sock = bsdf.inputs.get(names[k])
        if sock is not None:
            sock.default_value = v


def srgb(hex_color: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    h = hex_color.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2], alpha)


def _bump(nt, bsdf, scale: float, strength: float, detail: float = 6.0) -> None:
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = detail
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = 0.0005
    nt.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])


def plastic(name: str, color: str, roughness: float = 0.4, coat: float = 0.0, texture: float = 0.0):
    mat, nt, bsdf = _principled(name)
    _set(bsdf, base=srgb(color), roughness=roughness, coat=coat, coat_roughness=0.08, specular=0.5)
    if texture > 0:  # fine moulded-plastic grain
        _bump(nt, bsdf, 900.0, texture)
    return mat


def rubber(name: str, color: str):
    mat, nt, bsdf = _principled(name)
    _set(bsdf, base=srgb(color), roughness=0.82, specular=0.3)
    _bump(nt, bsdf, 1400.0, 0.25, 4.0)
    return mat


def metal(name: str, color: str, roughness: float = 0.25, anisotropic: float = 0.0):
    mat, nt, bsdf = _principled(name)
    _set(bsdf, base=srgb(color), metallic=1.0, roughness=roughness, anisotropic=anisotropic)
    return mat


def glass(name: str, color: str = "#FFFFFF", roughness: float = 0.02, ior: float = 1.45):
    mat, nt, bsdf = _principled(name)
    _set(bsdf, base=srgb(color), roughness=roughness, transmission=1.0, ior=ior)
    return mat


def emissive_lens(name: str, color: str, glow: str):
    """A lens / LED: clear plastic whose emission strength is animated (input "Emission Strength")."""
    mat, nt, bsdf = _principled(name)
    _set(bsdf, base=srgb(color), roughness=0.08, coat=0.4, emission=srgb(glow), emission_strength=0.0)
    return mat


def _xray_network(nt, color: str):
    """Faint translucent body with glowing silhouette edges; returns the shader output socket."""
    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = srgb(color)
    emit.inputs["Strength"].default_value = 2.2
    weight = nt.nodes.new("ShaderNodeLayerWeight")
    weight.inputs["Blend"].default_value = 0.18
    ramp = nt.nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value = 0.25
    ramp.inputs["From Max"].default_value = 0.95
    ramp.inputs["To Min"].default_value = 0.06
    ramp.inputs["To Max"].default_value = 0.9
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(weight.outputs["Facing"], ramp.inputs["Value"])
    nt.links.new(ramp.outputs["Result"], mix.inputs["Fac"])
    nt.links.new(transp.outputs["BSDF"], mix.inputs[1])
    nt.links.new(emit.outputs["Emission"], mix.inputs[2])
    return mix.outputs["Shader"]


def _blended(mat) -> None:
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"
    elif hasattr(mat, "blend_method"):
        mat.blend_method = "BLEND"


def xray(name: str, color: str):
    """Technical visualisation shell (Cycles + EEVEE)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(_xray_network(nt, color), out.inputs["Surface"])
    _blended(mat)
    return mat


def banded_label(name: str, base: str, band: str, band2: str, axis: int, lo: float, hi: float,
                 roughness: float = 0.32, coat: float = 0.5, line: str | None = None):
    """Packaging print without text: a base colour with a crisp band fading `band` → `band2` between `lo` and
    `hi` along an object-space axis (0 = X, 1 = Y, 2 = Z), optionally edged by a thin `line` (foil) stripe.
    Text and claims stay in the 2D layer (Remotion / FFmpeg)."""
    mat, nt, bsdf = _principled(name)
    _set(bsdf, roughness=roughness, coat=coat, coat_roughness=0.06, specular=0.5)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    rng = nt.nodes.new("ShaderNodeMapRange")
    rng.inputs["From Min"].default_value = lo
    rng.inputs["From Max"].default_value = hi
    nt.links.new(sep.outputs[("X", "Y", "Z")[axis]], rng.inputs["Value"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, srgb(base)
    els[1].position, els[1].color = 1.0, srgb(base)
    stops = [(0.30, base), (0.305, band), (0.60, band2), (0.603, base)]
    if line:
        stops = [(0.285, base), (0.288, line), (0.297, line), (0.30, base), (0.305, band), (0.60, band2),
                 (0.603, base), (0.612, base), (0.615, line), (0.624, line), (0.627, base)]
    for pos, col in stops:
        e = els.new(pos)
        e.color = srgb(col)
    nt.links.new(rng.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    if line:  # the foil stripes are metallic
        lr = nt.nodes.new("ShaderNodeValToRGB")
        le = lr.color_ramp.elements
        le[0].position, le[0].color = 0.0, (0, 0, 0, 1)
        le[1].position, le[1].color = 1.0, (0, 0, 0, 1)
        for pos, v in ((0.285, 0), (0.288, 1), (0.297, 1), (0.30, 0), (0.612, 0), (0.615, 1), (0.624, 1), (0.627, 0)):
            e = le.new(pos)
            e.color = (v, v, v, 1)
        nt.links.new(rng.outputs["Result"], lr.inputs["Fac"])
        nt.links.new(lr.outputs["Color"], bsdf.inputs["Metallic"])
    return mat


def keyframe_emission(mat: bpy.types.Material, strength: float, frame: int) -> None:
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    sock = bsdf.inputs.get("Emission Strength")
    sock.default_value = strength
    sock.keyframe_insert("default_value", frame=frame)


def two_tone(name: str, base: str, accent: str, axis: int, start: float, end: float, *,
             roughness: float = 0.38, coat: float = 0.15, accent_roughness: float | None = None,
             texture: float = 0.0):
    """Moulded plastic in two colours split along an object-space axis: `accent` between `start` and `end`
    (metres along X/Y/Z of the object), `base` elsewhere — e.g. the amber top stripe of a power-tool body."""
    mat, nt, bsdf = _principled(name)
    _set(bsdf, roughness=roughness, coat=coat, coat_roughness=0.1, specular=0.5)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    inside = nt.nodes.new("ShaderNodeMath")
    inside.operation = "COMPARE"
    inside.inputs[1].default_value = 0.5 * (start + end)
    inside.inputs[2].default_value = 0.5 * abs(end - start)
    nt.links.new(sep.outputs[("X", "Y", "Z")[axis]], inside.inputs[0])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = srgb(base)
    mix.inputs["B"].default_value = srgb(accent)
    nt.links.new(inside.outputs["Value"], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    if accent_roughness is not None:
        rmix = nt.nodes.new("ShaderNodeMix")
        rmix.data_type = "FLOAT"
        rmix.inputs["A"].default_value = roughness
        rmix.inputs["B"].default_value = accent_roughness
        nt.links.new(inside.outputs["Value"], rmix.inputs["Factor"])
        nt.links.new(rmix.outputs["Result"], bsdf.inputs["Roughness"])
    if texture > 0:
        _bump(nt, bsdf, 900.0, texture)
    return mat


def xray_reveal(name: str, base_mat: bpy.types.Material, glow: str):
    """`base_mat` blended into the x-ray shell by a keyframable "reveal" value (0 = opaque, 1 = x-ray) — the
    technical visualisation fades the housing away to show the mechanism inside."""
    mat = base_mat.copy()
    mat.name = name
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    surface = out.inputs["Surface"].links[0].from_socket
    reveal = nt.nodes.new("ShaderNodeValue")
    reveal.name = "reveal"
    reveal.outputs[0].default_value = 0.0
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(reveal.outputs[0], mix.inputs["Fac"])
    nt.links.new(surface, mix.inputs[1])
    nt.links.new(_xray_network(nt, glow), mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    _blended(mat)
    return mat


def keyframe_reveal(mat: bpy.types.Material, value: float, frame: int) -> None:
    node = mat.node_tree.nodes.get("reveal")
    node.outputs[0].default_value = value
    node.outputs[0].keyframe_insert("default_value", frame=frame)
