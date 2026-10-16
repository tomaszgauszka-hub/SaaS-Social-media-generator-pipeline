"""Unit tests of the UE scene tools — plain CPython, no Unreal Editor (run: cd tools/unreal && python3 -m unittest).

Covers job validation, the six template set descriptions, camera path / projection math, scale normalisation,
material mapping, MRQ / GI decisions, API-variant resolution and diagnostics (with a fake `unreal` module), the
project setup CLI, the remote-execution protocol pieces (with a loopback mock editor) and ue_scene's behaviour
outside the editor. None of this renders anything: real renders need a UE 5.8 editor.
"""

from __future__ import annotations

import copy
import io
import json
import math
import os
import socket
import struct
import sys
import tempfile
import threading
import types
import unittest
import zlib
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import remote_exec  # noqa: E402
import ue_compat  # noqa: E402
import ue_diagnose  # noqa: E402
import ue_job  # noqa: E402
import ue_materials  # noqa: E402
import ue_math  # noqa: E402
import ue_mrq  # noqa: E402
import ue_project  # noqa: E402
import ue_scene  # noqa: E402
import ue_sets  # noqa: E402
import ue_util  # noqa: E402

TMP = tempfile.gettempdir()
OUT = os.path.join(TMP, "r3d-ue-test-out")
PRODUCT = os.path.join(TMP, "r3d-ue-test-product.fbx")
DARK = {"preset": "dark_gradient", "color": None, "accent": None}


def make_job(**over) -> dict:
    job = {
        "version": 1,
        "kind": "ue_scene",
        "jobId": "job_1",
        "template": "UE_LUXURY_STUDIO",
        "quality": "preview",
        "durationSec": 2.0,
        "fps": 30,
        "resolution": [1080, 1920],
        "seed": 1,
        "turns": 1.0,
        "camera": {"preset": "orbit_closeup", "movement": "slow"},
        "framing": {"centerY": 0.5},
        "lighting": {"preset": "premium_studio"},
        "background": {"preset": "dark_gradient"},
        "actions": [],
        "product": {"assetId": "prod.1", "path": PRODUCT, "format": "fbx", "sha256": "a" * 64,
                    "dimensionsM": [0.2, 0.1, 0.3], "fidelity": "TECHNICAL_RECONSTRUCTION"},
        "render": {"executor": "pie", "gi": "auto"},
        "output": {"dir": OUT},
    }
    job.update(over)
    return job


# ----------------------------------------------------------------------------------------------- jobs ----


class JobValidationTest(unittest.TestCase):
    def test_valid_job_is_normalised(self):
        j = ue_job.validate_job(make_job())
        self.assertEqual(j["template"], "UE_LUXURY_STUDIO")
        self.assertEqual(j["framing"], {"centerY": 0.5, "fill": None})
        self.assertEqual(j["render"]["executor"], "pie")
        self.assertFalse(j["interactive"])
        self.assertIsNone(j["environment"])
        self.assertEqual(j["product"]["frontYawDeg"], 0.0)
        self.assertIsNone(j["product"]["materialReport"])

    def test_unknown_keys_are_rejected_at_every_level(self):
        for mutate in (lambda j: j.update(script="import os"),
                       lambda j: j["camera"].update(fov=10),
                       lambda j: j["product"].update(command="x"),
                       lambda j: j["render"].update(cvars={"r.X": 1}),
                       lambda j: j["output"].update(log="/etc/passwd")):
            j = make_job()
            mutate(j)
            with self.assertRaises(ue_job.UeJobError):
                ue_job.validate_job(j)

    def test_closed_sets_and_bounds(self):
        bad = [
            {"template": "PRODUCT_HERO"},  # a Blender template
            {"template": "ue_luxury_studio"},
            {"quality": "ultra"},
            {"fps": 29},
            {"fps": True},
            {"durationSec": 0.1},
            {"durationSec": float("nan")},
            {"resolution": [1081, 1920]},
            {"resolution": [64, 64]},
            {"turns": 9},
            {"seed": -1},
            {"camera": {"preset": "spiral", "movement": "slow"}},
            {"framing": {"centerY": 0.9}},
            {"framing": {"centerY": 0.5, "fill": 1.5}},
            {"lighting": {"preset": "neon"}},
            {"background": {"preset": "brand_color", "color": "red"}},
            {"background": {"preset": "environment"}},  # needs environment.preset
            {"environment": {"preset": "moon"}},
            {"focus": "../x"},
            {"actions": [{"kind": "EXPLODE", "startSec": 0, "endSec": 1}]},
            {"actions": [{"kind": "LED_ON", "startSec": 1.5, "endSec": 1.0}]},
            {"render": {"executor": "remote"}},
            {"render": {"temporalSamples": 999}},
            {"interactive": "yes"},
            {"jobId": "../escape"},
            {"version": 2},
            {"kind": "blender_scene"},
        ]
        for over in bad:
            with self.subTest(over=over), self.assertRaises(ue_job.UeJobError):
                ue_job.validate_job(make_job(**over))

    def test_paths_must_be_absolute_and_baked_maps_inside_the_output(self):
        for prod in ({"path": "relative/model.fbx"}, {"path": PRODUCT + "\n"}, {"format": "glb"},
                     {"sha256": "A" * 64}, {"dimensionsM": [0.2, 0.1]}, {"dimensionsM": [0, 0.1, 0.1]},
                     {"assetId": "a/b"}, {"frontYawDeg": 270}):
            j = make_job()
            j["product"].update(prod)
            with self.subTest(prod=prod), self.assertRaises(ue_job.UeJobError):
                ue_job.validate_job(j)
        j = make_job()
        j["product"]["bakedTextures"] = {"Body": {"baseColor": os.path.join(TMP, "elsewhere.png")}}
        with self.assertRaises(ue_job.UeJobError):
            ue_job.validate_job(j)
        j["product"]["bakedTextures"] = {"Body": {"baseColor": os.path.join(OUT, "inputs", "Body.baseColor.png")}}
        self.assertIn("baseColor", ue_job.validate_job(j)["product"]["bakedTextures"]["Body"])
        j["product"]["bakedTextures"] = {"Body": {"emission": os.path.join(OUT, "x.png")}}
        with self.assertRaises(ue_job.UeJobError):
            ue_job.validate_job(j)
        with self.assertRaises(ue_job.UeJobError):
            ue_job.validate_job(make_job(output={"dir": os.path.abspath(os.sep)}))

    def test_material_report_rows_are_validated(self):
        j = make_job()
        j["product"]["materialReport"] = {"materials": [{"material": "Body", "status": "PBR_DIRECT", "notes": [],
                                                         "textures": []}], "counts": {"PBR_DIRECT": 1}, "ueReady": True}
        self.assertEqual(ue_job.validate_job(j)["product"]["materialReport"]["materials"][0]["status"], "PBR_DIRECT")
        j["product"]["materialReport"]["materials"][0]["status"] = "MAGIC"
        with self.assertRaises(ue_job.UeJobError):
            ue_job.validate_job(j)

    def test_job_path_from_argv_or_env(self):
        self.assertEqual(ue_job.job_path_from(["ue_scene.py", os.path.join(TMP, "j.json"), "--no-exit"], {}),
                         os.path.join(TMP, "j.json"))
        self.assertEqual(ue_job.job_path_from(["ue_scene.py"], {"R3D_UE_JOB": os.path.join(TMP, "e.json")}),
                         os.path.join(TMP, "e.json"))
        with self.assertRaises(ue_job.UeJobError):
            ue_job.job_path_from(["ue_scene.py"], {})
        with self.assertRaises(ue_job.UeJobError):
            ue_job.job_path_from(["ue_scene.py", "rel.json"], {})

    def test_frame_count_and_render_size_match_the_blender_rules(self):
        self.assertEqual(ue_job.frame_count(2.0, 30), 60)
        self.assertEqual(ue_job.frame_count(0.5, 24), 12)
        self.assertEqual(ue_job.frame_count(0.01, 24), 2)
        self.assertEqual(ue_job.render_size("preview", [1080, 1920]), (540, 960))
        self.assertEqual(ue_job.render_size("production", [1080, 1920]), (1080, 1920))
        self.assertEqual(ue_job.render_size("preview", [200, 130]), (128, 128))


# ----------------------------------------------------------------------------------------------- sets ----


