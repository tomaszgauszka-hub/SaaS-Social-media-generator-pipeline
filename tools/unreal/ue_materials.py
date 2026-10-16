"""Material decisions for an imported product (pure CPython — unit-tested).

Input: the material compatibility report of tools/blender/scenes/export.py (one row per material, status
PBR_DIRECT / NEEDS_BAKE / APPROXIMATED / UNSUPPORTED, notes, texture names) and optional baked texture maps.
Output: one plan per material slot of the imported mesh:

  keep      use the material the importer created (it carries the exported PBR inputs / textures as they are)
  instance  a material instance of one of this tool's parent materials (PARENTS) with parameter values
  neutral   a neutral grey instance — the source shader cannot be represented (a warning says so)

Decisions (spec):
  PBR_DIRECT    → keep (direct)
  APPROXIMATED  → instance of the parent that represents the strongest non-PBR feature (transmission → translucent,
                  coat → clear coat, sheen / subsurface / anisotropy → opaque with roughness / specular tweaks);
                  a material with image textures is kept as imported instead (re-parenting would drop the maps) and
                  the tweak it needs is reported as a warning
  NEEDS_BAKE    → instance of the textured parent when baked maps are supplied (base colour at least), else keep
                  + a warning (procedural Blender nodes do not survive an export)
  UNSUPPORTED   → neutral + a warning
  no report row → keep + a warning (unclassified)
The runtime (ue_scene.py) creates the parents and instances under /Game/Render3D/Materials and assigns the plans to
the product's mesh components — the imported assets themselves are never modified.
"""

from __future__ import annotations

import hashlib
import json
import re

NEUTRAL = {"BaseColor": (0.55, 0.55, 0.55), "Roughness": 0.5, "Metallic": 0.0, "Specular": 0.5}

#: parent materials built by ue_scene (name → blend mode, shading model, parameters with defaults)
PARENTS = {
    "opaque": {
        "asset": "M_R3D_Opaque",
        "blend": "opaque",
        "shading": "default_lit",
        "vectors": {"BaseColor": (0.55, 0.55, 0.55), "EmissiveColor": (0.0, 0.0, 0.0)},
        "scalars": {"Roughness": 0.5, "Metallic": 0.0, "Specular": 0.5, "EmissiveStrength": 0.0},
        "textures": {},
    },
    "clearcoat": {
        "asset": "M_R3D_ClearCoat",
        "blend": "opaque",
        "shading": "clear_coat",
        "vectors": {"BaseColor": (0.55, 0.55, 0.55)},
        "scalars": {"Roughness": 0.4, "Metallic": 0.0, "Specular": 0.5, "ClearCoat": 1.0,
                    "ClearCoatRoughness": 0.05},
        "textures": {},
    },
    "translucent": {
        "asset": "M_R3D_Translucent",
        "blend": "translucent",
        "shading": "default_lit",
        "vectors": {"BaseColor": (0.9, 0.9, 0.9)},
        "scalars": {"Roughness": 0.05, "Metallic": 0.0, "Specular": 0.5, "Opacity": 0.3},
        "textures": {},
    },
    "textured": {
        "asset": "M_R3D_Textured",
        "blend": "opaque",
        "shading": "default_lit",
        "vectors": {"BaseColorTint": (1.0, 1.0, 1.0)},
        "scalars": {"RoughnessScale": 1.0, "MetallicScale": 1.0},
        #: parameter → sampler kind (color = sRGB, linear = grayscale data, normal = tangent-space normal)
        "textures": {"BaseColorMap": "color", "RoughnessMap": "linear", "MetallicMap": "linear",
                     "NormalMap": "normal"},
    },
}
BAKE_TO_PARAM = {"baseColor": "BaseColorMap", "roughness": "RoughnessMap", "metallic": "MetallicMap",
                 "normal": "NormalMap"}

