"""Parametric 3D scene generator: one validated scene job → a rendered clip (PNG frames) + result.json.

    <python-with-bpy> tools/blender/scenes/run.py <scene-job.json>
    blender -b --factory-startup --python tools/blender/scenes/run.py -- <scene-job.json>

Templates (scene_spec.TEMPLATES): PRODUCT_HERO, TURNTABLE_360, MACRO_DETAIL, EXPLODED_VIEW, PRODUCT_ASSEMBLY,
LIFESTYLE, TECHNICAL, BRAND_ENVIRONMENT. Every motion is a deterministic function of the clip time; every value
is keyframed per frame, so the saved .blend replays exactly what was rendered.

Nothing language-specific is ever rendered: no text, prices or CTAs. The 2D layer (Remotion / FFmpeg) adds
them, so one clip serves every locale. The result reports per-frame product boxes and anchor tracks (normalised
frame coordinates) so overlays can point at parts.

Exit codes: 0 ok · 2 usage · 3 invalid job · 1 render error.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

import compat
import export as exporter
import framing
import lighting as studio_lighting
import modeling as m
import products
import scene_env
import scene_spec as spec_mod
from scene_spec import SceneJobError

SCENE_VERSION = "scene-gen/1"
CONTROL_VIEWS = (("front", 0.0, 6.0), ("right", 90.0, 6.0), ("back", 180.0, 6.0), ("left", 270.0, 6.0),
                 ("top", 0.0, 82.0), ("three_quarter", -38.0, 22.0))


def ms_since(t0: float) -> int:
    return int(round((time.monotonic() - t0) * 1000))


# ------------------------------------------------------------------------------------------ camera plans ----

#: preset → (base az, az span, base el, el span, fill, lens mm, dolly) — spans scale with the movement speed
CAMERA = {
    "orbit_closeup": (-26.0, 52.0, 12.0, 0.0, 0.60, 65.0, 0.0),
    "orbit_wide": (-34.0, 76.0, 17.0, 0.0, 0.42, 45.0, 0.0),
    "turntable": (-30.0, 0.0, 11.0, 0.0, 0.58, 70.0, 0.0),
    "push_in": (-24.0, 12.0, 10.0, 0.0, 0.46, 55.0, 0.32),
    "crane_up": (-18.0, 6.0, -4.0, 34.0, 0.55, 50.0, 0.0),
    # products face −Y: az ≈ 0 is their side profile (a drill's classic silhouette)
    "dolly_side": (-6.0, 0.0, 6.0, 0.0, 0.74, 60.0, 0.0),
    "macro_slide": (-22.0, 34.0, 9.0, 4.0, 0.0, 100.0, 0.0),
    "top_down": (-22.0, 40.0, 78.0, 0.0, 0.58, 50.0, 0.0),
    "hero_low": (-32.0, 26.0, 2.0, 6.0, 0.64, 40.0, 0.12),
}


def camera_angles(preset: str, movement: float, t: float) -> tuple[float, float, float]:
    """(az, el, dolly fraction) at clip time t ∈ [0, 1]."""
    az0, az_span, el0, el_span, _fill, _lens, dolly = CAMERA[preset]
    e = spec_mod.ease_in_out(t)
    az = az0 + az_span * movement * (e - 0.5) if preset != "push_in" else az0 + az_span * movement * e
    el = el0 + el_span * movement * e
    return az, el, dolly * movement * e


# ------------------------------------------------------------------------------------------ scene setup -----


def configure(scene, job: dict, n_frames: int) -> dict:
    w, h = spec_mod.render_size(job)
    q = spec_mod.QUALITY[job["quality"]]
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.render.fps = job["fps"]
    scene.frame_start, scene.frame_end = 1, n_frames
    device = {"device": "CPU", "backend": "NONE", "devices": []}
    if job["renderer"] == "EEVEE":
        scene.render.engine = compat.eevee_engine_id()
        ee = scene.eevee
        if hasattr(ee, "taa_render_samples"):
            ee.taa_render_samples = job["samples"] or (32 if job["quality"] == "preview" else 96)
    else:
        scene.render.engine = "CYCLES"
        prefer = "CPU" if job["device"] == "CPU" else "GPU"
        device = compat.configure_cycles_device(scene, prefer)
        if job["device"] == "GPU" and device["device"] != "GPU":
            device["fallback"] = "no usable GPU backend: rendered on CPU"
        cy = scene.cycles
        cy.samples = job["samples"] or q["samples"]
        cy.use_adaptive_sampling = True
        cy.adaptive_threshold = q["threshold"]
        cy.use_denoising = q["denoise"]
        cy.denoiser = "OPENIMAGEDENOISE"
        cy.max_bounces = q["bounces"]
        cy.diffuse_bounces = min(4, q["bounces"])
        cy.glossy_bounces = min(6, q["bounces"])
        cy.transmission_bounces = q["bounces"]
        cy.transparent_max_bounces = 12
        cy.caustics_reflective = False
        cy.caustics_refractive = False
        cy.sample_clamp_indirect = 8.0
        cy.blur_glossy = 1.0
        cy.seed = job["seed"]
        cy.use_animated_seed = False
    if job["threads"] > 0:
        scene.render.threads_mode = "FIXED"
        scene.render.threads = job["threads"]
    scene.render.use_persistent_data = True
    scene.render.use_compositing = False
    scene.render.use_sequencer = False
    scene.render.film_transparent = job["outputs"]["alpha"]
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "None"
    scene.display_settings.display_device = "sRGB"
    img = scene.render.image_settings
    img.file_format = "PNG"
    img.color_mode = "RGBA" if job["outputs"]["alpha"] else "RGB"
    img.color_depth = "8"
    img.compression = 15
    return device


def new_camera(name: str):
    data = bpy.data.cameras.new(name)
    data.sensor_fit = "VERTICAL"
    data.sensor_height = framing.SENSOR_HEIGHT_MM
    data.clip_start = 0.005
    data.clip_end = 200.0
    cam = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(cam)
    return cam


def place_camera(cam, pos, target, lens_mm: float, shift=(0.0, 0.0)) -> framing.Basis:
    basis = framing.look_at(tuple(pos), tuple(target))
    cam.location = Vector(pos)
    cam.rotation_euler = Matrix(basis.matrix3()).to_euler()
    cam.data.lens = lens_mm
    cam.data.shift_x, cam.data.shift_y = shift
    return basis


# --------------------------------------------------------------------------------------- product states -----


class PartTracker:
    """Product points per part in the part handle's local space: transformed per frame for boxes / anchors."""

    def __init__(self, prod: products.SceneProduct, limit: int = 1600):
        self.items = []
        total = max(1, len(prod.points))
        bpy.context.view_layer.update()
        for name, part in prod.parts.items():
            if part.internal:
                continue
            pts = prod.part_points(name)
            if not len(pts):
                continue
            k = max(12, int(limit * len(pts) / total))
            idx = np.linspace(0, len(pts) - 1, min(k, len(pts))).astype(int)
            inv = np.array(part.handle.matrix_world.inverted())
            local = pts[idx] @ inv[:3, :3].T + inv[:3, 3]
            self.items.append((part, local))

    def world_points(self) -> np.ndarray:
        out = []
        for part, local in self.items:
            mw = np.array(part.handle.matrix_world)
            out.append(local @ mw[:3, :3].T + mw[:3, 3])
        return np.concatenate(out) if out else np.zeros((0, 3))