def footprint_covered(shape: dict, dims) -> bool:
    lo, hi = ue_sets.shape_aabb(shape)
    return abs(hi[2]) < 0.6 and lo[0] <= -dims[0] / 2 and hi[0] >= dims[0] / 2 and lo[1] <= -dims[1] / 2 \
        and hi[1] >= dims[1] / 2 if shape["mesh"] != "Cylinder" else (
        abs(hi[2]) < 0.6 and shape["scale"][0] * 50 >= math.hypot(dims[0], dims[1]) / 2)


class SetDescriptionTest(unittest.TestCase):
    SIZES = [(12.0, 12.0, 12.0), (30.0, 20.0, 25.0), (90.0, 60.0, 40.0), (45.0, 45.0, 180.0), (450.0, 180.0, 140.0)]

    def test_every_template_is_well_formed(self):
        for tpl in ue_job.TEMPLATES:
            for dims in self.SIZES:
                with self.subTest(tpl=tpl, dims=dims):
                    d = ue_sets.describe_set(tpl, "premium_studio", DARK, None, dims)
                    self.assertEqual(d["template"], tpl)
                    self.assertGreaterEqual(len(d["shapes"]), 3)
                    ids = [s["id"] for s in d["shapes"]] + [lt["id"] for lt in d["lights"]]
                    self.assertEqual(len(ids), len(set(ids)), "unique ids")
                    for s in d["shapes"]:
                        self.assertIn(s["mesh"], ue_sets.MESHES)
                        self.assertTrue(all(v > 0 for v in s["scale"]))
                        self.assertRegex(s["material"]["color"], r"^#[0-9a-f]{6}$")
                        self.assertTrue(0 <= s["material"]["roughness"] <= 1 and 0 <= s["material"]["metallic"] <= 1)
                    roles = {lt["role"] for lt in d["lights"]}
                    self.assertTrue({"key", "sky"} <= roles or {"sun", "sky"} <= roles)
                    for lt in d["lights"]:
                        self.assertIn(lt["kind"], ue_sets.LIGHT_KINDS)
                        self.assertIn(lt["role"], ue_sets.ROLES)
                        self.assertGreater(lt["intensity"], 0)
                        if lt["kind"] != "sky":
                            self.assertLess(ue_sets.aim_error_deg(lt), 0.5, lt["id"])
                    self.assertIn("exposureEv100", d["post"])
                    self.assertRegex(d["key"], r"^[0-9a-f]{16}$")

    def test_product_stands_on_a_surface_at_z0_and_nothing_intersects_it(self):
        for tpl in ue_job.TEMPLATES:
            for dims in self.SIZES:
                with self.subTest(tpl=tpl, dims=dims):
                    d = ue_sets.describe_set(tpl, "premium_studio", DARK, None, dims)
                    self.assertTrue(any(footprint_covered(s, dims) for s in d["shapes"]), "support at Z 0")
                    r = math.hypot(dims[0], dims[1]) / 2 * 1.02
                    for s in d["shapes"]:
                        lo, hi = ue_sets.shape_aabb(s)
                        if hi[2] > 0.01 and lo[2] < dims[2]:
                            nx, ny = min(max(0, lo[0]), hi[0]), min(max(0, lo[1]), hi[1])
                            self.assertGreaterEqual(math.hypot(nx, ny), r, f"{s['id']} intersects the product")

    def test_camera_paths_stay_inside_the_set(self):
        for tpl in ue_job.TEMPLATES:
            for dims in ((12.0, 12.0, 12.0), (90.0, 60.0, 40.0), (450.0, 180.0, 140.0)):
                d = ue_sets.describe_set(tpl, "premium_studio", DARK, None, dims)
                lo, hi = d["cameraVolume"]
                for preset in ue_job.CAMERA_PRESETS:
                    plan = ue_math.camera_plan(preset, 1.6, 1.0, {"centerY": 0.5}, dims, 540, 960, 8)
                    for p in plan["poses"]:
                        with self.subTest(tpl=tpl, dims=dims, preset=preset, f=p.frame):
                            self.assertTrue(all(lo[i] <= p.camera[i] <= hi[i] for i in range(3)))

    def test_keys_are_deterministic_and_distinct(self):
        keys = set()
        for tpl in ue_job.TEMPLATES:
            a = ue_sets.describe_set(tpl, "premium_studio", DARK, None, (30, 20, 25))
            b = ue_sets.describe_set(tpl, "premium_studio", DARK, None, (30.02, 20.01, 25.0))
            self.assertEqual(a["key"], b["key"], "sub-millimetre scale noise reuses the set")
            self.assertEqual(a, b)
            keys.add(a["key"])
            c = ue_sets.describe_set(tpl, "premium_studio", DARK, None, (60, 20, 25))
            self.assertNotEqual(a["key"], c["key"], "another product size rebuilds the set")
            d = ue_sets.describe_set(tpl, "dramatic_rim", DARK, None, (30, 20, 25))
            self.assertNotEqual(a["key"], d["key"])
        self.assertEqual(len(keys), 6)

    def test_lighting_presets_modulate_roles(self):
        base = ue_sets.describe_set("UE_LUXURY_STUDIO", "premium_studio", DARK, None, (30, 20, 25))
        rim = ue_sets.describe_set("UE_LUXURY_STUDIO", "dramatic_rim", DARK, None, (30, 20, 25))
        warm = ue_sets.describe_set("UE_LUXURY_STUDIO", "warm_home", DARK, None, (30, 20, 25))
        by = lambda d: {lt["id"]: lt for lt in d["lights"]}  # noqa: E731
        self.assertGreater(by(rim)["rim_left"]["intensity"], by(base)["rim_left"]["intensity"])
        self.assertLess(by(rim)["fill"]["intensity"], by(base)["fill"]["intensity"])
        self.assertEqual(by(warm)["key"]["kelvin"], 3400.0)
        self.assertLess(rim["post"]["exposureEv100"], base["post"]["exposureEv100"])
        for preset in ue_job.LIGHTING_PRESETS:
            self.assertIn(preset, ue_sets.LIGHTING)

    def test_background_presets(self):
        brand = ue_sets.describe_set("UE_TECHNOLOGY_SHOWCASE", "cool_tech",
                                     {"preset": "brand_color", "color": "#ff0066", "accent": "#00ffaa"}, None,
                                     (30, 20, 25))
        self.assertEqual(next(s for s in brand["shapes"] if s["id"] == "back_wall")["material"]["color"], "#ff0066")
        self.assertEqual(next(s for s in brand["shapes"] if s["id"] == "pedestal_ring")["material"]["color"], "#00ffaa")
        white = ue_sets.describe_set("UE_LUXURY_STUDIO", "high_key", {"preset": "seamless_white"}, None, (30, 20, 25))
        self.assertEqual(next(s for s in white["shapes"] if s["id"] == "backdrop")["material"]["color"], "#f3f3f3")
        transparent = ue_sets.describe_set("UE_LUXURY_STUDIO", "premium_studio", {"preset": "transparent"}, None,
                                           (30, 20, 25))
        self.assertTrue(any("transparent" in w for w in transparent["warnings"]))
        interior = ue_sets.describe_set("UE_MODERN_INTERIOR", "soft_daylight", {"preset": "seamless_white"}, None,
                                        (30, 20, 25))
        self.assertTrue(any("does not apply" in w for w in interior["warnings"]))

    def test_environment_variants_and_supports(self):
        kitchen = ue_sets.describe_set("UE_MODERN_INTERIOR", "warm_home", {"preset": "environment"},
                                       {"preset": "kitchen"}, (20, 20, 30))
        self.assertEqual(kitchen["environment"], "kitchen")
        floor = next(s for s in kitchen["shapes"] if s["id"] == "floor")
        self.assertAlmostEqual(floor["location"][2], -90.0)
        self.assertTrue(any(s["id"] == "counter" for s in kitchen["shapes"]))
        sofa = ue_sets.describe_set("UE_MODERN_INTERIOR", "warm_home", {"preset": "environment"},
                                    {"preset": "living_room"}, (200, 90, 85))
        self.assertFalse(any(s["id"] == "side_table" for s in sofa["shapes"]), "a large product stands on the floor")
        garage = ue_sets.describe_set("UE_INDUSTRIAL_WORKSHOP", "workshop_practical", {"preset": "environment"},
                                      {"preset": "garage"}, (25, 10, 30))
        self.assertTrue(any(s["id"].startswith("door_rib") for s in garage["shapes"]))
        odd = ue_sets.describe_set("UE_INDUSTRIAL_WORKSHOP", "premium_studio", {"preset": "environment"},
                                   {"preset": "bathroom"}, (25, 10, 30))
        self.assertTrue(any("no workshop variant" in w for w in odd["warnings"]))
        arch = ue_sets.describe_set("UE_ARCHITECTURAL_DEMO", "soft_daylight", {"preset": "light_gradient"}, None,
                                    (30, 30, 40))
        self.assertTrue(arch["skyAtmosphere"])
        self.assertTrue(any(lt["kind"] == "directional" for lt in arch["lights"]))

    def test_rejects_unknown_values(self):
        with self.assertRaises(ValueError):
            ue_sets.describe_set("UE_SPACE", "premium_studio", DARK, None, (1, 1, 1))
        with self.assertRaises(ValueError):
            ue_sets.describe_set("UE_LUXURY_STUDIO", "disco", DARK, None, (1, 1, 1))
        with self.assertRaises(ValueError):
            ue_sets.describe_set("UE_LUXURY_STUDIO", "premium_studio", DARK, None, (0, 1, 1))

    def test_expected_actor_count(self):
        d = ue_sets.describe_set("UE_ARCHITECTURAL_DEMO", "premium_studio", DARK, None, (30, 30, 40))
        self.assertEqual(ue_scene.expected_set_actors(d), len(d["shapes"]) + len(d["lights"]) + 1 + 1 + 1)


