"""Blender product studio — builds the scene ONCE for a StudioJob and renders every shot (bpy).

    <output.dir>/<shotId>/plate.png | off.png on.png | f_0001.png …   + <shotId>/result.json (StudioShotResult)
    <output.dir>/result.json                                           (StudioResult summary)

A shot's result.json is written (atomically) once all its files are, so the bridge can keep the finished shots of a
run that is killed or fails later.

Stdout carries progress for the TypeScript bridge: "PROGRESS shot=sh01 frame=3/40" and "PHASE <name> ms=<n>".
All keyframes come from shotlib (pure, unit-tested) and framing (pure camera math); this module only applies
them to Blender objects, renders, and measures where the product lands in every image.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sys
import time
from dataclasses import dataclass, replace

import bpy
import numpy as np
from mathutils import Matrix

import environments
import framing
import jobspec
import lighting
import product_import
import shotlib

VIEW_TRANSFORM = "Khronos PBR Neutral"
PLATE_NAME = "plate.png"
RELIGHT_NAMES = ("off.png", "on.png")
#: relight plates: the studio lights run at this level so the product's own light reads clearly
RELIGHT_DIM = 0.35
#: widest the product is framed (share of the frame width) when the composition does not overflow the frame
MAX_WIDTH = 0.92
#: close-ups stop down to at least this f-number (DOF a few cm at the 65 mm macro distance)
CLOSEUP_FSTOP = 8.0
#: a close-up frame covers at least this share of the product height
MIN_CLOSEUP_VIEW = 0.22


def log(msg: str) -> None:
    print(msg, flush=True)


def write_json(path: str, data: dict) -> None:
    """Written to a temporary file and renamed: a reader never sees a half-written result."""
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


def ms_since(t0: float) -> int:
    return int(round((time.monotonic() - t0) * 1000))


def env_number(name: str, lo: float, hi: float, integer: bool = False):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    v = float(raw)
    if not (lo <= v <= hi) or (integer and v != int(v)):
        raise jobspec.JobError(f"{name}={raw} outside [{lo}, {hi}]")
    return int(v) if integer else v


# ------------------------------------------------------------------------------------------ render setup --


def configure_render(scene, cfg: dict, job: dict, samples: int, threads: int) -> None:
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    cy.device = "CPU"
    cy.samples = samples
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = cfg["adaptiveThreshold"]
    cy.use_denoising = True
    cy.denoiser = "OPENIMAGEDENOISE"
    cy.denoising_prefilter = "FAST" if job["profile"] == "FAST" else "ACCURATE"
    cy.denoising_quality = cfg["denoiseQuality"]
    cy.max_bounces = cfg["maxBounces"]
    cy.diffuse_bounces = cfg["diffuseBounces"]
    cy.glossy_bounces = cfg["glossyBounces"]
    cy.transmission_bounces = cfg["transmissionBounces"]
    cy.transparent_max_bounces = 8
    cy.volume_bounces = 0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.blur_glossy = 1.0
    cy.sample_clamp_indirect = 8.0
    cy.use_light_tree = False  # a handful of lights: direct sampling is faster and just as clean
    cy.texture_limit_render = cfg["textureLimit"]
    cy.seed = job["seed"]
    cy.use_animated_seed = False  # fixed noise pattern → temporally stable denoising, deterministic output
    scene.render.use_persistent_data = True
    if threads > 0:
        scene.render.threads_mode = "FIXED"
        scene.render.threads = threads
    scene.render.use_compositing = False
    scene.render.use_sequencer = False
    scene.render.film_transparent = False
    scene.render.resolution_percentage = 100
    scene.render.motion_blur_shutter = 0.5
    scene.view_settings.view_transform = VIEW_TRANSFORM
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.display_settings.display_device = "sRGB"
    img = scene.render.image_settings
    img.file_format = "PNG"
    img.color_mode = "RGB"
    img.color_depth = "8"
    img.compression = 15


# ------------------------------------------------------------------------------------------ shot planning --


@dataclass
class FramePose:
    state: shotlib.ShotState
    cam: framing.Vec
    basis: framing.Basis
    focus_distance: float
    prod_rot: float
    lift: float


@dataclass
class ShotPlan:
    spec: dict
    preset: str
    fallback: str | None
    #: the technique rendered (a relight of a product without a light of its own becomes a plate)
    technique: str
    notes: dict
    comp: shotlib.Composition
    width: int  # rendered image size
    height: int
    overscan: float
    fit: framing.Fit
    poses: list[FramePose]
    files: list[str]
    accent_used: bool
    sweep_used: bool
    #: aperture of this shot (close-ups stop down); None = the job's
    fstop: float | None = None


def _subsample(points: np.ndarray, limit: int) -> list[framing.Vec]:
    return framing.subsample([tuple(p) for p in points.tolist()], limit) if len(points) else []


def has_own_light(model: product_import.ProductModel, job: dict) -> bool:
    """The product can switch on: an interior ProductLight (Studio) or glowing surfaces."""
    return (job["product"]["emitsLight"] and model.bulb is not None) or bool(model.emissive)


def _slice_widths(model: product_import.ProductModel, H: float, slices: int = 20) -> list[float]:
    """Horizontal extent of the product in equal height slices, from points sampled on its SURFACE (vertices
    alone leave a cube's faces and a rod's length empty)."""
    pts = model.surface if model.surface is not None and len(model.surface) else model.points
    out = []
    for k in range(slices):
        sel = pts[(pts[:, 2] >= k / slices * H - 1e-9) & (pts[:, 2] <= (k + 1) / slices * H + 1e-9)]
        out.append(float(max(np.ptp(sel[:, 0]), np.ptp(sel[:, 1]))) if len(sel) >= 4 else 0.0)
    return out


def plan_shot(model: product_import.ProductModel, job: dict, spec: dict, cfg: dict, scale_override) -> ShotPlan:
    preset, fallback = shotlib.resolve_preset(spec["preset"], len(model.parts))
    params = spec["params"]
    emits = job["product"]["emitsLight"]
    kw = dict(part_count=len(model.parts), emits_light=emits, lighting=spec["lighting"])
    comp = shotlib.composition(preset, params)
    technique = spec["technique"]
    if technique == "relight" and not has_own_light(model, job):
        technique = "plate"  # off and on would be the same pixels: one plate at full light instead
    base_scale = cfg["scale"] if technique == "sequence" else cfg["plateScale"]
    if scale_override:
        base_scale *= scale_override
    overscan = 1.0 if technique == "sequence" else spec["overscan"]
    cw = max(16, int(round(job["output"]["width"] * base_scale)))
    ch = max(16, int(round(job["output"]["height"] * base_scale)))

    rest, notes = shotlib.plate_state(preset, params, spec["productAnimation"], **kw)
    angle = -float(params["angleDeg"])
    H = model.height
    z0, z1 = shotlib.focus_band(comp.focus)
    if comp.fill > 1.0:
        z0, z1, why = shotlib.refine_band(z0, z1, _slice_widths(model, H))
        # a close-up still shows a readable piece of the product (≥ MIN_CLOSEUP_VIEW of its height): a small
        # part (a 4.5 cm marble cube) is framed whole with some context, not as one featureless face
        fill = min(comp.fill, max(0.7, (z1 - z0) / MIN_CLOSEUP_VIEW))
        if fill < comp.fill:
            why = f"{why + '; ' if why else ''}small part: fill {comp.fill:.2f} → {fill:.2f}"
            comp = replace(comp, fill=fill)
        if why:
            notes["macroFocus"] = why
    band = model.points[(model.points[:, 2] >= z0 * H - 1e-9) & (model.points[:, 2] <= z1 * H + 1e-9)]
    if len(band) < 8:
        band = model.points
    pts = [framing.add(framing.rotate_z(p, angle + rest.prod_rot), (0.0, 0.0, rest.prod_lift * H))
           for p in _subsample(band, 700)]
    lo, hi = framing.bounds(pts)
    target = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)

    if technique == "plate":
        states = [rest]
        files = [PLATE_NAME]
    elif technique == "relight":
        states = [shotlib.ShotState(**{**rest.__dict__, "product_light": 0.0}),
                  shotlib.ShotState(**{**rest.__dict__, "product_light": 1.0})]
        files = list(RELIGHT_NAMES)
    else:
        states = []
        for t in shotlib.sequence_times(spec["durationMs"], spec["renderFps"]):
            s, n = shotlib.evaluate(preset, t, params, spec["productAnimation"], **kw)
            states.append(s)
            notes.update(n)
        files = [f"f_{k + 1:04d}.png" for k in range(len(states))]

    # sideways travel of the frame over the product (frame widths): a plate's FFmpeg slide (spec travelX), a
    # sequence's camera truck (frame heights). The framing keeps that much margin so the product stays whole.
    if technique == "sequence":
        travel = max(abs(s.cam_truck) for s in states) * ch / cw
    else:
        travel = spec.get("travelX", 0.0)
    max_w = MAX_WIDTH - 2.0 * travel if comp.fill <= 1.0 else None
    lens = job["camera"]["lensMm"]
    if comp.elevation_deg is not None:
        fit = framing.fit_camera(pts, target, 0.0, comp.elevation_deg, lens, cw, ch, comp.fill,
                                 (0.5, comp.center_y), max_w)
    else:
        cam_z = lo[2] + comp.height * (hi[2] - lo[2])
        fit = framing.fit_at_height(pts, target, 0.0, cam_z, lens, cw, ch, comp.fill, (0.5, comp.center_y), max_w)

    hf = framing.frame_height_at(fit.focus_distance, lens)
    poses = []
    for s in states:
        off = framing.add(framing.scale(fit.basis.right, s.cam_truck * hf), framing.scale(fit.basis.up,
                                                                                          s.cam_pedestal * hf))
        tgt = framing.add(fit.target, off)
        cam = framing.add(tgt, framing.scale(framing.direction(s.cam_az, fit.elevation_deg + s.cam_el),
                                             fit.distance * s.cam_dolly))
        basis = framing.look_at(cam, tgt)
        poses.append(FramePose(s, cam, basis, framing.dot(framing.sub(tgt, cam), basis.forward),
                               angle + s.prod_rot, s.prod_lift * H))
    fstop = None
    if comp.fill > 1.0:
        # a close-up focuses on the near surface of the framed part (not its centre, which a round base hides
        # behind its own front) and stops down: the detail is sharp, the background still soft
        depths = [framing.dot(framing.sub(p, fit.camera), fit.basis.forward) for p in pts]
        front = max(0.0, fit.focus_distance - min(depths))
        for p in poses:
            p.focus_distance = max(0.01, p.focus_distance - 0.8 * front)
        fstop = max(float(job["camera"]["dof"]["fStop"]), CLOSEUP_FSTOP)
    w, h = (int(round(cw * overscan)), int(round(ch * overscan)))
    return ShotPlan(spec, preset, fallback, technique, notes, comp, w, h, overscan, fit, poses, files,
                    any(p.state.accent > 0 for p in poses), any(p.state.sweep is not None for p in poses), fstop)


#: the set is built for the whole product framed at this fill (two QA "-fill" reframes of a 0.56 CTA) …
SET_MIN_FILL = 0.4
#: … seen from this much farther away (sequence dolly of the wider presets)
SET_MAX_DOLLY = 1.3
MAX_OVERSCAN = 1.6


def set_extent(model: product_import.ProductModel, job: dict, plans: list[ShotPlan]) -> tuple[float, float, bool]:
    """(camera reach, wall height, extended) the set is sized for. The bound depends on the product, the lens and
    the frame aspect only — NOT on the job's other shots — so a shot renders the same pixels whichever job it is
    in (per-shot render caching). A camera outside the bound (fill < 0.4) extends the set and is reported."""
    lens = job["camera"]["lensMm"]
    pts = _subsample(model.points, 600)
    fit = framing.fit_camera(pts, (0.0, 0.0, model.height / 2), 0.0, 0.0, lens, job["output"]["width"],
                             job["output"]["height"], SET_MIN_FILL, (0.5, 0.5), MAX_WIDTH)
    bound = fit.distance * SET_MAX_DOLLY + 0.5 * model.size
    need = max(framing.length(framing.sub(pose.cam, (0.0, 0.0, model.height / 2)))
               for pl in plans for pose in pl.poses)
    reach = max(bound, need)
    # a camera as high as its reach, a frame MAX_OVERSCAN × taller than composed, 30 % margin
    tallest = reach + 1.3 * (reach + 2.0 * model.size) * (framing.SENSOR_HEIGHT_MM / 2) * MAX_OVERSCAN / lens
    return reach, tallest, need > bound


# ------------------------------------------------------------------------------------------ applying ------


class Studio:
    def __init__(self, job: dict, cfg: dict, model: product_import.ProductModel, env: environments.EnvSet):
        self.job, self.cfg, self.model, self.env = job, cfg, model, env
        self.scene = bpy.context.scene
        cam_data = bpy.data.cameras.new("StudioCamera")
        cam_data.sensor_fit = "VERTICAL"
        cam_data.lens = job["camera"]["lensMm"]
        cam_data.clip_start = max(1e-3, 0.01 * model.size)
        cam_data.clip_end = 400.0 * model.size
        cam_data.dof.use_dof = job["camera"]["dof"]["enabled"]
        cam_data.dof.aperture_fstop = job["camera"]["dof"]["fStop"]
        self.base_fstop = float(job["camera"]["dof"]["fStop"])
        self.cam = bpy.data.objects.new("StudioCamera", cam_data)
        self.scene.collection.objects.link(self.cam)
        self.scene.camera = self.cam
        self.lights = lighting.Lighting(model.size, env.interior, env.light_mult)
        self.plight = None
        self.plight_energy = 0.0
        if job["product"]["emitsLight"] and model.bulb is not None:
            self.plight, self.plight_energy = lighting.product_light(model.pivot, model.bulb, model.height)
        self.part_rest = [tuple(p.offset["rest"]) if p.offset else None for p in model.parts]
        self.smallest = min(range(len(model.parts)), key=lambda k: model.parts[k].volume) if model.parts else 0

    def clear_animation(self) -> None:
        for idb in [self.cam, self.cam.data, self.model.pivot, *(p.offset for p in self.model.parts if p.offset)]:
            idb.animation_data_clear()
        for rig in self.lights.rigs.values():
            for light in rig.lights:
                light.obj.animation_data_clear()
                light.obj.data.animation_data_clear()
        if self.plight is not None:
            self.plight.data.animation_data_clear()
        for t in self.model.emissive:
            t.socket.id_data.animation_data_clear()

    def apply(self, plan: ShotPlan, pose: FramePose, frame: int | None) -> None:
        s = pose.state
        b, c = pose.basis, pose.cam
        self.cam.matrix_world = Matrix(((b.right[0], b.up[0], -b.forward[0], c[0]),
                                        (b.right[1], b.up[1], -b.forward[1], c[1]),
                                        (b.right[2], b.up[2], -b.forward[2], c[2]), (0, 0, 0, 1)))
        self.cam.data.dof.focus_distance = max(0.01, pose.focus_distance)
        self.cam.data.dof.aperture_fstop = plan.fstop or self.base_fstop
        piv = self.model.pivot
        piv.rotation_euler = (0.0, 0.0, math.radians(pose.prod_rot))
        piv.location = (0.0, 0.0, pose.lift)
        offsets = self.part_offsets(s)
        for k, part in enumerate(self.model.parts):
            if part.offset is None:
                continue
            rest = self.part_rest[k]
            sc = self.model.scale_applied
            o = offsets[k]
            part.offset.location = (rest[0] + o[0] / sc, rest[1] + o[1] / sc, rest[2] + o[2] / sc)
            part.offset.rotation_euler = (0.0, 0.0, math.radians(s.spin_part) if k == self.smallest else 0.0)
        self.lights.set_levels(s.key, s.fill, s.rim, s.accent, s.sweep, frame)
        if self.plight is not None:
            self.plight.data.energy = self.plight_energy * s.product_light
        product_import.set_product_light_level(self.model, s.product_light)
        if frame is not None:
            for idb, paths in ((self.cam, ("location", "rotation_euler")), (piv, ("location", "rotation_euler"))):
                for p in paths:
                    idb.keyframe_insert(p, frame=frame)
            self.cam.data.dof.keyframe_insert("focus_distance", frame=frame)
            for part in self.model.parts:
                if part.offset is not None:
                    part.offset.keyframe_insert("location", frame=frame)
                    part.offset.keyframe_insert("rotation_euler", frame=frame)
            if self.plight is not None:
                self.plight.data.keyframe_insert("energy", frame=frame)
            for t in self.model.emissive:
                t.socket.keyframe_insert("default_value", frame=frame)

    def part_offsets(self, s: shotlib.ShotState) -> list[tuple[float, float, float]]:
        parts = self.model.parts
        if len(parts) < 2:
            return [(0.0, 0.0, 0.0)] * len(parts)
        return shotlib.part_offsets([p.centre for p in parts], (0.0, 0.0, self.model.height / 2), self.model.size,
                                    s.explode, s.stagger, s.cutaway, [p.volume for p in parts])

    def product_points(self, pose: FramePose) -> np.ndarray:
        """World positions of every product vertex for a pose (same transforms as apply())."""
        pts = self.model.points
        offsets = self.part_offsets(pose.state)
        if any(o != (0.0, 0.0, 0.0) for o in offsets) or pose.state.spin_part:
            pts = pts.copy()
            for k, part in enumerate(self.model.parts):
                seg = pts[part.start : part.end]
                if k == self.smallest and pose.state.spin_part:
                    c = np.array(part.centre)
                    a = math.radians(pose.state.spin_part)
                    rz = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
                    seg[:] = (seg - c) @ rz.T + c
                seg += np.array(offsets[k])
        a = math.radians(pose.prod_rot)
        rz = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
        return pts @ rz.T + np.array([0.0, 0.0, pose.lift])

    def product_box(self, plan: ShotPlan, pose: FramePose) -> dict:
        dg = bpy.context.evaluated_depsgraph_get()
        proj = np.array(self.cam.calc_matrix_camera(dg, x=plan.width, y=plan.height))
        view = np.array(self.cam.matrix_world.inverted())
        p = self.product_points(pose)
        hom = np.c_[p, np.ones(len(p))] @ (proj @ view).T
        w = hom[:, 3]
        ok = w > 1e-9
        if not ok.any():
            return {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}
        u = (hom[ok, 0] / w[ok] + 1) / 2
        v = 1 - (hom[ok, 1] / w[ok] + 1) / 2
        r = lambda x: round(float(x), 5)  # noqa: E731
        return {"x": r(u.min()), "y": r(v.min()), "w": r(u.max() - u.min()), "h": r(v.max() - v.min())}


def render_shot(studio: Studio, plan: ShotPlan, out_dir: str, samples: int) -> dict:
    scene = studio.scene
    spec = plan.spec
    sid = spec["id"]
    t_shot = time.monotonic()
    shot_dir = os.path.join(out_dir, sid)
    shutil.rmtree(shot_dir, ignore_errors=True)
    os.makedirs(shot_dir)
    studio.clear_animation()
    technique = plan.technique
    dim = RELIGHT_DIM if technique == "relight" else 1.0
    studio.lights.activate(spec["lighting"], plan.fit.target, dim)
    studio.lights.static_roles_off(plan.accent_used, plan.sweep_used)

    cam = studio.cam.data
    cam.sensor_height = framing.SENSOR_HEIGHT_MM * plan.overscan
    cam.shift_x = plan.fit.shift_x / plan.overscan
    cam.shift_y = plan.fit.shift_y / plan.overscan
    scene.render.resolution_x = plan.width
    scene.render.resolution_y = plan.height
    sequence = technique == "sequence"
    scene.render.use_motion_blur = sequence and studio.job["camera"]["motionBlur"]
    scene.render.image_settings.color_depth = "16" if technique == "relight" else "8"
    scene.render.fps = spec["renderFps"] if sequence else 30
    scene.frame_start, scene.frame_end = 1, max(1, len(plan.poses))
    keyed = scene.render.use_motion_blur
    if keyed:
        for k, pose in enumerate(plan.poses):
            studio.apply(plan, pose, frame=k + 1)

    boxes = []
    frame_ms = []
    n = len(plan.poses)
    for k, pose in enumerate(plan.poses):
        t = time.monotonic()
        if keyed:
            scene.frame_set(k + 1)
        else:
            scene.frame_set(1)
            studio.apply(plan, pose, frame=None)
        boxes.append(studio.product_box(plan, pose))
        scene.render.filepath = os.path.join(shot_dir, plan.files[k])
        bpy.ops.render.render(write_still=True)
        frame_ms.append(ms_since(t))
        log(f"PROGRESS shot={sid} frame={k + 1}/{n} ms={frame_ms[-1]}")
    studio.clear_animation()

    fit = plan.fit
    result = {
        "id": sid,
        "technique": technique,
        "files": plan.files,
        "width": plan.width,
        "height": plan.height,
        "renderFps": spec["renderFps"],
        "productBoxes": boxes,
        "samples": samples,
        "renderMs": ms_since(t_shot),
        "engine": "CYCLES",
        "blenderVersion": bpy.app.version_string,
        # extras (the bridge validates them with an extended schema)
        "preset": spec["preset"],
        "renderedPreset": plan.preset,
        "focus": plan.comp.focus,
        "overscan": plan.overscan,
        "composedWidth": int(round(plan.width / plan.overscan)),
        "composedHeight": int(round(plan.height / plan.overscan)),
        "bitDepth": 16 if technique == "relight" else 8,
        "viewTransform": VIEW_TRANSFORM,
        "frameMs": frame_ms,
        "camera": {
            "lensMm": studio.job["camera"]["lensMm"],
            "distanceM": round(fit.distance, 4),
            "elevationDeg": round(fit.elevation_deg, 3),
            "shiftX": round(fit.shift_x, 5),
            "shiftY": round(fit.shift_y, 5),
            "focusDistanceM": round(fit.focus_distance, 4),
        },
    }
    if plan.fallback:
        result["fallbackPreset"] = plan.fallback
        result["fallbackReason"] = f"{spec['preset']} needs a multi-part model; the model has one mesh"
    if "animationFallback" in plan.notes:
        result["animationFallback"] = plan.notes["animationFallback"]
    if "macroFocus" in plan.notes:
        result["macroFocus"] = plan.notes["macroFocus"]
    if technique != spec["technique"]:
        result["fallbackTechnique"] = technique
        result["fallbackTechniqueReason"] = "the product has no light of its own to switch on: one plate at full light"
    write_json(os.path.join(shot_dir, "result.json"), result)
    return result


# ------------------------------------------------------------------------------------------ main ----------


def main(job_path: str) -> int:
    t0 = time.monotonic()
    job = jobspec.load_job(job_path)
    cfg = jobspec.load_profiles()[job["profile"]]
    samples = env_number("STUDIO_SAMPLES", 1, 4096, integer=True) or cfg["samples"]
    scale_override = env_number("STUDIO_SCALE", 0.05, 1.0)
    threads = env_number("BLENDER_THREADS", 0, 256, integer=True) or 0
    out_dir = os.path.abspath(job["output"]["dir"])
    os.makedirs(out_dir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    scene = bpy.context.scene
    configure_render(scene, cfg, job, samples, threads)
    t = time.monotonic()
    p = job["product"]
    model = product_import.import_product(p["modelPath"], p["format"], p.get("realHeightM"), p["emitsLight"],
                                          p["emissiveHints"])
    log(f"PHASE import ms={ms_since(t)} height={model.height:.4f} parts={len(model.parts)} "
        f"emissive={model.emissive_mode}")
    t = time.monotonic()
    plans = [plan_shot(model, job, s, cfg, scale_override) for s in job["shots"]]
    reach, tallest, extended = set_extent(model, job, plans)
    log(f"PHASE plan ms={ms_since(t)} reach={reach:.3f} wall={tallest:.3f} extended={int(extended)}")
    t = time.monotonic()
    env = environments.build_environment(job["environment"], model.size, model.radius, reach, tallest)
    studio = Studio(job, cfg, model, env)
    scene_ms = ms_since(t0)
    log(f"PHASE scene ms={scene_ms} environment={env.name}")

    results = []
    for plan in plans:
        results.append(render_shot(studio, plan, out_dir, samples))
        log(f"PHASE shot={plan.spec['id']} ms={results[-1]['renderMs']}")
    summary = {
        "version": jobspec.STUDIO_JOB_VERSION,
        "jobKey": job["jobKey"],
        "shots": results,
        "sceneMs": scene_ms,
        "totalMs": ms_since(t0),
        "blenderVersion": bpy.app.version_string,
        "product": {
            "heightM": round(model.height, 5),
            "radiusM": round(model.radius, 5),
            "scaleApplied": model.scale_applied,
            "parts": len(model.parts),
            "emissive": model.emissive_mode,
            "bulb": [round(c, 4) for c in model.bulb] if model.bulb else None,
        },
        "set": {"environment": env.name, "reachM": round(reach, 4), "wallM": round(tallest, 4), "extended": extended},
    }
    write_json(os.path.join(out_dir, "result.json"), summary)
    log(f"PHASE total ms={summary['totalMs']}")
    return 0


def cli(argv: list[str]) -> int:
    args = argv[argv.index("--") + 1 :] if "--" in argv else argv[1:]
    if len(args) != 1:
        print("usage: run.py <job.json>  (or blender -b --factory-startup --python run.py -- <job.json>)",
              file=sys.stderr)
        return 2
    try:
        return main(args[0])
    except jobspec.JobError as e:
        print(f"STUDIO_ERROR invalid job: {e}", file=sys.stderr, flush=True)
        return 3