def apply_template_state(job: dict, prod: products.SceneProduct, t: float, frame: int, sset) -> None:
    """Product pivot, part offsets, reveal and decor for clip time t (keyframed at `frame`)."""
    tpl = job["template"]
    piv = prod.pivot
    rot_z, lift = 0.0, 0.0
    if tpl == "TURNTABLE_360":
        rot_z = 2 * math.pi * job["turns"] * t
    elif tpl in ("PRODUCT_HERO", "BRAND_ENVIRONMENT"):
        rot_z = math.radians(-9.0 + 18.0 * spec_mod.ease_in_out(t))
        lift = 0.012 * prod.size * math.sin(math.pi * t) if not sset.transparent else 0.0
    if tpl == "EXPLODED_VIEW":
        # parts that drop (a battery) must not sink through the floor: the whole product rises as it explodes
        drop = max([0.0] + [-p.explode[2] for p in prod.parts.values() if not p.internal])
        lift = (drop + 0.01 * prod.size) * spec_mod.explode_progress(t) if drop > 0 else 0.0
    piv.rotation_euler = (0.0, 0.0, rot_z)
    piv.location = (0.0, 0.0, lift)
    piv.keyframe_insert("rotation_euler", frame=frame)
    piv.keyframe_insert("location", frame=frame)

    if tpl in ("EXPLODED_VIEW", "PRODUCT_ASSEMBLY"):
        count = 1 + max((p.order for p in prod.parts.values()), default=0)
        for p in prod.parts.values():
            if p.internal:
                continue
            if tpl == "EXPLODED_VIEW":
                k = spec_mod.explode_progress(t)
            else:
                k = 2.4 * (1.0 - spec_mod.assembly_progress(t, p.order, count))
            rest = p.handle["rest"]
            p.handle.location = (rest[0] + p.explode[0] * k, rest[1] + p.explode[1] * k, rest[2] + p.explode[2] * k)
            p.handle.keyframe_insert("location", frame=frame)
    if tpl == "TECHNICAL":
        reveal = spec_mod.ease_in_out((t - 0.06) / 0.24)
        for mat in prod.reveal_materials:
            m.keyframe_reveal(mat, reveal, frame)
    for obj, base, speed in sset.decor:
        obj.rotation_euler = (base[0], base[1] + speed * 2 * math.pi * t * 0.25, base[2] + 0.4 * speed * t)
        obj.keyframe_insert("rotation_euler", frame=frame)