_NOTE = re.compile(r"^(Transmission Weight|Coat Weight|Sheen Weight|Subsurface Weight|Anisotropic)=([0-9]*\.?[0-9]+)")


def normalise_name(name: str) -> str:
    """Comparable material name: importers rename (spaces / dots → '_', 'M_' / 'MI_' prefixes, '_001' suffixes)."""
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    s = re.sub(r"^(mi|m|mat)_", "", s)
    s = re.sub(r"_(mat|material)$", "", s)
    return s


def match_rows(slot_names: list[str], report: dict | None) -> dict[str, dict | None]:
    """Report row per material slot name (exact name first, then the normalised name, then a numbered duplicate
    like 'Body_001' of 'Body')."""
    rows = (report or {}).get("materials", [])
    exact = {r["material"]: r for r in rows}
    norm = {normalise_name(r["material"]): r for r in rows}
    out: dict[str, dict | None] = {}
    for slot in slot_names:
        if slot in exact:
            out[slot] = exact[slot]
            continue
        n = normalise_name(slot)
        if n in norm:
            out[slot] = norm[n]
            continue
        base = re.sub(r"_\d{1,3}$", "", n)
        out[slot] = norm.get(base)
    return out


def note_values(notes: list[str]) -> dict[str, float]:
    """Approximated Principled inputs named in the report notes, e.g. 'Coat Weight=0.80: …' → {'Coat Weight': 0.8}."""
    vals: dict[str, float] = {}
    for n in notes:
        m = _NOTE.match(n)
        if m:
            vals[m.group(1)] = max(0.0, min(1.0, float(m.group(2))))
    return vals


def _hex_to_linear(hex_color: str) -> tuple[float, float, float]:
    """#RRGGBB (sRGB) → linear RGB (material parameters are linear)."""
    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return tuple(round(lin(int(hex_color[i:i + 2], 16) / 255.0), 5) for i in (1, 3, 5))  # type: ignore[return-value]


