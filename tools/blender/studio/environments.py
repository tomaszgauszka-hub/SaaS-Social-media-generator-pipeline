"""Six procedural studio environments (bpy).

Every set is built around the product (S = its characteristic size) and sized so the camera path of every shot
stays inside it: a 360° seamless cyclorama (dark_premium, bright_minimal, soft_pastel) or a simple room with an
open top (warm_living, natural_daylight, industrial). Props are few, simple and kept beside — never behind or
on — the product, so nothing can be mistaken for a part of it. The product's own surface (Z = 0) is a plinth,
a table top or the floor; contact shadows come from path tracing (a short-range AO term in the floor shaders was measured to
cost ~35 % render time for no visible gain).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import bmesh
import bpy


def srgb(hex_color: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    """#RRGGBB (sRGB) → linear RGBA for shader sockets."""
    h = hex_color.lstrip("#")
    out = []
    for k in (0, 2, 4):
        c = int(h[k : k + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2], alpha)


@dataclass
class EnvSet:
    name: str
    #: lights must stay inside (xmin, xmax, ymin, ymax, zmax) — walls of a room; None = open cyclorama
    interior: tuple[float, float, float, float, float] | None
    #: all studio light levels are multiplied by this (white sets bounce more light)
    light_mult: float
    objects: list[bpy.types.Object] = field(default_factory=list)


# ------------------------------------------------------------------------------------------ materials -----


def _material(name: str) -> tuple[bpy.types.Material, bpy.types.NodeTree, bpy.types.Node]:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    return mat, nt, bsdf


