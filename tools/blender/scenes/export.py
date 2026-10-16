"""Blender → Unreal Engine export of a product (glTF binary / FBX) and the material compatibility report.

Conventions (checked again by the UE import script, tools/unreal/ue_scene.py):
  * metres in Blender, centimetres in UE: FBX is written with FBX_SCALE_UNITS (1 Blender unit = 100 UE units);
    glTF is metres by specification and UE's Interchange importer converts it;
  * Z up; the product's front faces −Y in Blender (+X forward in UE after import);
  * transforms applied on export (no stray object scale), normals and tangents written, UVs kept;
  * only the product: studio sets, lights and cameras never leave Blender.

Shaders do not travel: only what maps onto UE's Metallic/Roughness PBR inputs survives an export. The report
classifies every material so nothing is silently lost:
  PBR_DIRECT   Principled BSDF with constant inputs or image textures only        → exported as is
  NEEDS_BAKE   procedural textures / node math feed the Principled inputs          → bake to textures first
  APPROXIMATED transmission, coat, sheen, subsurface, anisotropy, emission strength → UE material instance tweak
  UNSUPPORTED  no Principled BSDF on the output (custom shader networks)           → rebuild in UE
"""

from __future__ import annotations

import os

import bpy

PROCEDURAL = {
    "TEX_NOISE", "TEX_VORONOI", "TEX_WAVE", "TEX_BRICK", "TEX_CHECKER", "TEX_GRADIENT", "TEX_MAGIC",
    "TEX_MUSGRAVE", "TEX_WHITE_NOISE", "TEX_SKY", "VALTORGB", "MATH", "MAP_RANGE", "MIX", "MIX_RGB",
    "SEPXYZ", "SEPARATE_XYZ", "COMBXYZ", "COMBINE_XYZ", "VECT_MATH", "TEX_COORD", "MAPPING", "LAYER_WEIGHT",
    "FRESNEL", "BUMP",
}
APPROX_INPUTS = {
    "Transmission Weight": 0.01,
    "Coat Weight": 0.01,
    "Sheen Weight": 0.01,
    "Subsurface Weight": 0.01,
    "Anisotropic": 0.01,
}


def _upstream(node, seen=None):
    seen = seen if seen is not None else set()
    for inp in node.inputs:
        for link in inp.links:
            n = link.from_node
            if n.name not in seen:
                seen.add(n.name)
                yield n
                yield from _upstream(n, seen)


def classify_material(mat: bpy.types.Material) -> dict:
    out = {"material": mat.name, "status": "PBR_DIRECT", "notes": [], "textures": []}
    if not mat.use_nodes or not mat.node_tree:
        out["notes"].append("no node tree: base colour only")
        return out
    nt = mat.node_tree
    output = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None) or \
        next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if output is None or not output.inputs["Surface"].links:
        out["status"] = "UNSUPPORTED"
        out["notes"].append("material has no surface output")
        return out
    shader = output.inputs["Surface"].links[0].from_node
    if shader.type != "BSDF_PRINCIPLED":
        principled = [n for n in _upstream(output) if n.type == "BSDF_PRINCIPLED"]
        out["status"] = "UNSUPPORTED" if not principled else "APPROXIMATED"
        out["notes"].append(f"surface is {shader.type}: rebuild as a UE material (mix / custom shader)")
        if not principled:
            return out
        shader = principled[0]
    upstream = list(_upstream(shader))
    procedural = sorted({n.type for n in upstream if n.type in PROCEDURAL})
    images = [n for n in upstream if n.type == "TEX_IMAGE" and n.image is not None]
    out["textures"] = sorted({n.image.name for n in images})
    if procedural:
        out["status"] = "NEEDS_BAKE"
        out["notes"].append(f"procedural nodes {', '.join(procedural)}: bake base colour / roughness / normal")
    for name, eps in APPROX_INPUTS.items():
        sock = shader.inputs.get(name)
        if sock is not None and not sock.links and float(sock.default_value) > eps:
            if out["status"] == "PBR_DIRECT":
                out["status"] = "APPROXIMATED"
            out["notes"].append(f"{name}={float(sock.default_value):.2f}: needs a UE material instance setting")
    em = shader.inputs.get("Emission Strength")
    animated = bool(mat.node_tree.animation_data and mat.node_tree.animation_data.action)
    if em is not None and (em.links or float(em.default_value) > 0 or animated):
        out["notes"].append("emission: map to an emissive scalar parameter (animated in the Level Sequence)")
    return out


def material_report(objs) -> dict:
    mats = sorted({s.material for o in objs for s in o.material_slots if s.material}, key=lambda x: x.name)
    rows = [classify_material(mm) for mm in mats]
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"materials": rows, "counts": counts,
            "ueReady": all(r["status"] in ("PBR_DIRECT", "APPROXIMATED") for r in rows)}


def _select_only(objs) -> None:
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def export_product(objs, out_dir: str, formats: list[str]) -> dict:
    """Write the product meshes as product.glb / product.fbx (UE conventions above)."""
    os.makedirs(out_dir, exist_ok=True)
    objs = [o for o in objs if o.type == "MESH" and not o.hide_render]
    if not objs:
        raise RuntimeError("nothing to export")
    files = {}
    _select_only(objs)
    if "glb" in formats:
        path = os.path.join(out_dir, "product.glb")
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True,
                                  export_yup=True, export_tangents=True, export_cameras=False,
                                  export_lights=False, export_animations=False)
        files["glb"] = path
    if "fbx" in formats:
        path = os.path.join(out_dir, "product.fbx")
        bpy.ops.export_scene.fbx(filepath=path, use_selection=True, apply_unit_scale=True,
                                 apply_scale_options="FBX_SCALE_UNITS", axis_forward="-Y", axis_up="Z",
                                 use_mesh_modifiers=True, mesh_smooth_type="FACE", use_tspace=True,
                                 add_leaf_bones=False, bake_anim=False, path_mode="COPY", embed_textures=False,
                                 object_types={"MESH", "EMPTY"})
        files["fbx"] = path
    dims = _dimensions(objs)
    return {"files": files, "dimensionsM": dims, "dimensionsUeCm": [round(d * 100.0, 3) for d in dims],
            "triangles": _triangles(objs), "objects": len(objs)}


def _dimensions(objs) -> list[float]:
    from mathutils import Vector

    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    dg = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        ev = o.evaluated_get(dg)
        for c in ev.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return [round(float(hi[i] - lo[i]), 5) for i in range(3)]


def _triangles(objs) -> int:
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            me.calc_loop_triangles()
            n += len(me.loop_triangles)
        finally:
            ev.to_mesh_clear()
    return n