# --------------------------------------------------------------------------------------- camera / proj ----


class CameraMathTest(unittest.TestCase):
    def test_direction_conventions(self):
        for got, want in ((ue_math.direction(0, 0), (1, 0, 0)), (ue_math.direction(90, 0), (0, -1, 0)),
                          (ue_math.direction(0, 90), (0, 0, 1))):
            for g, w in zip(got, want):
                self.assertAlmostEqual(g, w, places=9)

    def test_basis_is_orthonormal_and_left_handed_like_ue(self):
        fwd, right, up = ue_math.basis(0, 0)
        self.assertEqual((fwd, right, up), ((1, 0, 0), (0, 1, 0), (0, 0, 1)))
        for pitch, yaw in ((10, 30), (-40, 170), (80, -95)):
            f, r, u = ue_math.basis(pitch, yaw)
            for a, b in ((f, r), (f, u), (r, u)):
                self.assertAlmostEqual(ue_math.dot(a, b), 0.0, places=9)
            for v in (f, r, u):
                self.assertAlmostEqual(ue_math.length(v), 1.0, places=9)
            self.assertAlmostEqual(f[2], math.sin(math.radians(pitch)), places=9)

    def test_look_at_points_the_forward_axis_at_the_target(self):
        for cam, tgt in (((300, 0, 50), (0, 0, 20)), ((-10, 250, 300), (5, 5, 5)), ((0, -400, 10), (0, 0, 10))):
            pitch, yaw = ue_math.look_at_rotation(cam, tgt)
            f, _r, _u = ue_math.basis(pitch, yaw)
            d = ue_math.sub(tgt, cam)
            d = ue_math.scale(d, 1 / ue_math.length(d))
            self.assertAlmostEqual(ue_math.dot(f, d), 1.0, places=9)
        with self.assertRaises(ValueError):
            ue_math.look_at_rotation((1, 1, 1), (1, 1, 1))

    def test_projection_orientation(self):
        lens = ue_math.lens_for(50, 1080, 1920)
        self.assertAlmostEqual(lens.sensor_h_mm, 36.0)
        self.assertAlmostEqual(lens.sensor_w_mm, 20.25)
        cam = (500.0, 0.0, 0.0)
        pitch, yaw = ue_math.look_at_rotation(cam, (0, 0, 0))  # looking along −X: the viewer's right is −Y
        u, v, z = ue_math.project((0, 0, 0), cam, pitch, yaw, lens)
        self.assertAlmostEqual(u, 0.5)
        self.assertAlmostEqual(v, 0.5)
        self.assertAlmostEqual(z, 500.0)
        self.assertGreater(ue_math.project((0, -50, 0), cam, pitch, yaw, lens)[0], 0.5)
        self.assertLess(ue_math.project((0, 0, 50), cam, pitch, yaw, lens)[1], 0.5)
        self.assertTrue(math.isnan(ue_math.project((900, 0, 0), cam, pitch, yaw, lens)[0]))
        # pinhole: a 36 mm sensor at f = 50 mm sees 36/50 of the distance vertically
        v_top = ue_math.project((0, 0, 0.5 * 500 * 36 / 50), cam, pitch, yaw, lens)[1]
        self.assertAlmostEqual(v_top, 0.0, places=9)

    def test_project_box(self):
        lens = ue_math.lens_for(50, 1000, 1000)
        cam = (400.0, 0.0, 50.0)
        pitch, yaw = ue_math.look_at_rotation(cam, (0, 0, 50))
        box = ue_math.project_box(ue_math.box_corners((-10, -10, 40), (10, 10, 60)), cam, pitch, yaw, lens)
        self.assertLess(box[0], 0.5)
        self.assertGreater(box[2], 0.5)
        self.assertAlmostEqual((box[1] + box[3]) / 2, 0.5, places=6)
        with_behind = ue_math.box_corners((-10, -10, 40), (10, 10, 60)) + [(1000, 0, 50)]
        self.assertEqual(ue_math.project_box(with_behind, cam, pitch, yaw, lens), box)
        with self.assertRaises(ValueError):
            ue_math.project_box([(1000, 0, 50)], cam, pitch, yaw, lens)

    def test_aim_offset_sign(self):
        lens = ue_math.lens_for(50, 1080, 1920)
        self.assertGreater(ue_math.aim_offset_deg(0.65, lens), 0)  # product low in frame → camera looks up
        self.assertLess(ue_math.aim_offset_deg(0.35, lens), 0)
        self.assertEqual(ue_math.aim_offset_deg(0.5, lens), 0)

    def test_camera_angles_and_product_yaw(self):
        az0, _el0, _ = ue_math.camera_angles("push_in", 1.0, 0.0)
        az1, _el1, dolly1 = ue_math.camera_angles("push_in", 1.0, 1.0)
        self.assertGreater(az1, az0)
        self.assertAlmostEqual(dolly1, 0.32)
        self.assertEqual(ue_math.camera_angles("orbit_closeup", 0.0, 0.7)[0], -26.0)
        self.assertAlmostEqual(ue_math.product_yaw("turntable", 0.0, 2.0, 1.0), 720.0)
        self.assertEqual(ue_math.product_yaw("orbit_wide", 1.0, 1.0, 0.5), 0.0)
        self.assertAlmostEqual(ue_math.product_yaw("hero_low", 1.0, 1.0, 0.0), -6.0)
        self.assertEqual(set(ue_math.CAMERA), set(ue_job.CAMERA_PRESETS))

    def test_plan_honours_fill_and_center_y(self):
        for preset in ("orbit_closeup", "orbit_wide", "turntable", "crane_up", "top_down", "hero_low", "push_in",
                       "dolly_side"):
            for cy in (0.35, 0.5, 0.65):
                plan = ue_math.camera_plan(preset, 0.6, 1.0, {"centerY": cy, "fill": None}, (30, 20, 40), 540, 960, 31)
                boxes = plan["productBoxes"]
                self.assertEqual(len(boxes), 31)
                mid = boxes[15]
                with self.subTest(preset=preset, cy=cy):
                    self.assertAlmostEqual((mid[1] + mid[3]) / 2, cy, delta=0.02)
                    self.assertLessEqual(max(b[3] - b[1] for b in boxes[:3]), plan["fill"] + 0.01)
                    for b in boxes:
                        self.assertTrue(-0.02 <= b[0] < b[2] <= 1.02 and -0.02 <= b[1] < b[3] <= 1.02, b)
        plan = ue_math.camera_plan("orbit_closeup", 0.6, 1.0, {"centerY": 0.5, "fill": 0.3}, (30, 20, 40), 540, 960, 5)
        self.assertAlmostEqual(plan["productBoxes"][0][3] - plan["productBoxes"][0][1], 0.3, delta=0.01)

    def test_macro_is_a_crop_and_tracks_are_reported(self):
        plan = ue_math.camera_plan("macro_slide", 0.6, 1.0, {"centerY": 0.5}, (30, 20, 40), 540, 960, 10)
        self.assertGreater(plan["productBoxes"][0][3] - plan["productBoxes"][0][1], 1.0)
        self.assertEqual(set(plan["anchorTracks"]), {"center", "top"})
        self.assertEqual(len(plan["anchorTracks"]["center"]), 10)

    def test_turntable_spins_the_product_and_keeps_the_camera(self):
        plan = ue_math.camera_plan("turntable", 0.0, 1.0, {"centerY": 0.5}, (30, 20, 40), 540, 960, 9)
        cams = {tuple(round(c, 6) for c in p.camera) for p in plan["poses"]}
        self.assertEqual(len(cams), 1)
        self.assertAlmostEqual(plan["poses"][-1].product_yaw, 360.0)
        self.assertAlmostEqual(plan["poses"][4].product_yaw, 180.0)

    def test_dolly_side_moves_laterally_and_yaw_is_continuous(self):
        plan = ue_math.camera_plan("dolly_side", 1.0, 1.0, {"centerY": 0.5}, (60, 20, 30), 540, 960, 11)
        xs = [p.camera[0] for p in plan["poses"]]
        self.assertGreater(max(xs) - min(xs), 5.0)
        self.assertLess(plan["poses"][0].camera[1], 0)  # camera on the −Y side
        for pr, nx in zip(plan["poses"], plan["poses"][1:]):
            self.assertLess(abs(nx.yaw - pr.yaw), 90)
        self.assertAlmostEqual(ue_math.unwrap_deg(179.0, -179.0), 181.0)
        self.assertAlmostEqual(ue_math.unwrap_deg(-170.0, 170.0), -190.0)

    def test_plan_needs_two_frames(self):
        with self.assertRaises(ValueError):
            ue_math.camera_plan("orbit_wide", 0.6, 1.0, {}, (10, 10, 10), 128, 128, 1)