def default_actions(job: dict, prod: products.SceneProduct) -> list[spec_mod.ActionSpec]:
    """A TECHNICAL clip without explicit actions demonstrates what the product declares it can do."""
    if job["actions"] or job["template"] != "TECHNICAL":
        return job["actions"]
    d = job["durationSec"]
    plan = []
    if "TRIGGER_PRESS" in prod.actions:
        plan.append(spec_mod.ActionSpec("TRIGGER_PRESS", 0.36 * d, 0.44 * d))
    if "LED_ON" in prod.actions:
        plan.append(spec_mod.ActionSpec("LED_ON", 0.38 * d, 0.46 * d))
    if "CHUCK_SPIN" in prod.actions:
        plan.append(spec_mod.ActionSpec("CHUCK_SPIN", 0.4 * d, 0.62 * d))
    if "CAP_OPEN" in prod.actions:
        plan.append(spec_mod.ActionSpec("CAP_OPEN", 0.4 * d, 0.6 * d))
    if "LIGHT_ON" in prod.actions:
        plan.append(spec_mod.ActionSpec("LIGHT_ON", 0.35 * d, 0.5 * d))
    return plan


def framing_points(job: dict, prod: products.SceneProduct, tracker: PartTracker) -> list:
    """Points the camera must keep in frame over the whole clip (rotation / explode envelopes)."""
    base = tracker.world_points()
    tpl = job["template"]
    sets = [base]
    if tpl in ("TURNTABLE_360", "PRODUCT_HERO", "BRAND_ENVIRONMENT"):
        for k in range(1, 8 if tpl == "TURNTABLE_360" else 3):
            a = (2 * math.pi * k / 8) if tpl == "TURNTABLE_360" else math.radians(9.0 * (1 if k == 1 else -1))
            c, s = math.cos(a), math.sin(a)
            r = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
            sets.append(base @ r.T)
    if tpl == "EXPLODED_VIEW":
        drop = max([0.0] + [-p.explode[2] for p in prod.parts.values() if not p.internal])
        lift = np.array([0.0, 0.0, drop + 0.01 * prod.size if drop > 0 else 0.0])
        moved = []
        for part, local in tracker.items:
            mw = np.array(part.handle.matrix_world)
            moved.append(local @ mw[:3, :3].T + mw[:3, 3] + np.array(part.explode) + lift)
        sets.append(np.concatenate(moved))
    pts = np.concatenate(sets)
    if len(pts) > 2400:
        pts = pts[np.linspace(0, len(pts) - 1, 2400).astype(int)]
    return [tuple(map(float, p)) for p in pts]