def flat_material(name: str, color: str, roughness: float, *, specular: float = 0.5, coat: float = 0.0,
                  bump_scale: float | None = None) -> bpy.types.Material:
    mat, nt, bsdf = _material(name)
    bsdf.inputs["Base Color"].default_value = srgb(color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = specular
    if coat > 0:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.08
    if bump_scale:
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 1.0 / bump_scale
        noise.inputs["Detail"].default_value = 6.0
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.04
        nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def wood_material(name: str, dark: str, light: str, size: float, *, planks: bool,
                  roughness: float = 0.42) -> bpy.types.Material:
    """Procedural wood: stretched wave rings + noise; optional plank seams (brick texture)."""
    mat, nt, bsdf = _material(name)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.0 / size, 8.0 / size, 1.0 / size)
    nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "RINGS"
    wave.inputs["Scale"].default_value = 1.4
    wave.inputs["Distortion"].default_value = 6.0
    wave.inputs["Detail"].default_value = 3.0
    nt.links.new(mapping.outputs["Vector"], wave.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = srgb(dark)
    ramp.color_ramp.elements[1].color = srgb(light)
    nt.links.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    color = ramp.outputs["Color"]
    if planks:
        brick = nt.nodes.new("ShaderNodeTexBrick")
        brick.offset = 0.5
        brick.inputs["Scale"].default_value = 1.0
        brick.inputs["Mortar Size"].default_value = 0.004
        brick.inputs["Brick Width"].default_value = 2.2 * size
        brick.inputs["Row Height"].default_value = 0.22 * size
        brick.inputs["Color1"].default_value = (1, 1, 1, 1)
        brick.inputs["Color2"].default_value = (0.86, 0.86, 0.86, 1)
        brick.inputs["Mortar"].default_value = (0.35, 0.35, 0.35, 1)
        nt.links.new(coord.outputs["Object"], brick.inputs["Vector"])
        mul = nt.nodes.new("ShaderNodeMix")
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 1.0
        nt.links.new(color, mul.inputs["A"])
        nt.links.new(brick.outputs["Color"], mul.inputs["B"])
        color = mul.outputs["Result"]
    bsdf.inputs["Roughness"].default_value = roughness
    nt.links.new(color, bsdf.inputs["Base Color"])
    return mat


def concrete_material(name: str, base: str, size: float) -> bpy.types.Material:
    mat, nt, bsdf = _material(name)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 2.5 / size
    noise.inputs["Detail"].default_value = 10.0
    noise.inputs["Roughness"].default_value = 0.62
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    r, g, b, _ = srgb(base)
    ramp.color_ramp.elements[0].color = (r * 0.72, g * 0.72, b * 0.72, 1)
    ramp.color_ramp.elements[1].color = (r * 1.15, g * 1.15, b * 1.15, 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.08
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.82
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def brick_material(name: str, size: float) -> bpy.types.Material:
    mat, nt, bsdf = _material(name)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.offset = 0.5
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Brick Width"].default_value = 0.42 * size
    brick.inputs["Row Height"].default_value = 0.14 * size
    brick.inputs["Mortar Size"].default_value = 0.012 * size
    brick.inputs["Bias"].default_value = 0.2
    brick.inputs["Color1"].default_value = srgb("#6E3B2E")
    brick.inputs["Color2"].default_value = srgb("#4F2C25")
    brick.inputs["Mortar"].default_value = srgb("#8A847C")
    nt.links.new(coord.outputs["Object"], brick.inputs["Vector"])  # wall planes: local XY = the wall face
    nt.links.new(brick.outputs["Color"], bsdf.inputs["Base Color"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.invert = True
    bump.inputs["Strength"].default_value = 0.35
    nt.links.new(brick.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.88
    return mat


def emissive_material(name: str, color: tuple[float, float, float, float], strength: float) -> bpy.types.Material:
    mat, nt, bsdf = _material(name)
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Emission Color"].default_value = color
    bsdf.inputs["Emission Strength"].default_value = strength
    return mat


# ------------------------------------------------------------------------------------------ geometry ------


def _link(name: str, bm: bmesh.types.BMesh, mat: bpy.types.Material) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def cyclorama(name: str, radius: float, fillet: float, wall_h: float, mat: bpy.types.Material,
              segments: int = 160) -> bpy.types.Object:
    """360° seamless cove: floor disc → quarter-round fillet → cylindrical wall (normals facing in)."""
    prof: list[tuple[float, float]] = [((radius - fillet) * k / 12.0, 0.0) for k in range(1, 13)]
    for k in range(1, 17):
        a = (k / 16.0) * math.pi / 2
        prof.append((radius - fillet + fillet * math.sin(a), fillet * (1 - math.cos(a))))
    prof.append((radius, wall_h))
    bm = bmesh.new()
    centre = bm.verts.new((0.0, 0.0, 0.0))
    rings = []
    for r, z in prof:
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * s / segments),
                                    r * math.sin(2 * math.pi * s / segments), z)) for s in range(segments)])
    for s in range(segments):
        bm.faces.new((centre, rings[0][s], rings[0][(s + 1) % segments]))
    for a, b in zip(rings, rings[1:]):
        for s in range(segments):
            bm.faces.new((a[s], b[s], b[(s + 1) % segments], a[(s + 1) % segments]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        f.smooth = True
    # recalc points normals outward of the closed-ish surface; the cove must face its centre
    bm.normal_update()
    if bm.faces[0].normal.z < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    return _link(name, bm, mat)


def box(name: str, size: tuple[float, float, float], loc: tuple[float, float, float],
        mat: bpy.types.Material, rot_z: float = 0.0) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    obj = _link(name, bm, mat)
    obj.location = loc
    obj.rotation_euler = (0.0, 0.0, rot_z)
    return obj


def plane(name: str, size: tuple[float, float], loc: tuple[float, float, float],
          rot: tuple[float, float, float], mat: bpy.types.Material) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5)
    bmesh.ops.scale(bm, vec=(size[0], size[1], 1.0), verts=bm.verts)
    obj = _link(name, bm, mat)
    obj.location = loc
    obj.rotation_euler = rot
    return obj


def plinth(name: str, radius: float, height: float, mat: bpy.types.Material,
           loc: tuple[float, float] = (0.0, 0.0)) -> bpy.types.Object:
    """Cylinder podium whose top is at Z = 0 (the product stands on it), softly bevelled edges."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=128, radius1=radius, radius2=radius, depth=height)
    bmesh.ops.translate(bm, vec=(0.0, 0.0, -height / 2), verts=bm.verts)
    cap_edges = [e for e in bm.edges if all(abs(abs(v.co.z + height / 2) - height / 2) < 1e-6 for v in e.verts)
                 and abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-9]
    bmesh.ops.bevel(bm, geom=cap_edges, offset=min(radius, height) * 0.06, segments=4, profile=0.5,
                    affect="EDGES")
    bm.normal_update()
    for f in bm.faces:
        f.smooth = abs(f.normal.z) < 0.999
    obj = _link(name, bm, mat)
    obj.location = (loc[0], loc[1], 0.0)
    return obj


def _world(color: tuple[float, float, float, float], strength: float) -> None:
    scene = bpy.context.scene
    world = bpy.data.worlds.new("StudioWorld")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = color
    bg.inputs["Strength"].default_value = strength
    scene.world = world


# ------------------------------------------------------------------------------------------ sets ----------


def build_environment(name: str, size: float, radius: float, reach: float, wall_reach: float) -> EnvSet:
    """`size` = product size S, `radius` = product footprint radius, `reach` = farthest camera distance from
    the product of any shot, `wall_reach` = height a wall needs to fill every frame."""
    if name in ("dark_premium", "bright_minimal", "soft_pastel"):
        r = max(7.0 * size, 1.4 * reach)
        h = max(10.0 * size, wall_reach)
        if name == "dark_premium":
            cove_mat = flat_material("Cove", "#141416", 0.8, specular=0.2)
            cove = cyclorama("Cyclorama", r, 1.8 * size, h, cove_mat)
            cove.location.z = -0.16 * size  # the plinth top is the product's floor (Z = 0)
            stone = flat_material("Plinth", "#0E0E10", 0.16, specular=0.6, coat=0.35)
            ped = plinth("Plinth", max(1.18 * radius, 0.3 * size), 0.16 * size, stone)
            _world(srgb("#050506"), 1.0)
            return EnvSet(name, None, 1.0, [cove, ped])
        if name == "bright_minimal":
            cove_mat = flat_material("Cove", "#F1F0EC", 0.72, specular=0.35)
            cove = cyclorama("Cyclorama", r, 1.8 * size, h, cove_mat)
            _world(srgb("#F2F2F0"), 1.0)
            return EnvSet(name, None, 0.8, [cove])
        cove_mat = flat_material("Cove", "#E8C7B8", 0.78, specular=0.35)
        cove = cyclorama("Cyclorama", r, 1.8 * size, h, cove_mat)
        cove.location.z = -0.2 * size
        sage = flat_material("Plinth", "#A9B9A2", 0.7, specular=0.3)
        ped = plinth("Plinth", max(1.25 * radius, 0.32 * size), 0.2 * size, sage)
        rose = flat_material("PropDisc", "#D99A8E", 0.7, specular=0.3)
        disc = plinth("PropDisc", 0.55 * max(radius, 0.25 * size), 0.09 * size, rose,
                      loc=(2.1 * max(radius, 0.25 * size) + 0.25 * size, 1.4 * size))
        disc.location.z = -0.2 * size + 0.09 * size  # a low disc on the cove floor, beside and behind
        _world(srgb("#FBEFE8"), 0.4)
        return EnvSet(name, None, 0.9, [cove, ped, disc])

    # rooms: back wall close behind the product, side walls and a front wall beyond every camera position
    back = 2.1 * size
    side = max(5.0 * size, 1.2 * reach)
    front = -max(10.0 * size, 1.4 * reach)
    top = max(8.0 * size, wall_reach)
    objs: list[bpy.types.Object] = []
    if name == "industrial":
        floor_z = 0.0
        floor_mat = concrete_material("Floor", "#77746F", size)
        wall_mat = brick_material("BrickWall", size)
        side_mat = concrete_material("SideWall", "#8C8983", size)
        _world(srgb("#2A2E33"), 0.6)
        light_mult = 1.0
    elif name == "warm_living":
        floor_z = -1.35 * size
        floor_mat = wood_material("Floor", "#5E3B22", "#8A5A36", size, planks=True)
        wall_mat = flat_material("Wall", "#E7E3DC", 0.85, specular=0.3, bump_scale=0.05 * size)
        side_mat = wall_mat
        _world(srgb("#FFF4E6"), 0.25)
        light_mult = 0.95
    elif name == "natural_daylight":
        floor_z = -1.35 * size
        floor_mat = wood_material("Floor", "#B08A63", "#D2B48C", size, planks=True)
        wall_mat = flat_material("Wall", "#EEEDE9", 0.85, specular=0.3, bump_scale=0.05 * size)
        side_mat = wall_mat
        _world(srgb("#BFD6F5"), 1.1)
        light_mult = 0.85
    else:
        raise ValueError(f"unknown environment {name!r}")

    width = 2 * side
    depth = back - front
    objs.append(plane("Floor", (width, depth), (0.0, (back + front) / 2, floor_z), (0, 0, 0), floor_mat))
    wall_h = top - floor_z
    zc = floor_z + wall_h / 2
    objs.append(plane("BackWall", (width, wall_h), (0.0, back, zc), (math.pi / 2, 0, 0), wall_mat))
    objs.append(plane("FrontWall", (width, wall_h), (0.0, front, zc), (-math.pi / 2, 0, 0), side_mat))
    objs.append(plane("RightWall", (depth, wall_h), (side, (back + front) / 2, zc), (math.pi / 2, 0, math.pi / 2),
                      side_mat))
    if name == "natural_daylight":
        objs += _window_wall(-side, back, front, floor_z, top, size, side_mat)
    else:
        objs.append(plane("LeftWall", (depth, wall_h), (-side, (back + front) / 2, zc),
                          (math.pi / 2, 0, -math.pi / 2), side_mat))

    if name in ("warm_living", "natural_daylight"):
        # the product stands on a sideboard / table top (Z = 0); the room floor is a table height below
        top_mat = (wood_material("TableTop", "#8E7259", "#B89C7E", size, planks=False, roughness=0.38) if name == "warm_living"
                   else flat_material("TableTop", "#E4DED4", 0.55, specular=0.4))
        slab_front = -max(1.0 * size, 2.5 * radius)
        slab_d = back - 0.05 * size - slab_front
        objs.append(box("TableTop", (max(6.0 * size, 2.5 * reach), slab_d, 0.06 * size),
                        (0.0, back - 0.05 * size - slab_d / 2, -0.03 * size), top_mat))
        objs.append(box("TableBody", (max(6.0 * size, 2.5 * reach), slab_d * 0.92, -floor_z - 0.06 * size),
                        (0.0, back - 0.05 * size - slab_d / 2, (floor_z - 0.06 * size) / 2), top_mat))
        if name == "warm_living":
            objs += _books(size, radius)
    if name == "industrial":
        steel = flat_material("Pipe", "#1C1D1F", 0.35, specular=0.6)
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=0.045 * size, radius2=0.045 * size,
                              depth=width)
        for f in bm.faces:
            f.smooth = True
        pipe = _link("Pipe", bm, steel)
        pipe.rotation_euler = (0, math.pi / 2, 0)
        pipe.location = (0.0, back - 0.12 * size, 1.9 * size)
        objs.append(pipe)
    interior = (-side + 0.15 * size, side - 0.15 * size, front + 0.15 * size, back - 0.15 * size, top)
    return EnvSet(name, interior, light_mult, objs)


def _books(size: float, radius: float) -> list[bpy.types.Object]:
    """A short stack of books on the sideboard beside the product (well clear of its footprint)."""
    x = max(radius, 0.25 * size) + 0.55 * size
    colors = ["#3E4A3D", "#B9A68A", "#7A3E2E"]
    out = []
    z = 0.0
    for k, c in enumerate(colors):
        t = (0.05 + 0.012 * k) * size
        mat = flat_material(f"Book{k}", c, 0.8, specular=0.25)
        out.append(box(f"Book{k}", (0.5 * size, 0.36 * size, t), (x, 0.25 * size, z + t / 2), mat,
                       rot_z=(-0.12, 0.06, -0.03)[k]))
        z += t
    return out


def _window_wall(x: float, back: float, front: float, floor_z: float, top: float, size: float,
                 mat: bpy.types.Material) -> list[bpy.types.Object]:
    """Left wall with a large window (one mullion, one transom): low daylight comes in through it and lands
    on the product with the window's shadow pattern."""
    depth = back - front
    win_y0, win_y1 = max(front + 0.5 * size, -3.0 * size), min(back - 0.2 * size, 1.9 * size)
    win_z0, win_z1 = floor_z + 0.3 * size, min(top - 0.3 * size, floor_z + 4.3 * size)
    t = 0.08 * size
    objs = [
        box("WallLow", (t, depth, win_z0 - floor_z), (x, (back + front) / 2, (floor_z + win_z0) / 2), mat),
        box("WallHigh", (t, depth, top - win_z1), (x, (back + front) / 2, (win_z1 + top) / 2), mat),
        box("WallBack", (t, back - win_y1, win_z1 - win_z0), (x, (back + win_y1) / 2, (win_z0 + win_z1) / 2), mat),
        box("WallFront", (t, win_y0 - front, win_z1 - win_z0), (x, (win_y0 + front) / 2, (win_z0 + win_z1) / 2),
            mat),
    ]
    frame = flat_material("WindowFrame", "#F4F3EF", 0.5, specular=0.4)
    objs.append(box("Mullion", (t * 1.2, 0.07 * size, win_z1 - win_z0), (x, (win_y0 + win_y1) / 2,
                                                                          (win_z0 + win_z1) / 2), frame))
    objs.append(box("Transom", (t * 1.2, win_y1 - win_y0, 0.07 * size), (x, (win_y0 + win_y1) / 2,
                                                                         win_z0 + 0.62 * (win_z1 - win_z0)), frame))
    return objs