def plan_material(slot: str, row: dict | None, baked: dict | None) -> dict:
    """The plan for one material slot (see the module docstring)."""
    if row is None:
        return {"slot": slot, "material": None, "status": None, "action": "keep", "parent": None, "scalars": {},
                "vectors": {}, "textures": {},
                "warnings": [f"material {slot!r} is not in the material report: used as imported"]}
    status = row["status"]
    plan = {"slot": slot, "material": row["material"], "status": status, "action": "keep", "parent": None,
            "scalars": {}, "vectors": {}, "textures": {}, "warnings": []}
    base = _hex_to_linear(row["baseColor"]) if row.get("baseColor") else None
    if status == "PBR_DIRECT":
        return plan
    if status == "UNSUPPORTED":
        plan.update(action="neutral", parent="opaque", vectors={"BaseColor": NEUTRAL["BaseColor"]},
                    scalars={k: v for k, v in NEUTRAL.items() if k != "BaseColor"})
        plan["warnings"].append(f"material {row['material']!r} cannot be represented in UE (custom shader): "
                                "neutral grey stand-in — rebuild it as a UE material")
        return plan
    if status == "NEEDS_BAKE":
        maps = baked or {}
        if "baseColor" in maps:
            plan.update(action="instance", parent="textured",
                        textures={BAKE_TO_PARAM[ch]: path for ch, path in sorted(maps.items())})
            missing = [ch for ch in ("roughness", "normal") if ch not in maps]
            if missing:
                plan["warnings"].append(f"material {row['material']!r}: baked {', '.join(missing)} map(s) missing — "
                                        "parent defaults used")
            return plan
        plan["warnings"].append(f"material {row['material']!r} uses procedural Blender nodes and no baked maps were "
                                "supplied: shown as imported (bake base colour / roughness / normal first)")
        return plan
    # APPROXIMATED
    vals = note_values(row.get("notes", []))
    if row.get("textures"):
        need = ", ".join(f"{k}={v:.2f}" for k, v in sorted(vals.items())) or "a custom shader feature"
        plan["warnings"].append(f"material {row['material']!r} is approximated and has image textures: kept as "
                                f"imported; tweak {need} on a UE material instance by hand")
        return plan
    roughness = row.get("roughness")
    metallic = row.get("metallic")
    scalars: dict[str, float] = {}
    if vals.get("Transmission Weight", 0.0) > 0.01:
        parent = "translucent"
        tw = vals["Transmission Weight"]
        scalars["Opacity"] = round(max(0.12, 1.0 - 0.85 * tw), 4)
        scalars["Roughness"] = round(min(0.25, roughness if roughness is not None else 0.05), 4)
    elif vals.get("Coat Weight", 0.0) > 0.01:
        parent = "clearcoat"
        scalars["ClearCoat"] = round(vals["Coat Weight"], 4)
        scalars["ClearCoatRoughness"] = 0.05
        if roughness is not None:
            scalars["Roughness"] = round(roughness, 4)
    else:
        parent = "opaque"
        r = roughness if roughness is not None else 0.5
        if vals.get("Sheen Weight", 0.0) > 0.01:
            r = min(1.0, r + 0.25 * vals["Sheen Weight"])
            scalars["Specular"] = round(0.5 - 0.2 * vals["Sheen Weight"], 4)
        if vals.get("Subsurface Weight", 0.0) > 0.01:
            r = min(1.0, r + 0.1 * vals["Subsurface Weight"])
        if vals.get("Anisotropic", 0.0) > 0.01:
            r = max(0.05, r - 0.1 * vals["Anisotropic"])
        scalars["Roughness"] = round(r, 4)
    if metallic is not None:
        scalars["Metallic"] = round(metallic, 4)
    vectors = {"BaseColor": base} if base else {}
    if base is None:
        plan["warnings"].append(f"material {row['material']!r}: no base colour in the report — the approximation "
                                "uses the imported colour if the importer exposes it, else neutral grey")
    named = ", ".join(sorted(vals)) or "non-PBR inputs"
    plan["warnings"].append(f"material {row['material']!r} approximated in UE ({named} → {parent} instance)")
    plan.update(action="instance", parent=parent, scalars=scalars, vectors=vectors)
    return plan


def plan_materials(slot_names: list[str], report: dict | None, baked: dict | None) -> dict:
    """Plans for every slot + summary warnings + a deterministic hash of the decisions (result.json)."""
    warnings: list[str] = []
    if report is None:
        warnings.append("no material report for this model: materials used as imported (export it with "
                        "tools/blender/scenes/export.py to classify them)")
    rows = match_rows(slot_names, report)
    plans = []
    for slot in slot_names:
        row = rows.get(slot)
        if report is None:
            plan = {"slot": slot, "material": None, "status": None, "action": "keep", "parent": None, "scalars": {},
                    "vectors": {}, "textures": {}, "warnings": []}
        else:
            plan = plan_material(slot, row, (baked or {}).get(row["material"]) if row else None)
        plans.append(plan)
        warnings.extend(plan["warnings"])
    canon = json.dumps([{k: p[k] for k in ("slot", "status", "action", "parent", "scalars", "vectors")} for p in plans],
                       sort_keys=True, default=list)
    return {"plans": plans, "warnings": warnings, "hash": hashlib.sha256(canon.encode()).hexdigest()}


def instance_name(plan: dict, asset_id: str) -> str:
    """Stable, collision-free material instance asset name for a plan."""
    key = json.dumps({k: plan[k] for k in ("parent", "scalars", "vectors", "textures")}, sort_keys=True, default=list)
    slot = re.sub(r"[^A-Za-z0-9_]", "_", plan["slot"])[:40]
    return f"MI_{re.sub(r'[^A-Za-z0-9_]', '_', asset_id)[:40]}_{slot}_{hashlib.sha256(key.encode()).hexdigest()[:8]}"