def focus_target(job: dict, prod: products.SceneProduct) -> tuple[tuple, float, str | None]:
    """(target point, extent radius, focus part) — the focus part for macro shots, the product centre otherwise."""
    focus = job["focus"]
    if job["template"] == "MACRO_DETAIL" or job["camera"]["preset"] == "macro_slide":
        if focus is None:
            # the most detailed visible part: smallest non-body part with an anchor
            cands = [p for p in prod.parts.values() if not p.internal and p.role in ("detail", "control")]
            focus = cands[0].name if cands else next(iter(prod.parts))
        if focus not in prod.parts and focus not in prod.anchors:
            raise SceneJobError(f"job.focus {focus!r} is not a part of this product "
                                f"({', '.join(sorted(prod.parts))})")
        target = products.anchor_world(prod, focus)
        if focus in prod.parts:
            pts = prod.part_points(focus)
            ext = float(np.max(np.linalg.norm(pts - np.array(target), axis=1))) if len(pts) else 0.02
        else:
            ext = 0.08 * prod.size
        return target, max(ext, 0.06 * prod.size), focus
    lo, hi = prod.points.min(axis=0), prod.points.max(axis=0)
    c = (lo + hi) / 2
    return (float(c[0]), float(c[1]), float(c[2])), float(np.linalg.norm(hi - lo) / 2), None


# ------------------------------------------------------------------------------------------------- run ----


