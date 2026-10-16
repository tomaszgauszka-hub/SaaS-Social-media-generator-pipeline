"""Smoke test of every scene template with real Blender (tiny frames, few samples).

    <python-with-bpy> -m unittest test_scenes_bpy          (from tools/blender/scenes)
    SCENES_BLENDER_PYTHON=/path/to/python python3 -m unittest test_scenes_bpy

Each template renders in its own process (run.py), exactly as the worker runs it; the test checks exit code,
result.json, frame count, per-frame product boxes and the declared part structure.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.environ.get("SCENES_BLENDER_PYTHON", sys.executable)


def has_bpy() -> bool:
    try:
        return subprocess.run([PY, "-c", "import bpy"], capture_output=True, timeout=120).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


CASES = [
    ("PRODUCT_HERO", "drill_driver_20v", {"camera": {"preset": "orbit_closeup"}, "background": {"preset": "dark_gradient"}}),
    ("TURNTABLE_360", "cosmetic_tube", {"camera": {"preset": "turntable", "movement": "static"},
                                        "background": {"preset": "light_gradient"}}),
    ("MACRO_DETAIL", "drill_driver_20v", {"camera": {"preset": "macro_slide"}, "focus": "chuck",
                                          "background": {"preset": "dark_gradient"}}),
    ("EXPLODED_VIEW", "drill_driver_20v", {"camera": {"preset": "orbit_wide"}, "background": {"preset": "light_gradient"}}),
    ("PRODUCT_ASSEMBLY", "cosmetic_tube", {"camera": {"preset": "orbit_wide"}, "background": {"preset": "seamless_white"}}),
    ("LIFESTYLE", "cosmetic_tube", {"camera": {"preset": "push_in"}, "background": {"preset": "environment"},
                                    "environment": {"preset": "bathroom"}}),
    ("TECHNICAL", "drill_driver_20v", {"camera": {"preset": "dolly_side"}, "background": {"preset": "dark_gradient"},
                                       "lighting": {"preset": "cool_tech"}}),
    ("BRAND_ENVIRONMENT", "cosmetic_tube", {"camera": {"preset": "hero_low"}, "background": {"preset": "brand_color",
                                                                                         "color": "#203040"}}),
]


@unittest.skipUnless(has_bpy(), "no Python with bpy (set SCENES_BLENDER_PYTHON)")
class TemplatesTest(unittest.TestCase):
    def run_job(self, template, generator, extra, outputs=None):
        out = tempfile.mkdtemp(prefix=f"scene-{template.lower()}-")
        j = {
            "version": 1, "jobId": f"t-{template.lower()}", "template": template, "quality": "preview",
            "durationSec": 0.5, "fps": 24, "resolution": [256, 456], "samples": 4, "device": "CPU",
            "lighting": {"preset": "premium_studio"},
            "product": {"source": "procedural", "generator": generator, "fidelity": "FICTIONAL_DEMO"},
            "output": {"dir": out}, "outputs": outputs or {},
        }
        j.update(extra)
        path = os.path.join(out, "job.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(j, fh)
        p = subprocess.run([PY, "-B", os.path.join(HERE, "run.py"), path], capture_output=True, text=True, timeout=900)
        self.assertEqual(p.returncode, 0, p.stderr[-2000:])
        with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
            return out, json.load(fh)

    def test_every_template_renders(self):
        for template, generator, extra in CASES:
            with self.subTest(template=template):
                out, r = self.run_job(template, generator, extra)
                # preview: 15 fps rendered (0.5 s → 8 frames), interpolated to 24 fps by the encoder
                self.assertEqual(r["frames"]["count"], 8)
                self.assertEqual(r["frames"]["targetFps"], 24)
                self.assertEqual(len(os.listdir(os.path.join(out, "frames"))), 8)
                self.assertEqual(len(r["productBoxes"]), 8)
                self.assertEqual((r["frames"]["width"], r["frames"]["height"]), (128, 228))
                for b in r["productBoxes"]:
                    self.assertLess(b[0], b[2])
                    self.assertLess(b[1], b[3])
                self.assertTrue(all(p["verified"] for p in r["product"]["parts"]))
                self.assertRegex(r["product"]["geometryHash"], r"^[0-9a-f]{64}$")

    def test_technical_runs_the_drill_mechanism(self):
        _, r = self.run_job("TECHNICAL", "drill_driver_20v", CASES[6][2])
        kinds = {a["kind"] for a in r["actions"]}
        self.assertTrue({"TRIGGER_PRESS", "LED_ON", "CHUCK_SPIN"} <= kinds)

    def test_unsupported_action_is_an_invalid_job(self):
        out = tempfile.mkdtemp(prefix="scene-badaction-")
        j = {"version": 1, "jobId": "bad", "template": "PRODUCT_HERO", "durationSec": 0.5, "fps": 24,
             "resolution": [256, 456], "samples": 2, "camera": {"preset": "orbit_closeup"},
             "lighting": {"preset": "premium_studio"}, "background": {"preset": "dark_gradient"},
             "actions": [{"kind": "TRIGGER_PRESS", "startSec": 0, "endSec": 0.2}],
             "product": {"source": "procedural", "generator": "cosmetic_tube", "fidelity": "FICTIONAL_DEMO"},
             "output": {"dir": out}}
        path = os.path.join(out, "job.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(j, fh)
        p = subprocess.run([PY, "-B", os.path.join(HERE, "run.py"), path], capture_output=True, text=True, timeout=600)
        self.assertEqual(p.returncode, 3, p.stderr[-1000:])

    def test_exports_for_unreal(self):
        _, r = self.run_job("PRODUCT_HERO", "drill_driver_20v", CASES[0][2],
                            outputs={"export": ["fbx", "glb"], "controlViews": True})
        self.assertTrue(os.path.isfile(r["exports"]["files"]["fbx"]))
        self.assertTrue(os.path.isfile(r["exports"]["files"]["glb"]))
        dims = sorted(r["exports"]["dimensionsM"])
        self.assertAlmostEqual(dims[-1], 0.2685, delta=0.003)  # assembled, real orientation, metres
        self.assertEqual(len(r["controlViews"]), 6)
        statuses = {m["status"] for m in r["materialReport"]["materials"]}
        self.assertTrue(statuses <= {"PBR_DIRECT", "NEEDS_BAKE", "APPROXIMATED", "UNSUPPORTED"})


if __name__ == "__main__":
    unittest.main()