# --------------------------------------------------------------------------------------- scale / place ----


class ScaleTest(unittest.TestCase):
    def test_matching_size_keeps_scale(self):
        r = ue_math.normalise_scale((20.0, 10.0, 30.0), [0.2, 0.1, 0.3])
        self.assertAlmostEqual(r["scale"], 1.0)
        self.assertEqual(r["warnings"], [])
        self.assertEqual(r["expectedCm"], [20.0, 10.0, 30.0])

    def test_small_mismatch_is_tolerated(self):
        r = ue_math.normalise_scale((21.0, 10.4, 31.5), [0.2, 0.1, 0.3])
        self.assertLess(r["mismatchPct"], 10)
        self.assertEqual(r["warnings"], [])

    def test_unit_errors_are_named_and_corrected(self):
        r = ue_math.normalise_scale((0.2, 0.1, 0.3), [0.2, 0.1, 0.3])  # metres imported as centimetres
        self.assertAlmostEqual(r["scale"], 100.0)
        self.assertIn("metres", r["unitCorrection"])
        self.assertTrue(any("unit error" in w for w in r["warnings"]))
        r = ue_math.normalise_scale((7.874, 3.937, 11.811), [0.2, 0.1, 0.3])  # inches
        self.assertIn("inches", r["unitCorrection"])

    def test_large_mismatch_and_proportions_warn(self):
        r = ue_math.normalise_scale((26.0, 13.0, 39.0), [0.2, 0.1, 0.3])
        self.assertAlmostEqual(r["scale"], 30 / 39)
        self.assertTrue(any("differs" in w for w in r["warnings"]))
        r = ue_math.normalise_scale((30.0, 30.0, 30.0), [0.2, 0.1, 0.3])
        self.assertTrue(any("proportions" in w for w in r["warnings"]))
        r = ue_math.normalise_scale((30.0, 10.0, 20.0), [0.2, 0.1, 0.3])  # lying on its side
        self.assertTrue(any("side" in w for w in r["warnings"]))

    def test_no_declared_dimensions(self):
        r = ue_math.normalise_scale((20.0, 10.0, 30.0), None)
        self.assertEqual((r["scale"], r["warnings"]), (1.0, []))
        self.assertTrue(ue_math.normalise_scale((0.2, 0.1, 0.3), None)["warnings"])
        with self.assertRaises(ValueError):
            ue_math.normalise_scale((0.0, 0.0, 0.0), None)

    def test_placement_centres_and_grounds(self):
        lo, hi = (10.0, -4.0, 5.0), (30.0, 6.0, 25.0)
        off = ue_math.placement(lo, hi, 2.0)
        placed_lo = tuple(lo[i] * 2 + off[i] for i in range(3))
        placed_hi = tuple(hi[i] * 2 + off[i] for i in range(3))
        self.assertAlmostEqual(placed_lo[0] + placed_hi[0], 0.0)
        self.assertAlmostEqual(placed_lo[1] + placed_hi[1], 0.0)
        self.assertAlmostEqual(placed_lo[2], 0.0)

    def test_rotated_and_union_bounds(self):
        lo, hi = ue_math.rotated_aabb((-10, -5, 0), (10, 5, 4), 90)
        self.assertAlmostEqual(lo[0], -5)
        self.assertAlmostEqual(hi[1], 10)
        self.assertEqual(ue_math.union_bounds([((0, 0, 0), (1, 1, 1)), ((-1, 2, 0), (0, 3, 5))]),
                         ((-1, 0, 0), (1, 3, 5)))
        with self.assertRaises(ValueError):
            ue_math.union_bounds([])

    def test_front_yaw_per_importer(self):
        self.assertEqual(ue_math.import_front_yaw("fbx", False), 0.0)
        self.assertEqual(ue_math.import_front_yaw("fbx", True), -90.0)
        self.assertEqual(ue_math.import_front_yaw("glb", True), 0.0)


# ------------------------------------------------------------------------------------------- materials ----


def row(name, status, notes=(), textures=(), **extra):
    r = {"material": name, "status": status, "notes": list(notes), "textures": list(textures), "baseColor": None,
         "roughness": None, "metallic": None}
    r.update(extra)
    return r