def run(job: dict) -> dict:
    t_all = time.monotonic()
    out_dir = job["output"]["dir"]
    frames_dir = os.path.join(out_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    version = compat.require_supported()
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    scene = bpy.context.scene
    n = spec_mod.frame_count(job["durationSec"], job["fps"])
    device = configure(scene, job, n)
    warnings: list[str] = []
    if device.get("fallback"):
        warnings.append(device["fallback"])

    # ---- product
    t0 = time.monotonic()
    p = job["product"]
    prod = products.build_procedural(p["generator"], p.get("params", {})) if p["source"] == "procedural" \
        else products.from_file(p)
    tpl = job["template"]
    if tpl == "TECHNICAL":
        for part in prod.parts.values():
            if part.internal:
                for o in part.objs:
                    o.hide_render = False
                    o.hide_viewport = False
        reveal = []
        for mat in prod.reveal_materials:
            xm = m.xray_reveal(f"{mat.name}.Reveal", mat, "#7FD4FF")
            for o in prod.meshes:
                for slot in o.material_slots:
                    if slot.material == mat:
                        slot.material = xm
            reveal.append(xm)
        prod.reveal_materials = reveal
        if not reveal:
            warnings.append("TECHNICAL: the product declares no housing to reveal — mechanism shown as is")
    missing = products.missing_textures(prod)
    if missing:
        warnings.append(f"missing textures: {', '.join(missing)}")
    geometry_hash = products.geometry_hash(prod)
    material_hash = products.material_hash(prod)
    product_ms = ms_since(t0)

    # ---- set + lights + camera plan
    t0 = time.monotonic()
    preset = job["camera"]["preset"]
    movement = spec_mod.MOVEMENTS[job["camera"]["movement"]]
    target, extent, focus_part = focus_target(job, prod)
    lens_mm = CAMERA[preset][5]
    w, h = scene.render.resolution_x, scene.render.resolution_y
    tracker = PartTracker(prod)
    pts = framing_points(job, prod, tracker)
    if focus_part is None:  # frame the whole motion envelope (explode / turntable), not just the rest pose
        arr = np.array(pts)
        c = (arr.min(axis=0) + arr.max(axis=0)) / 2
        target = (float(c[0]), float(c[1]), float(c[2]))
    if preset == "macro_slide":
        # the focus part spans ~55 % of the frame height (a readable piece of the product stays in frame)
        frame_h = max(2.0 * extent / 0.55, 0.22 * prod.height)
        dist = frame_h * lens_mm / framing.SENSOR_HEIGHT_MM
    else:
        fill = job["framing"]["fill"] or CAMERA[preset][4]
        dist = 0.0
        for tt in (0.0, 0.5, 1.0):
            az, el, _ = camera_angles(preset, movement, tt)
            fit = framing.fit_camera(pts, target, az, el, lens_mm, w, h, fill, max_width=0.9)
            dist = max(dist, fit.distance)
    reach = dist * 1.3 + prod.size
    bg = job["background"]
    if tpl == "LIFESTYLE" or bg["preset"] == "environment":
        sset = scene_env.lifestyle(job["environment"]["preset"], prod)
    else:
        bg_preset = "brand_color" if tpl == "BRAND_ENVIRONMENT" and bg["preset"] != "transparent" else bg["preset"]
        sset = scene_env.background(bg_preset, prod, reach, bg.get("color"), bg.get("accent"))
    rig_name, mult, _accent_k = spec_mod.LIGHTING[job["lighting"]["preset"]]
    rig = studio_lighting.Lighting(prod.size, sset.interior, sset.light_mult * mult)
    rig.activate(rig_name, (float(target[0]), float(target[1]), float(prod.height * 0.5)))
    cam = new_camera("SceneCamera")
    scene.camera = cam
    fstop = sset.fstop
    if preset == "macro_slide":
        fstop = 4.0 if job["quality"] == "production" else 4.5
    cam.data.dof.use_dof = fstop is not None
    if fstop is not None:
        cam.data.dof.aperture_fstop = fstop

    actions = default_actions(job, prod)
    for a in actions:
        if a.kind not in prod.actions:
            raise SceneJobError(f"action {a.kind} is not supported by this product "
                                f"(supported: {', '.join(sorted(prod.actions)) or 'none'})")
    fps = job["fps"]
    # anchors in the local space of what carries them (a part's handle, else the product pivot), at rest
    bpy.context.view_layer.update()
    anchors = {}
    for k, a in prod.anchors.items():
        carrier = prod.parts[k].handle if k in prod.parts else prod.pivot
        anchors[k] = (carrier, carrier.matrix_world.inverted() @ Vector(a))
    tracks: dict[str, list] = {k: [] for k in anchors}
    boxes: list[list[float]] = []
    cameras: list[dict] = []
    sweep_on = tpl in ("PRODUCT_HERO", "MACRO_DETAIL", "BRAND_ENVIRONMENT")
    for f in range(1, n + 1):
        t = (f - 1) / max(1, n - 1)
        tsec = t * job["durationSec"]
        apply_template_state(job, prod, t, f, sset)
        for a in actions:
            prod.actions[a.kind](spec_mod.action_progress(a, tsec), f)
        az, el, dolly = camera_angles(preset, movement, t)
        d = dist * (1.0 - dolly)
        tgt = list(target)
        if preset == "dolly_side":
            span = float(prod.points[:, 0].max() - prod.points[:, 0].min())
            tgt[0] += span * 0.16 * movement * (spec_mod.ease_in_out(t) - 0.5)
        pos = framing.add(tuple(tgt), framing.scale(framing.direction(az, el), d))
        if pos[2] < 0.02 * prod.size and not sset.transparent:
            pos = (pos[0], pos[1], 0.02 * prod.size)
        # lens shift puts the target at framing.centerY (portrait: shift is relative to the frame height)
        shift_y = (job["framing"]["centerY"] - 0.5) * h / max(w, h)
        basis = place_camera(cam, pos, tgt, lens_mm, (0.0, shift_y))
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
        cam.data.keyframe_insert("shift_y", frame=f)
        if fstop is not None:
            focus = d
            if preset == "macro_slide":  # rack focus into the detail over the first third
                focus = d * (0.9 + 0.1 * spec_mod.ease_in_out(t / 0.33))
            cam.data.dof.focus_distance = focus
            cam.data.dof.keyframe_insert("focus_distance", frame=f)
        rig.set_levels(1.0, 1.0, 1.0, 0.0, (2.0 * t - 1.0) if sweep_on else None, frame=f)
        # per-frame product box and anchor tracks (after this frame's transforms)
        bpy.context.view_layer.update()
        lens = framing.Lens(lens_mm, w, h, 0.0, shift_y)
        wp = tracker.world_points()
        try:
            u0, v0, u1, v1 = framing.project_box([tuple(x) for x in wp[:: max(1, len(wp) // 600)]], pos, basis,
                                                 lens)
            boxes.append([round(u0, 4), round(v0, 4), round(u1, 4), round(v1, 4)])
        except ValueError:
            boxes.append([0.0, 0.0, 0.0, 0.0])
        for k, (carrier, local) in anchors.items():
            a = tuple(carrier.matrix_world @ local)
            u, v, z = framing.project(a, pos, basis, lens)
            tracks[k].append([round(u, 4), round(v, 4)] if z > 0 and not math.isnan(u) else None)
        cameras.append({"az": round(az, 2), "el": round(el, 2), "d": round(d, 4)})
    setup_ms = ms_since(t0)

    # ---- render
    t0 = time.monotonic()
    frame_ms: list[int] = []
    if job["outputs"]["frames"]:
        for f in range(1, n + 1):
            tf = time.monotonic()
            scene.frame_set(f)
            scene.render.filepath = os.path.join(frames_dir, f"f_{f:04d}.png")
            bpy.ops.render.render(write_still=True)
            frame_ms.append(ms_since(tf))
            print(f"PROGRESS job={job['jobId']} frame={f}/{n} ms={frame_ms[-1]}", flush=True)
    render_ms = ms_since(t0)

    # ---- control views, exports, .blend
    scene.frame_set(1)
    views = []
    if job["outputs"]["controlViews"]:
        views = control_views(job, prod, tracker, os.path.join(out_dir, "views"), sset)
    blend = None
    if job["outputs"]["blend"]:
        blend = os.path.join(out_dir, "scene.blend")
        bpy.ops.wm.save_as_mainfile(filepath=blend, copy=True, compress=True)
    exports = None
    material_report = exporter.material_report([o for o in prod.meshes if not o.hide_render])
    if job["outputs"]["export"]:
        rest_pose(prod)  # the product exports in its real orientation, assembled (after the .blend is saved)
        exports = exporter.export_product([o for o in prod.meshes if not o.hide_render],
                                          os.path.join(out_dir, "export"), job["outputs"]["export"])

    parts = [{"name": pt.name, "role": pt.role, "verified": pt.verified, "internal": pt.internal,
              "order": pt.order} for pt in prod.parts.values()]
    return {
        "ok": True,
        "sceneVersion": SCENE_VERSION,
        "jobId": job["jobId"],
        "template": tpl,
        "blender": {"version": ".".join(map(str, version)), "versionString": bpy.app.version_string,
                    "renderer": scene.render.engine},
        "device": device,
        "frames": {"dir": "frames", "pattern": "f_%04d.png", "count": len(frame_ms), "width": w, "height": h,
                   "fps": fps, "alpha": job["outputs"]["alpha"]},
        "product": {"kind": prod.kind, "name": prod.name, "heightM": round(prod.height, 5),
                    "radiusM": round(prod.radius, 5), "parts": parts, "actions": sorted(prod.actions),
                    "generatorVersion": prod.generator_version, "geometryHash": geometry_hash,
                    "materialHash": material_hash, "focus": focus_part},
        "set": {"name": sset.name, "fstop": fstop, "lighting": rig_name},
        "actions": [{"kind": a.kind, "startSec": a.start, "endSec": a.end} for a in actions],
        "productBoxes": boxes,
        "anchorTracks": tracks,
        "camera": {"preset": preset, "lensMm": lens_mm, "distanceM": round(dist, 4), "track": cameras[:: max(1, n // 30)]},
        "controlViews": views,
        "exports": exports,
        "materialReport": material_report,
        "blend": "scene.blend" if blend else None,
        "missingTextures": missing,
        "warnings": warnings,
        "timings": {"productMs": product_ms, "setupMs": setup_ms, "renderMs": render_ms, "frameMs": frame_ms,
                    "totalMs": ms_since(t_all)},
    }


def rest_pose(prod: products.SceneProduct) -> None:
    """Drop the clip's animation from the product and put it back in its rest transform."""
    for obj in [prod.pivot, *(p.handle for p in prod.parts.values())]:
        obj.animation_data_clear()
        if "rest" in obj:
            obj.location = tuple(obj["rest"])
        obj.rotation_euler = (0.0, 0.0, 0.0)
    prod.pivot.location = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()


def control_views(job: dict, prod, tracker: PartTracker, out_dir: str, sset) -> list[str]:
    """Six low-resolution views around the product (QA: proportions, missing faces, textures from every side)."""
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    saved = (scene.render.resolution_x, scene.render.resolution_y, scene.camera, scene.render.filepath)
    cycles_samples = scene.cycles.samples if scene.render.engine == "CYCLES" else None
    scene.render.resolution_x = scene.render.resolution_y = 384
    if cycles_samples is not None:
        scene.cycles.samples = 12
    cam = new_camera("ControlCamera")
    scene.camera = cam
    cam.data.dof.use_dof = False
    pts = [tuple(map(float, p)) for p in tracker.world_points()[::3]]
    lo, hi = np.array(pts).min(axis=0), np.array(pts).max(axis=0)
    target = tuple(map(float, (lo + hi) / 2))
    files = []
    for name, az, el in CONTROL_VIEWS:
        fit = framing.fit_camera(pts, target, az, el, 50.0, 384, 384, 0.78, max_width=0.85)
        place_camera(cam, fit.camera, target, 50.0, (fit.shift_x, fit.shift_y))
        path = os.path.join(out_dir, f"{name}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(f"views/{name}.png")
    scene.render.resolution_x, scene.render.resolution_y, scene.camera, scene.render.filepath = saved
    if cycles_samples is not None:
        scene.cycles.samples = cycles_samples
    return files


def cli(argv: list[str]) -> int:
    args = argv[argv.index("--") + 1:] if "--" in argv else argv[1:]
    if len(args) != 1:
        print("usage: run.py <scene-job.json>", file=sys.stderr)
        return 2
    try:
        with open(args[0], encoding="utf-8") as fh:
            raw = json.load(fh)
        job = spec_mod.validate(raw)
    except (OSError, ValueError) as e:
        print(json.dumps({"ok": False, "error": "invalid_job", "message": str(e)}), file=sys.stderr)
        return 3
    try:
        result = run(job)
    except SceneJobError as e:
        print(json.dumps({"ok": False, "error": "invalid_job", "message": str(e)}), file=sys.stderr)
        return 3
    tmp = os.path.join(job["output"]["dir"], "result.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    os.replace(tmp, os.path.join(job["output"]["dir"], "result.json"))
    print(f"RESULT {os.path.join(job['output']['dir'], 'result.json')}", flush=True)
    return 0
