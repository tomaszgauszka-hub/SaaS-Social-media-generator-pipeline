"""Unit tests of the scene job validation and timing curves (no bpy): python3 -m unittest test_scene_spec"""

import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import scene_spec as s  # noqa: E402

OUT = os.path.abspath(os.sep + os.path.join("tmp", "scene-out"))


def job(**over):
    j = {
        "version": 1,
        "jobId": "t1",
        "template": "PRODUCT_HERO",
        "durationSec": 2,
        "fps": 30,
        "resolution": [1080, 1920],
        "camera": {"preset": "orbit_closeup", "movement": "slow"},
        "lighting": {"preset": "premium_studio"},
        "background": {"preset": "dark_gradient"},
        "product": {"source": "procedural", "generator": "drill_driver_20v", "fidelity": "FICTIONAL_DEMO"},
        "output": {"dir": OUT},
    }
    j.update(over)
    return j


class ValidateTest(unittest.TestCase):
    def test_minimal_job_is_normalised(self):
        v = s.validate(job())
        self.assertEqual(v["quality"], "preview")
        self.assertEqual(v["renderer"], "CYCLES")
        self.assertEqual(v["framing"], {"centerY": 0.5, "fill": None})
        self.assertTrue(v["product"]["structureVerified"])
        self.assertEqual(v["outputs"]["export"], [])

    def test_closed_sets_only(self):
        for key, bad in (("template", "CUSTOM"), ("fps", 29), ("quality", "ultra"), ("renderer", "OCTANE")):
            with self.assertRaises(s.SceneJobError, msg=key):
                s.validate(job(**{key: bad}))
        with self.assertRaises(s.SceneJobError):
            s.validate(job(camera={"preset": "drone"}))
        with self.assertRaises(s.SceneJobError):
            s.validate(job(lighting={"preset": "__import__('os')"}))

    def test_paths_must_be_absolute(self):
        with self.assertRaises(s.SceneJobError):
            s.validate(job(output={"dir": "relative/out"}))
        with self.assertRaises(s.SceneJobError):
            s.validate(job(product={"source": "file", "path": "model.glb", "format": "glb",
                                    "fidelity": "TECHNICAL_RECONSTRUCTION"}))

    def test_job_id_cannot_traverse(self):
        with self.assertRaises(s.SceneJobError):
            s.validate(job(jobId="../../etc"))

    def test_procedural_products_are_fictional_demos(self):
        with self.assertRaises(s.SceneJobError):
            s.validate(job(product={"source": "procedural", "generator": "drill_driver_20v",
                                    "fidelity": "VERIFIED_MANUFACTURER"}))

    def test_params_are_numbers_colours_or_names(self):
        ok = s.validate(job(product={"source": "procedural", "generator": "drill_driver_20v",
                                     "fidelity": "FICTIONAL_DEMO", "params": {"body_color": "#112233", "scale": 1.0}}))
        self.assertEqual(ok["product"]["params"]["body_color"], "#112233")
        with self.assertRaises(s.SceneJobError):
            s.validate(job(product={"source": "procedural", "generator": "drill_driver_20v",
                                    "fidelity": "FICTIONAL_DEMO", "params": {"x": "rm -rf /"}}))

    def test_structural_templates_need_a_verified_structure(self):
        imported = {"source": "file", "path": OUT + "/m.glb", "format": "glb", "fidelity": "TECHNICAL_RECONSTRUCTION"}
        for tpl in s.STRUCTURAL_TEMPLATES:
            with self.assertRaises(s.SceneJobError, msg=tpl):
                s.validate(job(template=tpl, product=imported))
            ok = dict(imported, structureVerified=True)
            self.assertEqual(s.validate(job(template=tpl, product=ok))["template"], tpl)
        approx = dict(imported, structureVerified=True, fidelity="APPROXIMATE_VISUALIZATION")
        with self.assertRaises(s.SceneJobError):
            s.validate(job(template="EXPLODED_VIEW", product=approx))

    def test_lifestyle_needs_an_environment(self):
        with self.assertRaises(s.SceneJobError):
            s.validate(job(template="LIFESTYLE"))
        v = s.validate(job(template="LIFESTYLE", environment={"preset": "workshop"}))
        self.assertEqual(v["environment"]["preset"], "workshop")

    def test_actions_inside_the_clip(self):
        v = s.validate(job(actions=[{"kind": "LED_ON", "startSec": 0.5, "endSec": 1.0}]))
        self.assertEqual(v["actions"][0].kind, "LED_ON")
        with self.assertRaises(s.SceneJobError):
            s.validate(job(actions=[{"kind": "LED_ON", "startSec": 0.5, "endSec": 3.0}]))
        with self.assertRaises(s.SceneJobError):
            s.validate(job(actions=[{"kind": "SELF_DESTRUCT", "startSec": 0, "endSec": 1}]))

    def test_transparent_background_forces_alpha(self):
        self.assertTrue(s.validate(job(background={"preset": "transparent"}))["outputs"]["alpha"])

    def test_does_not_mutate_input(self):
        j = job()
        before = copy.deepcopy(j)
        s.validate(j)
        self.assertEqual(j, before)


class CurvesTest(unittest.TestCase):
    def test_frame_count_and_size(self):
        self.assertEqual(s.frame_count(4, 30), 120)
        self.assertEqual(s.frame_count(0.5, 24), 12)
        self.assertEqual(s.render_size({"quality": "preview", "resolution": [1080, 1920]}), (540, 960))
        self.assertEqual(s.render_size({"quality": "production", "resolution": [1080, 1920]}), (1080, 1920))
        self.assertEqual(s.render_fps({"quality": "preview", "fps": 30}), 15)
        self.assertEqual(s.render_fps({"quality": "production", "fps": 30}), 30)

    def test_explode_goes_out_and_back(self):
        self.assertEqual(s.explode_progress(0.0), 0.0)
        self.assertEqual(s.explode_progress(0.55), 1.0)
        self.assertEqual(s.explode_progress(1.0), 0.0)
        xs = [s.explode_progress(t / 100) for t in range(0, 46)]
        self.assertEqual(xs, sorted(xs))

    def test_assembly_parts_arrive_in_order(self):
        arrive = []
        for order in range(1, 5):
            t = next(t / 200 for t in range(201) if s.assembly_progress(t / 200, order, 5) >= 1.0)
            arrive.append(t)
        self.assertEqual(arrive, sorted(arrive))
        self.assertEqual(s.assembly_progress(0.0, 0, 5), 1.0)  # the base part is in place from the start

    def test_action_progress(self):
        a = s.ActionSpec("LED_ON", 1.0, 2.0)
        self.assertEqual(s.action_progress(a, 0.5), 0.0)
        self.assertEqual(s.action_progress(a, 2.5), 1.0)
        self.assertAlmostEqual(s.action_progress(a, 1.5), 0.5)


if __name__ == "__main__":
    unittest.main()