class MaterialTest(unittest.TestCase):
    def test_pbr_direct_is_kept(self):
        p = ue_materials.plan_material("Body", row("Body", "PBR_DIRECT"), None)
        self.assertEqual((p["action"], p["warnings"]), ("keep", []))

    def test_unsupported_gets_a_neutral_stand_in(self):
        p = ue_materials.plan_material("Glow", row("Glow", "UNSUPPORTED", ["surface is EMISSION"]), None)
        self.assertEqual((p["action"], p["parent"]), ("neutral", "opaque"))
        self.assertTrue(p["warnings"])

    def test_needs_bake(self):
        p = ue_materials.plan_material("Wood", row("Wood", "NEEDS_BAKE"), None)
        self.assertEqual(p["action"], "keep")
        self.assertTrue(any("baked" in w for w in p["warnings"]))
        baked = {"baseColor": "/o/a.png", "normal": "/o/n.png"}
        p = ue_materials.plan_material("Wood", row("Wood", "NEEDS_BAKE"), baked)
        self.assertEqual((p["action"], p["parent"]), ("instance", "textured"))
        self.assertEqual(p["textures"], {"BaseColorMap": "/o/a.png", "NormalMap": "/o/n.png"})
        self.assertTrue(any("roughness" in w for w in p["warnings"]))

    def test_approximated_features(self):
        glass = ue_materials.plan_material("Glass", row("Glass", "APPROXIMATED", [
            "Transmission Weight=0.90: needs a UE material instance setting"], baseColor="#ffffff"), None)
        self.assertEqual(glass["parent"], "translucent")
        self.assertAlmostEqual(glass["scalars"]["Opacity"], 0.235, places=3)
        self.assertEqual(glass["vectors"]["BaseColor"], (1.0, 1.0, 1.0))
        paint = ue_materials.plan_material("Paint", row("Paint", "APPROXIMATED", ["Coat Weight=0.80: x"],
                                                        roughness=0.4), None)
        self.assertEqual(paint["parent"], "clearcoat")
        self.assertEqual(paint["scalars"]["ClearCoat"], 0.8)
        cloth = ue_materials.plan_material("Cloth", row("Cloth", "APPROXIMATED", ["Sheen Weight=1.00: x"]), None)
        self.assertEqual(cloth["parent"], "opaque")
        self.assertGreater(cloth["scalars"]["Roughness"], 0.5)
        self.assertTrue(any("no base colour" in w for w in cloth["warnings"]))
        textured = ue_materials.plan_material("Fabric", row("Fabric", "APPROXIMATED", ["Sheen Weight=0.5: x"],
                                                            ["fabric.png"]), None)
        self.assertEqual(textured["action"], "keep")
        self.assertTrue(any("by hand" in w for w in textured["warnings"]))

    def test_note_values(self):
        self.assertEqual(ue_materials.note_values(["Coat Weight=0.80: needs", "emission: map", "Anisotropic=2"]),
                         {"Coat Weight": 0.8, "Anisotropic": 1.0})

    def test_slot_matching(self):
        report = {"materials": [row("Body Paint", "PBR_DIRECT"), row("Chrome.001", "APPROXIMATED"),
                                row("Rubber", "PBR_DIRECT")]}
        m = ue_materials.match_rows(["Body_Paint", "M_Chrome_001", "Rubber_002", "Unknown"], report)
        self.assertEqual(m["Body_Paint"]["material"], "Body Paint")
        self.assertEqual(m["M_Chrome_001"]["material"], "Chrome.001")
        self.assertEqual(m["Rubber_002"]["material"], "Rubber")
        self.assertIsNone(m["Unknown"])

    def test_plan_materials_summary(self):
        report = {"materials": [row("Body", "PBR_DIRECT"), row("Glass", "APPROXIMATED", ["Transmission Weight=0.5"])]}
        a = ue_materials.plan_materials(["Body", "Glass", "Extra"], report, None)
        b = ue_materials.plan_materials(["Body", "Glass", "Extra"], copy.deepcopy(report), None)
        self.assertEqual(a["hash"], b["hash"])
        self.assertEqual([p["action"] for p in a["plans"]], ["keep", "instance", "keep"])
        self.assertTrue(any("not in the material report" in w for w in a["warnings"]))
        none = ue_materials.plan_materials(["Body"], None, None)
        self.assertEqual(none["plans"][0]["action"], "keep")
        self.assertTrue(any("no material report" in w for w in none["warnings"]))
        name = ue_materials.instance_name(a["plans"][1], "prod.1/../x")
        self.assertRegex(name, r"^MI_[A-Za-z0-9_]+$")
        self.assertEqual(name, ue_materials.instance_name(b["plans"][1], "prod.1/../x"))


# --------------------------------------------------------------------------------------------- MRQ / GI ----


class MrqTest(unittest.TestCase):
    def test_quality_profiles(self):
        render = {"executor": "pie", "spatialSamples": None, "temporalSamples": None, "warmUpFrames": None}
        p = ue_mrq.mrq_settings("preview", render, 540, 960, 30, "/o/frames", "lumen")
        self.assertEqual((p["spatialSamples"], p["temporalSamples"], p["antiAliasing"]), (1, 1, "engine_default"))
        q = ue_mrq.mrq_settings("production", render, 1080, 1920, 30, "/o/frames", "lumen")
        self.assertEqual((q["temporalSamples"], q["antiAliasing"]), (8, "none"))
        self.assertEqual(q["fileNameFormat"], "f_{frame_number}")
        self.assertEqual(q["framePattern"], "f_%04d.png")
        o = ue_mrq.mrq_settings("preview", {**render, "spatialSamples": 4}, 540, 960, 30, "/o/frames", "screen_space")
        self.assertEqual(o["antiAliasing"], "none")
        self.assertEqual(o["cvars"]["r.SSGI.Enable"], 1)
        self.assertEqual(o["cvars"]["r.MotionBlurQuality"], 0)

    def test_gi_choice(self):
        self.assertEqual(ue_mrq.choose_gi("screen_space", {"r.RayTracing": 1}), ("screen_space", None))
        self.assertEqual(ue_mrq.choose_gi("auto", {"r.GenerateMeshDistanceFields": 1}), ("lumen", None))
        self.assertEqual(ue_mrq.choose_gi("lumen", {"r.RayTracing": 1})[0], "lumen")
        gi, warn = ue_mrq.choose_gi("lumen", {"r.GenerateMeshDistanceFields": 0, "r.RayTracing": None})
        self.assertEqual(gi, "screen_space")
        self.assertIn("unavailable", warn)


# ---------------------------------------------------------------------------- API variants / diagnose ----


class _Seq:
    def add_track(self, cls):
        return ("track", cls)

    def get_binding_id(self, b):
        return ("id", b)


class _OldSeq:
    def add_master_track(self, cls):
        return ("master", cls)

    def make_binding_id(self, b, space):
        return ("made", b, space)


def fake_unreal(new: bool = True) -> types.SimpleNamespace:
    """A minimal stand-in for the `unreal` module: just the attributes the probes look at."""
    ns = types.SimpleNamespace()
    names = ["AssetToolsHelpers", "AssetImportTask", "MaterialEditingLibrary", "MaterialInstanceConstant",
             "MaterialFactoryNew", "MaterialInstanceConstantFactoryNew", "LevelSequence", "LevelSequenceFactoryNew",
             "MovieScene3DTransformTrack", "MovieSceneCameraCutTrack", "CineCameraActor", "MoviePipelineExecutorJob",
             "MoviePipelineOutputSetting", "MoviePipelineDeferredPassBase", "MoviePipelineImageSequenceOutput_PNG",
             "StaticMeshActor", "SystemLibrary", "Paths", "EditorAssetLibrary", "MovieSceneScriptingDoubleChannel"]
    for n in names:
        setattr(ns, n, type(n, (), {}))
    ns.get_editor_subsystem = lambda cls: None
    ns.register_slate_post_tick_callback = lambda fn: 1
    ns.MovieSceneSection = type("MovieSceneSection", (), {"get_all_channels" if new else "get_channels": lambda s: []})
    if new:
        ns.EditorActorSubsystem = type("EditorActorSubsystem", (), {})
        ns.LevelEditorSubsystem = type("LevelEditorSubsystem", (), {})
        ns.UnrealEditorSubsystem = type("UnrealEditorSubsystem", (), {})
        ns.MoviePipelinePrimaryConfig = type("MoviePipelinePrimaryConfig", (), {})
        ns.MovieSceneSequence = _Seq
        ns.MoviePipelineQueueSubsystem = type("MoviePipelineQueueSubsystem", (), {
            "render_queue_with_executor_instance": lambda s, e: None})
    else:
        ns.EditorLevelLibrary = type("EditorLevelLibrary", (), {})
        ns.MoviePipelineMasterConfig = type("MoviePipelineMasterConfig", (), {})
        ns.MovieSceneSequence = _OldSeq
        ns.MoviePipelineQueueSubsystem = type("MoviePipelineQueueSubsystem", (), {
            "render_queue_with_executor": lambda s, c: None})
    ns.MovieSceneObjectBindingSpace = types.SimpleNamespace(LOCAL="LOCAL")
    return ns


class CompatTest(unittest.TestCase):
    def test_resolves_new_and_old_names(self):
        new = ue_compat.resolve(fake_unreal(True))
        self.assertEqual(new["actors"], "EditorActorSubsystem")
        self.assertEqual(new["mrqConfig"], "MoviePipelinePrimaryConfig")
        self.assertEqual(new["sequenceAddTrack"], "MovieSceneSequence.add_track")
        self.assertEqual(new["sectionChannels"], "MovieSceneSection.get_all_channels")
        self.assertEqual(ue_compat.missing_required(new), [])
        old = ue_compat.resolve(fake_unreal(False))
        self.assertEqual(old["actors"], "EditorLevelLibrary")
        self.assertEqual(old["mrqConfig"], "MoviePipelineMasterConfig")
        self.assertEqual(old["sequenceAddTrack"], "MovieSceneSequence.add_master_track")
        self.assertEqual(old["sequenceBindingId"], "MovieSceneSequence.make_binding_id")
        self.assertEqual(ue_compat.missing_required(old), [])
        self.assertTrue(ue_compat.missing_required(ue_compat.resolve(types.SimpleNamespace())))

    def test_facade_falls_back(self):
        api = ue_compat.Api(fake_unreal(False))
        self.assertEqual(api.add_track(_OldSeq(), "T"), ("master", "T"))
        self.assertEqual(api.binding_id(_OldSeq(), "b"), ("made", "b", "LOCAL"))
        self.assertEqual(api.add_track(_Seq(), "T"), ("track", "T"))
        self.assertEqual(api.binding_id(_Seq(), "b"), ("id", "b"))
        self.assertEqual(api.used["sequenceBindingId"], "get_binding_id")
        api.actors()
        self.assertEqual(api.used["actors"], "EditorLevelLibrary")
        with self.assertRaises(ue_compat.ApiMissing):
            ue_compat.Api(types.SimpleNamespace(get_editor_subsystem=lambda c: None)).actors()

    def test_outside_the_editor(self):
        self.assertIsNone(ue_compat.unreal)
        with self.assertRaises(ue_compat.ApiMissing):
            ue_compat.Api()


