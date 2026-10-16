"""Backgrounds and lifestyle environments of the 3D scene generators (bpy).

Studio backgrounds reuse the product studio's sets (tools/blender/studio/environments.py: dark_premium,
bright_minimal, soft_pastel, warm_living, natural_daylight, industrial). Lifestyle sets are built at real metric
scale around the product's footprint — a kitchen counter, a bathroom vanity, a workshop bench, a garage steel
bench, a living-room sideboard, a desk — so the product keeps its real size against familiar furniture. Every set
is generic and brand-free; props never resemble another product.

The product always stands on Z = 0 (the top of the surface it rests on).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import bpy

import environments as studio_env
import modeling as m


@dataclass
class SceneSet:
    name: str
    interior: tuple[float, float, float, float, float] | None
    light_mult: float
    objects: list = field(default_factory=list)
    #: extra animated decor (brand environment shapes): (object, base rotation, speed)
    decor: list = field(default_factory=list)
    transparent: bool = False
    #: f-number for depth of field of this set (None = no DOF)
    fstop: float | None = None


# ------------------------------------------------------------------------------------- materials ----


def _bsdf(mat):
    return mat.node_tree.nodes.get("Principled BSDF")


def marble(name: str, base: str = "#EDEBE7", vein: str = "#8E8C88", scale: float = 3.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = _bsdf(mat)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 9.0
    noise.inputs["Distortion"].default_value = 5.0
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.inputs["Scale"].default_value = scale * 0.6
    wave.inputs["Distortion"].default_value = 9.0
    wave.inputs["Detail"].default_value = 6.0
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Color"], wave.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, m.srgb(vein)
    els[1].position, els[1].color = 0.12, m.srgb(base)
    nt.links.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.14
    bsdf.inputs["Coat Weight"].default_value = 0.35
    bsdf.inputs["Coat Roughness"].default_value = 0.05
    return mat


def tiles(name: str, color: str, grout: str, tile_w: float, tile_h: float, offset: float, roughness: float):
    """Wall tiles at real size (metres): brick texture in object space, grout recessed by a bump."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = _bsdf(mat)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Rotation"].default_value = (math.pi / 2, 0.0, 0.0)  # wall plane XZ → texture XY
    nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.offset = offset
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Brick Width"].default_value = tile_w
    brick.inputs["Row Height"].default_value = tile_h
    brick.inputs["Mortar Size"].default_value = 0.0025
    brick.inputs["Mortar Smooth"].default_value = 0.4
    brick.inputs["Color1"].default_value = m.srgb(color)
    brick.inputs["Color2"].default_value = m.srgb(color)
    brick.inputs["Mortar"].default_value = m.srgb(grout)
    nt.links.new(mapping.outputs["Vector"], brick.inputs["Vector"])
    nt.links.new(brick.outputs["Color"], bsdf.inputs["Base Color"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    bump.invert = True
    nt.links.new(brick.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def pegboard(name: str, base: str = "#A88358", hole: str = "#2A2118", pitch: float = 0.0254, r: float = 0.0034):
    """Perforated hardboard: a hole every inch, built from object coordinates (no image texture)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = _bsdf(mat)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])

    def cell(axis: str):
        div = nt.nodes.new("ShaderNodeMath")
        div.operation = "DIVIDE"
        div.inputs[1].default_value = pitch
        nt.links.new(sep.outputs[axis], div.inputs[0])
        frac = nt.nodes.new("ShaderNodeMath")
        frac.operation = "FRACT"
        nt.links.new(div.outputs[0], frac.inputs[0])
        sub = nt.nodes.new("ShaderNodeMath")
        sub.operation = "SUBTRACT"
        sub.inputs[1].default_value = 0.5
        nt.links.new(frac.outputs[0], sub.inputs[0])
        return sub

    cx, cz = cell("X"), cell("Y")
    vec = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(cx.outputs[0], vec.inputs["X"])
    nt.links.new(cz.outputs[0], vec.inputs["Y"])
    length = nt.nodes.new("ShaderNodeVectorMath")
    length.operation = "LENGTH"
    nt.links.new(vec.outputs[0], length.inputs[0])
    hole_mask = nt.nodes.new("ShaderNodeMath")
    hole_mask.operation = "LESS_THAN"
    hole_mask.inputs[1].default_value = r / pitch
    nt.links.new(length.outputs["Value"], hole_mask.inputs[0])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = m.srgb(base)
    mix.inputs["B"].default_value = m.srgb(hole)
    nt.links.new(hole_mask.outputs[0], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.75
    return mat


def speckled(name: str, base: str, fleck: str, roughness: float = 0.22):
    """Quartz / terrazzo-like counter: fine flecks over a base colour."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = _bsdf(mat)
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = 260.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, m.srgb(fleck)
    els[1].position, els[1].color = 0.07, m.srgb(base)
    nt.links.new(vor.outputs["Distance"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Coat Weight"].default_value = 0.2
    return mat


# ----------------------------------------------------------------------------------- set pieces ----


def _box(name, size, loc, mat, bevel=0.004, rot=(0.0, 0.0, 0.0)):
    return m.rounded_box(name, size, loc, bevel=bevel, mat=mat, rot=rot)


def _world(color: str, strength: float) -> None:
    studio_env._world(studio_env.srgb(color), strength)


def _room(back_y: float, width: float, height: float, wall_mat, floor_z: float, floor_mat=None):
    objs = [studio_env.plane("BackWall", (width, height), (0.0, back_y, floor_z + height / 2), (math.pi / 2, 0, 0),
                             wall_mat)]
    if floor_mat is not None:
        objs.append(studio_env.plane("Floor", (width, 6.0), (0.0, back_y - 3.0, floor_z), (0, 0, 0), floor_mat))
    for side in (-1, 1):
        objs.append(studio_env.plane(f"SideWall{side}", (6.0, height), (side * width / 2, back_y - 3.0,
                                                                         floor_z + height / 2),
                                     (math.pi / 2, 0, side * math.pi / 2), wall_mat))
    return objs


def _plant(name: str, loc, scale: float):
    pot = m.revolve(f"{name}.Pot", [(0.0, 0.0), (0.0, 0.05 * scale), (0.11 * scale, 0.058 * scale),
                                    (0.11 * scale, 0.0)], axis="Z", segments=48, origin=loc,
                    mat=m.plastic(f"{name}.PotMat", "#D8D2C8", 0.6))
    leaves = []
    leaf_mat = m.plastic(f"{name}.Leaf", "#4F6B45", 0.55)
    for k in range(9):
        a = 2 * math.pi * k / 9
        r = 0.035 * scale
        leaf = m.loft(f"{name}.Leaf{k}", [
            m.Section((loc[0] + r * math.cos(a) * 0.3, loc[1] + r * math.sin(a) * 0.3, loc[2] + 0.1 * scale),
                      0.004 * scale, 0.002 * scale),
            m.Section((loc[0] + r * math.cos(a) * 1.6, loc[1] + r * math.sin(a) * 1.6, loc[2] + 0.2 * scale),
                      0.018 * scale, 0.003 * scale),
            m.Section((loc[0] + r * math.cos(a) * 2.6, loc[1] + r * math.sin(a) * 2.6, loc[2] + 0.26 * scale),
                      0.002 * scale, 0.001 * scale)], segments=12, mat=leaf_mat)
        leaves.append(leaf)
    return [pot, *leaves]


def lifestyle(preset: str, prod) -> SceneSet:
    """A real-scale set; the product's footprint radius decides how far props keep away."""
    clear = max(prod.radius, 0.04) + 0.12
    if preset == "kitchen":
        counter = speckled("Counter", "#E9E6E1", "#9C9890")
        objs = [_box("Counter", (2.6, 0.64, 0.04), (0.0, 0.07, -0.02), counter, bevel=0.003),
                _box("Cabinets", (2.6, 0.6, 0.86), (0.0, 0.08, -0.47), m.plastic("Cabinet", "#7E9184", 0.55),
                     bevel=0.002)]
        objs += _room(0.39, 3.0, 1.6, tiles("Backsplash", "#F4F2EE", "#C9C5BE", 0.15, 0.075, 0.5, 0.18), -0.9)
        objs.append(_box("Board", (0.38, 0.26, 0.022), (-clear - 0.24, 0.17, 0.011),
                         studio_env.wood_material("BoardWood", "#8A5B34", "#B07D4F", 0.3, planks=False),
                         bevel=0.008, rot=(0, 0, 0.12)))
        objs += _plant("Herb", (clear + 0.26, 0.2, 0.0), 0.9)
        _world("#FFF6EA", 0.35)
        return SceneSet("kitchen", (-1.4, 1.4, -2.5, 0.34, 1.4), 0.95, objs, fstop=2.8)
    if preset == "bathroom":
        stone = marble("Vanity")
        objs = [_box("Vanity", (2.0, 0.56, 0.03), (0.0, 0.05, -0.015), stone, bevel=0.003),
                _box("VanityBody", (2.0, 0.52, 0.8), (0.0, 0.07, -0.43), m.plastic("VanityWood", "#C9B79F", 0.6),
                     bevel=0.002)]
        objs += _room(0.33, 2.6, 1.5, tiles("WallTiles", "#E3DED6", "#BDB6AC", 0.3, 0.3, 0.0, 0.35), -0.83)
        towel = m.plastic("Towel", "#F4EFE8", 0.95)
        objs.append(_box("Towel", (0.26, 0.16, 0.05), (-clear - 0.2, 0.16, 0.025), towel, bevel=0.022,
                         rot=(0, 0, -0.08)))
        objs.append(_box("Towel2", (0.24, 0.15, 0.04), (-clear - 0.2, 0.16, 0.07), towel, bevel=0.018,
                         rot=(0, 0, 0.05)))
        objs.append(m.revolve("Dish", [(0.0, 0.0), (0.0, 0.05), (0.008, 0.055), (0.014, 0.05)], axis="Z",
                              segments=48, origin=(clear + 0.16, 0.12, 0.0), mat=m.plastic("Ceramic", "#FFFFFF", 0.2,
                                                                                           coat=0.6)))
        objs += _plant("Eucalyptus", (clear + 0.32, 0.22, 0.0), 0.8)
        _world("#F2F5F8", 0.5)
        return SceneSet("bathroom", (-1.2, 1.2, -2.5, 0.28, 1.4), 1.0, objs, fstop=2.8)
    if preset in ("workshop", "garage"):
        if preset == "workshop":
            top = studio_env.wood_material("Bench", "#9C6B3F", "#C49465", 0.22, planks=True, roughness=0.55)
            wall = pegboard("Pegboard")
            floor_mat = studio_env.concrete_material("ShopFloor", "#6F6B66", 0.4)
        else:
            top = m.metal("SteelTop", "#7C8087", 0.38)
            wall = studio_env.concrete_material("GarageWall", "#8F8C86", 0.4)
            floor_mat = studio_env.concrete_material("GarageFloor", "#5E5B57", 0.4)
        objs = [_box("Bench", (2.4, 0.7, 0.05), (0.0, 0.1, -0.025), top, bevel=0.004)]
        objs.append(_box("BenchFrame", (2.3, 0.62, 0.84), (0.0, 0.12, -0.47),
                         m.plastic("Frame", "#2E3135" if preset == "workshop" else "#A33A2E", 0.5), bevel=0.003))
        objs += _room(0.47, 3.0, 1.8, wall, -0.89, floor_mat)
        wood = studio_env.wood_material("Plank", "#B38A5E", "#D1AB7F", 0.25, planks=False, roughness=0.6)
        objs.append(_box("Plank", (0.6, 0.12, 0.022), (-clear - 0.3, 0.22, 0.011), wood, bevel=0.002,
                         rot=(0, 0, 0.18)))
        objs.append(_box("Plank2", (0.55, 0.1, 0.022), (-clear - 0.28, 0.24, 0.033), wood, bevel=0.002,
                         rot=(0, 0, 0.1)))
        screws = m.metal("Screw", "#C9B47A", 0.3)
        objs.append(m.revolve("ScrewTin", [(0.0, 0.0), (0.0, 0.045), (0.035, 0.045), (0.035, 0.0)], axis="Z",
                              segments=40, origin=(clear + 0.22, 0.18, 0.0), mat=m.metal("Tin", "#9DA3AA", 0.3)))
        for k in range(5):
            objs.append(m.cylinder(f"Screw{k}", 0.0022, 0.04, (clear + 0.12 + 0.012 * k, 0.05 - 0.01 * k, 0.003),
                                   axis="X", segments=12, mat=screws))
        _world("#2B2F35", 0.5)
        return SceneSet(preset, (-1.4, 1.4, -2.5, 0.42, 1.6), 1.05, objs, fstop=3.2)
    if preset == "living_room":
        env = studio_env.build_environment("warm_living", prod.size, prod.radius, 3.0 * prod.size, 3.0 * prod.size)
        return SceneSet("living_room", env.interior, env.light_mult, env.objects, fstop=3.2)
    if preset == "desk":
        env = studio_env.build_environment("natural_daylight", prod.size, prod.radius, 3.0 * prod.size,
                                           3.0 * prod.size)
        objs = list(env.objects)
        objs.append(_box("Notebook", (0.21, 0.15, 0.012), (-clear - 0.16, 0.12, 0.006),
                         m.plastic("NotebookCover", "#2F4A5E", 0.6), bevel=0.003, rot=(0, 0, -0.2)))
        objs.append(m.revolve("Mug", [(0.0, 0.0), (0.0, 0.04), (0.095, 0.042), (0.095, 0.036), (0.006, 0.034)],
                              axis="Z", segments=48, origin=(clear + 0.14, 0.16, 0.0),
                              mat=m.plastic("MugGlaze", "#E9E2D6", 0.25, coat=0.5)))
        return SceneSet("desk", env.interior, env.light_mult, objs, fstop=2.8)
    raise ValueError(f"unknown environment {preset!r}")


def background(preset: str, prod, reach: float, color: str | None, accent: str | None) -> SceneSet:
    size, radius = prod.size, prod.radius
    if preset in ("dark_gradient", "light_gradient", "seamless_white", "soft_pastel"):
        name = {"dark_gradient": "dark_premium", "light_gradient": "bright_minimal",
                "seamless_white": "bright_minimal", "soft_pastel": "soft_pastel"}[preset]
        env = studio_env.build_environment(name, size, radius, reach, 3.0 * size)
        return SceneSet(name, env.interior, env.light_mult, env.objects, fstop=5.6)
    if preset == "transparent":
        catcher = studio_env.plane("ShadowCatcher", (12 * size, 12 * size), (0.0, 0.0, 0.0), (0, 0, 0),
                                   studio_env.flat_material("Catcher", "#808080", 0.8))
        catcher.is_shadow_catcher = True
        _world("#BFC3C8", 0.8)
        return SceneSet("transparent", None, 1.0, [catcher], transparent=True, fstop=None)
    if preset == "brand_color":
        base = color or "#1E2A44"
        acc = accent or "#E39B26"
        r = max(7.0 * size, 1.4 * reach)
        cove = studio_env.cyclorama("Cyclorama", r, 1.8 * size, max(10.0 * size, 3.0 * size),
                                    studio_env.flat_material("BrandCove", base, 0.7, specular=0.3))
        cove.location.z = -0.18 * size
        ped = studio_env.plinth("Plinth", max(1.2 * radius, 0.32 * size), 0.18 * size,
                                studio_env.flat_material("BrandPlinth", base, 0.25, specular=0.6, coat=0.4))
        accent_mat = m.plastic("BrandAccent", acc, 0.3, coat=0.4)
        decor = []
        objs = [cove, ped]
        for k in range(3):
            ro, ri, t = (1.1 + 0.45 * k) * size, (1.1 + 0.45 * k) * size * 0.93, 0.012 * size
            ring = m.revolve(f"BrandRing{k}", [(-t, ri), (-t, ro), (t, ro), (t, ri), (-t, ri)], axis="Y",
                             segments=96, origin=(0.0, (1.6 + 0.5 * k) * size, 0.55 * size), cap_start=False,
                             cap_end=False,
                             mat=accent_mat if k != 1 else studio_env.flat_material("BrandRingDark", base, 0.4))
            objs.append(ring)
            decor.append((ring, (math.radians(70 + 8 * k), 0.0, math.radians(15 * k)), 0.25 + 0.12 * k))
        _world("#0B0F18", 0.6)
        return SceneSet("brand_sweep", None, 1.0, objs, decor=decor, fstop=4.0)
    raise ValueError(f"unknown background {preset!r}")