class DiagnoseTest(unittest.TestCase):
    def test_report_new_engine(self):
        with tempfile.TemporaryDirectory() as d:
            up = os.path.join(d, "R.uproject")
            with open(up, "w") as fh:
                json.dump({"FileVersion": 3, "Plugins": [{"Name": "MovieRenderPipeline", "Enabled": True},
                                                         {"Name": "SomeMCPBridge", "Enabled": True}]}, fh)
            rep = ue_diagnose.build_report(fake_unreal(True), {"uproject": up, "dedicated": True},
                                           {"r.GenerateMeshDistanceFields": 1}, None, "5.8.1-0+++UE5+Release-5.8",
                                           {"enabled": True, "multicastBindAddress": "0.0.0.0", "multicastTtl": 0})
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["variantsFound"]["mrqConfig"], "MoviePipelinePrimaryConfig")
        self.assertEqual(rep["rendering"]["gi"], "lumen")
        self.assertEqual(rep["plugins"]["expected"]["MovieRenderPipeline"],
                         {"enabled": True, "method": "uproject"})
        self.assertEqual(rep["plugins"]["aiIntegrationCandidates"], ["SomeMCPBridge"])
        self.assertTrue(any("127.0.0.1" in w for w in rep["warnings"]))
        json.dumps(rep)

    def test_report_old_engine_not_dedicated(self):
        rep = ue_diagnose.build_report(fake_unreal(False), {"uproject": None, "dedicated": False}, {}, ["Foo"],
                                       "5.0.3", None)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("dedicated" in w for w in rep["warnings"]))
        self.assertTrue(any("MoviePipelineMasterConfig" in w for w in rep["warnings"]))
        self.assertEqual(rep["plugins"]["enabledSource"], "PluginBlueprintLibrary")
        self.assertFalse(rep["plugins"]["expected"]["MovieRenderPipeline"]["enabled"])

    def test_output_path(self):
        self.assertEqual(ue_diagnose.output_path(["x", os.path.join(TMP, "d.json")], {}, None),
                         os.path.join(TMP, "d.json"))
        self.assertEqual(ue_diagnose.output_path(["x"], {}, os.path.join(TMP, "Saved")),
                         os.path.join(TMP, "Saved", "Render3D", "diagnose.json"))

    def test_main_outside_the_editor(self):
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            self.assertEqual(ue_diagnose.main(["ue_diagnose.py"], {}), 1)
        self.assertIn("not_in_editor", err.getvalue())


# --------------------------------------------------------------------------------------- ue_scene glue ----


class SceneHelpersTest(unittest.TestCase):
    def test_owned_paths(self):
        self.assertEqual(ue_scene.level_path("UE_LUXURY_STUDIO"), "/Game/Render3D/Levels/L_UE_LUXURY_STUDIO")
        self.assertEqual(ue_scene.product_folder("prod.1/../../Maps"), "/Game/Render3D/Products/prod_1_______Maps")
        self.assertEqual(ue_scene.object_path("/Game/Render3D/Levels/L_X"), "/Game/Render3D/Levels/L_X.L_X")
        for bad in ("/Game/Maps/Main", "/Game/Render3D/../Maps", "/Engine/BasicShapes", "/Game/Render3DX"):
            with self.assertRaises(ValueError):
                ue_util.own_path(bad)

    def test_import_decision(self):
        sha = "b" * 64
        entry = {"sha256": sha, "format": "fbx"}
        self.assertEqual(ue_scene.import_decision(entry, sha, [sha], "fbx"), (False, "unchanged (sha256 matches)"))
        self.assertTrue(ue_scene.import_decision(entry, "c" * 64, [sha], "fbx")[0])
        self.assertTrue(ue_scene.import_decision(entry, sha, [], "fbx")[0])
        self.assertTrue(ue_scene.import_decision(None, sha, [sha], "fbx")[0])
        self.assertTrue(ue_scene.import_decision(entry, sha, [None], "fbx")[0])
        self.assertTrue(ue_scene.import_decision(entry, sha, [sha], "glb")[0])

    def test_failure_classification(self):
        self.assertEqual(ue_scene.classify(ue_job.UeJobError("x")), (3, "invalid_job"))
        self.assertEqual(ue_scene.classify(ue_scene.ProjectError("x")), (1, "not_dedicated_project"))
        self.assertEqual(ue_scene.classify(ue_compat.ApiMissing("x")), (1, "api_missing"))
        self.assertEqual(ue_scene.classify(ue_scene.RenderError("x")), (1, "render_failed"))
        self.assertEqual(ue_scene.classify(KeyError("x")), (1, "error"))
        doc = ue_scene.failure_doc("j", 1, "render_failed", "boom", ["w"], {})
        self.assertFalse(doc["ok"])

    def test_manifest_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "m.json")
            self.assertEqual(ue_scene.load_manifest(p), {"products": {}})
            ue_util.atomic_write_json(p, {"products": {"a": {"sha256": "x"}}})
            self.assertEqual(ue_scene.load_manifest(p)["products"]["a"]["sha256"], "x")
            with open(p, "w") as fh:
                fh.write("{broken")
            self.assertEqual(ue_scene.load_manifest(p), {"products": {}})

    def test_main_outside_the_editor(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out")
            job = make_job(output={"dir": out})
            job_path = os.path.join(d, "job.json")
            with open(job_path, "w") as fh:
                json.dump(job, fh)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = ue_scene.main(["ue_scene.py", job_path], {})
            self.assertEqual(code, 1)  # valid job, but no editor: a failure result, nothing rendered
            with open(os.path.join(out, "result.json")) as fh:
                res = json.load(fh)
            self.assertEqual((res["ok"], res["error"]), (False, "api_missing"))
            self.assertTrue(os.path.isfile(os.path.join(out, "ue_scene.log")))
            bad = dict(job, template="NOPE", output={"dir": os.path.join(d, "bad")})
            with open(job_path, "w") as fh:
                json.dump(bad, fh)
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                self.assertEqual(ue_scene.main(["ue_scene.py", job_path], {}), 3)
            self.assertFalse(os.path.exists(os.path.join(d, "bad")), "an invalid job writes nothing")
            self.assertIn("invalid_job", err.getvalue())


# ------------------------------------------------------------------------------------------------ util ----


class UtilTest(unittest.TestCase):
    def test_scan_frames_and_timings(self):
        with tempfile.TemporaryDirectory() as d:
            for k in (1, 2, 3):
                ue_util.solid_png(os.path.join(d, f"f_{k:04d}.png"), 4, 4, (10, 20, 30))
            open(os.path.join(d, "f_12.png"), "w").close()
            s = ue_util.scan_frames(d)
            self.assertEqual((s["start"], s["count"], s["contiguous"]), (1, 3, True))
            os.remove(os.path.join(d, "f_0002.png"))
            self.assertFalse(ue_util.scan_frames(d)["contiguous"])
        self.assertEqual(ue_util.scan_frames("/nonexistent/x")["count"], 0)
        self.assertEqual(ue_util.frame_ms_from_mtimes([1, 2], {1: 10.5, 2: 11.0}, 10.0), [500, 500])

    def test_png_writer(self):
        data = ue_util.png_bytes(3, 2, [bytes([255, 0, 0] * 3), bytes([0, 0, 255] * 3)])
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        w, h = struct.unpack(">II", data[16:24])
        self.assertEqual((w, h), (3, 2))
        idat = data.index(b"IDAT")
        n = struct.unpack(">I", data[idat - 4:idat])[0]
        raw = zlib.decompress(data[idat + 4:idat + 4 + n])
        self.assertEqual(raw[:4], b"\x00\xff\x00\x00")

    def test_dedicated_marker(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(ue_util.is_dedicated_project(d))
            with open(os.path.join(d, ue_util.MARKER_FILE), "w") as fh:
                fh.write("[Render3D]\nDedicatedRenderProject=False\n")
            self.assertFalse(ue_util.is_dedicated_project(d))
            with open(os.path.join(d, ue_util.MARKER_FILE), "w") as fh:
                fh.write(ue_project.MARKER_TEXT)
            self.assertTrue(ue_util.is_dedicated_project(d))

    def test_atomic_write_rejects_nan(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                ue_util.atomic_write_json(os.path.join(d, "x.json"), {"a": float("nan")})


# ----------------------------------------------------------------------------------------- project CLI ----


class ProjectSetupTest(unittest.TestCase):
    def _project(self, d, **extra):
        up = os.path.join(d, "Render3D.uproject")
        with open(up, "w") as fh:
            json.dump({"FileVersion": 3, "EngineAssociation": "5.8", "Category": "", "Description": "", **extra}, fh)
        os.makedirs(os.path.join(d, "Content"))
        return up

    def test_init_fresh_project(self):
        with tempfile.TemporaryDirectory() as d:
            up = self._project(d)
            res = ue_project.init(up, remote_exec=True, lumen=True)
            self.assertEqual(set(res["pluginsEnabled"]), set(ue_project.PLUGINS))
            self.assertTrue(os.path.isfile(up + ".bak"))
            self.assertTrue(ue_util.is_dedicated_project(os.path.join(d, "Config")))
            with open(os.path.join(d, "Config", "DefaultEngine.ini")) as fh:
                ini = fh.read()
            self.assertIn("RemoteExecutionMulticastBindAddress=127.0.0.1", ini)
            self.assertIn("RemoteExecutionMulticastTtl=0", ini)
            self.assertIn("r.DynamicGlobalIlluminationMethod=1", ini)
            again = ue_project.init(up)
            self.assertEqual(again["pluginsEnabled"], [])
            self.assertTrue(again["wasDedicated"])
            chk = ue_project.check(up)
            self.assertTrue(chk["dedicated"] and all(chk["plugins"].values()))

    def test_refuses_game_projects(self):
        with tempfile.TemporaryDirectory() as d:
            up = self._project(d, Modules=[{"Name": "MyGame", "Type": "Runtime"}])
            os.makedirs(os.path.join(d, "Content", "Maps"))
            with self.assertRaises(ue_project.ProjectSetupError) as cm:
                ue_project.init(up)
            self.assertIn("C++ modules", str(cm.exception))
            self.assertFalse(os.path.exists(os.path.join(d, "Config", ue_util.MARKER_FILE)))
        with self.assertRaises(ue_project.ProjectSetupError):
            ue_project.init(os.path.join(TMP, "missing.uproject"))

    def test_ini_set(self):
        text = "[A]\nx=1\n\n[B]\ny=2\n"
        out = ue_project.ini_set(text, "[A]", [("x", "3"), ("z", "4")])
        self.assertEqual(out, "[A]\nx=3\nz=4\n\n[B]\ny=2\n")
        self.assertEqual(ue_project.ini_set("", "[C]", [("k", "v")]), "[C]\nk=v\n")

    def test_add_plugins_switches_disabled_entries_on(self):
        data, changed = ue_project.add_plugins({"Plugins": [{"Name": "PythonScriptPlugin", "Enabled": False}]})
        self.assertIn("PythonScriptPlugin", changed)
        self.assertTrue(all(p["Enabled"] for p in data["Plugins"]))


# ------------------------------------------------------------------------------------------ remote exec ----


class MockEditor(threading.Thread):
    """A loopback stand-in for the editor's remote execution (unicast discovery): answers ping with pong, connects
    back on open_connection and answers one command with a command_result echoing it. MOCK — not a UE editor."""

    def __init__(self):
        super().__init__(daemon=True)
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind(("127.0.0.1", 0))
        self.udp.settimeout(0.1)
        self.port = self.udp.getsockname()[1]
        self.node_id = "mock-editor-node"
        self.commands: list[dict] = []
        self.stop = False

    def run(self):
        while not self.stop:
            try:
                raw, addr = self.udp.recvfrom(65535)
            except socket.timeout:
                continue
            msg = remote_exec.decode(raw)
            if not msg:
                continue
            if msg["type"] == "ping":
                self.udp.sendto(remote_exec.encode("pong", self.node_id, msg["source"],
                                                   {"engine_version": "MOCK", "project_name": "Render3D"}), addr)
            elif msg["type"] == "open_connection" and msg.get("dest") == self.node_id:
                d = msg["data"]
                with socket.create_connection((d["command_ip"], d["command_port"]), timeout=2) as c:
                    stream = remote_exec.JsonStream()
                    while True:
                        parts = stream.push(c.recv(65536))
                        if parts:
                            cmd = remote_exec.decode(parts[0])
                            self.commands.append(cmd)
                            reply = remote_exec.encode("command_result", self.node_id, cmd["source"], {
                                "success": True, "command": cmd["data"]["command"], "result": "None",
                                "output": [{"type": "Info", "output": "MOCK"}]})
                            c.sendall(reply[:10])  # fragmented on purpose
                            c.sendall(reply[10:])
                            break
        self.udp.close()


class RemoteExecTest(unittest.TestCase):
    def test_messages(self):
        raw = remote_exec.encode("ping", "me")
        self.assertEqual(json.loads(raw), {"version": 1, "magic": "ue_py", "type": "ping", "source": "me"})
        self.assertEqual(remote_exec.decode(raw)["type"], "ping")
        for bad in (b"{}", b"not json", json.dumps({"version": 2, "magic": "ue_py", "type": "ping", "source": "x"}),
                    json.dumps({"version": 1, "magic": "ue_py", "type": "exec", "source": "x"})):
            self.assertIsNone(remote_exec.decode(bad))
        with self.assertRaises(ValueError):
            remote_exec.encode("shell", "me")

    def test_json_stream(self):
        s = remote_exec.JsonStream()
        a = b'{"a": "x}{\\"y", "b": {"c": 1}}'
        b = b'{"d": 2}'
        self.assertEqual(s.push(a[:7]), [])
        self.assertEqual(s.push(a[7:] + b + b'{"e"'), [a, b])
        self.assertEqual(s.push(b": 3}"), [b'{"e": 3}'])
        with self.assertRaises(remote_exec.RemoteExecError):
            remote_exec.JsonStream(limit=10).push(b"{" + b" " * 20)

    def test_whitelisted_command(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "dir with space", "diag.json")
            code = remote_exec.whitelisted_command("diagnose", out)
            compile(code, "<remote>", "exec")
            self.assertIn(json.dumps(os.path.join(os.path.realpath(HERE), "ue_diagnose.py")), code)
            self.assertIn("--no-exit", code)
            for kind, path in (("shell", out), ("diagnose", "rel.json"), ("diagnose", out[:-5] + ".py"),
                               ("diagnose", out + "\n")):
                with self.assertRaises(remote_exec.RemoteExecError):
                    remote_exec.whitelisted_command(kind, path)
            job = os.path.join(d, "job.json")
            with open(job, "w") as fh:
                json.dump(make_job(), fh)
            with self.assertRaises(remote_exec.RemoteExecError):
                remote_exec.whitelisted_command("scene", job)  # not interactive
            with open(job, "w") as fh:
                json.dump(make_job(interactive=True), fh)
            compile(remote_exec.whitelisted_command("scene", job), "<remote>", "exec")
            evil = os.path.join(d, 'x"]); import os; os.system("calc') + ".json"
            code = remote_exec.whitelisted_command("diagnose", evil)
            tree = compile(code, "<remote>", "exec")
            self.assertNotIn("system", tree.co_names)  # the path stays a string literal

    def test_loopback_only(self):
        self.assertTrue(remote_exec.is_loopback("127.0.0.1") and remote_exec.is_loopback("::1"))
        self.assertFalse(remote_exec.is_loopback("192.168.1.5") or remote_exec.is_loopback("example.com"))
        with self.assertRaises(remote_exec.RemoteExecError):
            remote_exec.RemoteExecClient(interface="192.168.1.5", unicast=True)
        with self.assertRaises(remote_exec.RemoteExecError):
            remote_exec.RemoteExecClient(command=("0.0.0.0", 0), unicast=True)
        with self.assertRaises(remote_exec.RemoteExecError):
            remote_exec.RemoteExecClient(ttl=1, unicast=True)

    def test_round_trip_with_mock_editor(self):
        mock = MockEditor()
        mock.start()
        try:
            with tempfile.TemporaryDirectory() as d, remote_exec.RemoteExecClient(
                    ("127.0.0.1", mock.port), command=("127.0.0.1", 0), unicast=True) as client:
                nodes = client.discover(timeout=0.6)
                self.assertEqual([n["nodeId"] for n in nodes], ["mock-editor-node"])
                cmd = remote_exec.whitelisted_command("diagnose", os.path.join(d, "diag.json"))
                res = client.run(nodes[0]["nodeId"], cmd, timeout=5)
                self.assertTrue(res["success"])
                self.assertEqual(res["output"][0]["output"], "MOCK")
                self.assertEqual(mock.commands[0]["data"]["exec_mode"], "ExecuteFile")
                self.assertEqual(mock.commands[0]["data"]["command"], cmd)
        finally:
            mock.stop = True
            mock.join(2)


# ------------------------------------------------------------------------- editor glue via FAKE unreal ----


class FakeEditorRunTest(unittest.TestCase):
    """ue_scene.py's editor-side code driven through fake_unreal.py (a FAKE `unreal`, renders nothing): catches
    errors in the glue between the pure modules and the editor API. Results it produces are labelled mock."""

    def setUp(self):
        import fake_unreal  # noqa: PLC0415

        self.fake_mod = fake_unreal
        self.tmp = tempfile.mkdtemp()
        self.project = os.path.join(self.tmp, "Render3D")
        os.makedirs(os.path.join(self.project, "Config"))
        with open(os.path.join(self.project, "Config", ue_util.MARKER_FILE), "w") as fh:
            fh.write(ue_project.MARKER_TEXT)
        self.model = os.path.join(self.tmp, "product.fbx")
        with open(self.model, "w") as fh:
            fh.write("MOCK FBX")
        self.saved = (sys.modules.get("unreal"), ue_compat.unreal, ue_scene.unreal, ue_scene.exit_editor,
                      fake_unreal.PRODUCT_BOUNDS)
        self.exits: list[int] = []
        ue_scene.exit_editor = lambda ue, code: self.exits.append(code)
        self.fake = fake_unreal.install(self.project)

    def tearDown(self):
        import shutil  # noqa: PLC0415

        unreal_mod, compat_u, scene_u, exit_fn, bounds = self.saved
        if unreal_mod is None:
            sys.modules.pop("unreal", None)
        else:
            sys.modules["unreal"] = unreal_mod
        ue_compat.unreal, ue_scene.unreal, ue_scene.exit_editor = compat_u, scene_u, exit_fn
        self.fake_mod.PRODUCT_BOUNDS = bounds
        ue_scene._ACTIVE.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def job(self, **over) -> str:
        j = make_job(output={"dir": os.path.join(self.tmp, "out")}, durationSec=0.5, fps=24, resolution=[256, 256])
        j["product"].update(path=self.model, sha256=ue_util.file_sha256(self.model))
        j["product"]["materialReport"] = {"materials": [row("Body", "PBR_DIRECT"),
                                                        row("Glass", "APPROXIMATED", ["Transmission Weight=0.9: x"])]}
        for k, v in over.items():
            j[k] = v
        path = os.path.join(self.tmp, "job.json")
        with open(path, "w") as fh:
            json.dump(j, fh)
        return path

    def run_job(self, path: str, ticks: int = 40) -> dict:
        self.exits.clear()
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = ue_scene.main(["ue_scene.py", path], {})
            self.assertEqual(code, 0)
            for _ in range(ticks):
                if self.exits:
                    break
                self.fake.tick()
        with open(os.path.join(self.tmp, "out", "result.json")) as fh:
            return json.load(fh)

    def test_full_run_then_reuse_then_reimport(self):
        res = self.run_job(self.job())
        self.assertEqual(self.exits, [0])
        self.assertEqual(self.fake.quit_called, 0)  # exit_editor is patched: the decision was "quit with 0"
        self.assertTrue(res["ok"] and res["mock"])
        self.assertEqual(res["frames"]["count"], 12)
        self.assertEqual((res["frames"]["width"], res["frames"]["height"]), (128, 128))
        self.assertEqual(ue_util.scan_frames(os.path.join(self.tmp, "out", "frames"))["start"], 1)
        self.assertEqual(len(res["productBoxes"]), 12)
        self.assertFalse(res["product"]["importSkipped"])
        self.assertAlmostEqual(res["product"]["scaleApplied"], 1.2, places=4)  # 25 cm model, 30 cm declared
        self.assertTrue(any("differs" in w for w in res["warnings"]))
        self.assertEqual([m["action"] for m in res["materials"]], ["keep", "instance"])
        self.assertTrue(res["set"]["rebuilt"])
        self.assertEqual(res["unreal"]["configClass"], "MoviePipelinePrimaryConfig")
        self.assertEqual(res["unreal"]["apiVariants"]["sequenceAddTrack"], "add_track")
        self.assertEqual(res["mrq"]["temporalSamples"], 1)
        seq = self.fake.assets["/Game/Render3D/Sequences/LS_UE_LUXURY_STUDIO"]
        self.assertEqual(seq.playback, [0, 12])
        cam = next(b for b in seq.bindings if isinstance(b.actor, self.fake.CineCameraActor))
        loc_x = next(c for c in cam.tracks[0].sections[0].channels if c.name == "Location.X")
        self.assertEqual([k[0] for k in loc_x.keys], list(range(12)))
        self.assertTrue(all(a.actor_has_tag("R3D_SET") or a.actor_has_tag("R3D_PRODUCT") or
                            a.actor_has_tag("R3D_CAMERA") for a in self.fake.level_actors()))
        # same model, same set: nothing re-imported, nothing rebuilt
        again = self.run_job(self.job())
        self.assertTrue(again["product"]["importSkipped"])
        self.assertFalse(again["set"]["rebuilt"])
        # the model changes: re-imported
        with open(self.model, "w") as fh:
            fh.write("MOCK FBX v2")
        third = self.run_job(self.job())
        self.assertFalse(third["product"]["importSkipped"])

    def test_unit_error_is_corrected(self):
        self.fake_mod.PRODUCT_BOUNDS = ((-0.1, -0.05, 0.0), (0.1, 0.05, 0.3))  # metres read as centimetres
        res = self.run_job(self.job())
        self.assertAlmostEqual(res["product"]["scaleApplied"], 100.0, places=3)
        self.assertIn("metres", res["product"]["unitCorrection"])

    def test_refuses_a_project_without_the_marker(self):
        os.remove(os.path.join(self.project, "Config", ue_util.MARKER_FILE))
        res = self.run_job(self.job())
        self.assertEqual((res["ok"], res["error"], self.exits), (False, "not_dedicated_project", [1]))
        self.assertEqual(self.fake.assets, {}, "nothing was created")

    def test_render_failure_and_interactive_runs(self):
        self.fake.MoviePipelinePIEExecutor = type("FailingExecutor", (self.fake_mod.Executor,), {})
        orig = self.fake._mrq_step

        def failing():
            qs = self.fake._subsystems.get(self.fake_mod.MoviePipelineQueueSubsystem)
            if qs and qs.executor is not None and not qs.executor.__dict__.get("done"):
                qs.executor.__dict__["done"] = True
                qs.executor.on_executor_errored_delegate.broadcast(qs.executor, None, True, "GPU device removed")
        self.fake._mrq_step = failing
        res = self.run_job(self.job())
        self.assertEqual((res["ok"], res["error"], self.exits), (False, "render_failed", [1]))
        self.assertIn("GPU device removed", res["message"])
        self.fake._mrq_step = orig
        self.exits.clear()
        res = self.run_job(self.job(interactive=True), ticks=40)
        self.assertTrue(res["ok"])
        self.assertEqual(self.exits, [], "an interactive run never closes the editor")


if __name__ == "__main__":
    unittest.main()
