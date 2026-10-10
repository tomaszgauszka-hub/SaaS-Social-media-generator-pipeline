"""Unit tests of the StudioJob validator (python3 -m unittest discover tools/blender/studio)."""

from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest

import jobspec


def valid_job(model_path: str = "/models/lamp.glb") -> dict:
    return {
        "version": "studio-job/1",
        "jobKey": "abc",
        "product": {
            "modelPath": model_path,
            "modelSha": "f" * 64,
            "format": "glb",
            "realHeightM": 0.55,
            "emitsLight": True,
            "emissiveHints": ["shade", "bulb"],
        },
        "environment": "warm_living",
        "profile": "FAST",
        "output": {"dir": "/tmp/out", "width": 1080, "height": 1920},
        "camera": {"lensMm": 65, "dof": {"enabled": True, "fStop": 4}, "motionBlur": False},
        "shots": [
            {
                "id": "sh01",
                "preset": "hero_reveal",
                "technique": "plate",
                "durationMs": 2500,
                "params": {"intensity": 0.6, "angleDeg": -25, "height": 0.55, "focus": "whole", "fill": 0.62,
                           "sweepDeg": 40},
                "productAnimation": "none",
                "lighting": "three_point",
                "renderFps": 15,
                "overscan": 1.18,
            }
        ],
        "seed": 1234,
    }


class ValidateTest(unittest.TestCase):
    def test_valid_job_round_trips(self):
        job = jobspec.validate_job(valid_job())
        self.assertEqual(job["shots"][0]["params"]["fill"], 0.62)
        self.assertEqual(job["product"]["emissiveHints"], ["shade", "bulb"])
        self.assertEqual(job["output"]["width"], 1080)
        self.assertIsInstance(job["seed"], int)

    def test_defaults_mirror_zod(self):
        raw = valid_job()
        raw["shots"][0]["params"] = {}
        del raw["product"]["emissiveHints"]
        del raw["product"]["realHeightM"]
        job = jobspec.validate_job(raw)
        self.assertEqual(
            job["shots"][0]["params"],
            {"intensity": 0.5, "angleDeg": -25.0, "height": 0.55, "focus": "whole", "fill": 0.62, "sweepDeg": 40.0},
        )
        self.assertEqual(job["product"]["emissiveHints"], [])
        self.assertNotIn("realHeightM", job["product"])
        self.assertNotIn("travelX", job["shots"][0])

    def test_plate_travel_is_optional_and_bounded(self):
        raw = valid_job()
        raw["shots"][0]["travelX"] = 0.06
        self.assertEqual(jobspec.validate_job(raw)["shots"][0]["travelX"], 0.06)
        self.bad(lambda j: j["shots"][0].update(travelX=0.8), "<= 0.5")
        self.bad(lambda j: j["shots"][0].update(travelX=-0.1), ">= 0")

    def test_center_y_is_optional_and_bounded(self):
        raw = valid_job()
        self.assertNotIn("centerY", jobspec.validate_job(raw)["shots"][0]["params"])
        raw["shots"][0]["params"]["centerY"] = 0.565
        self.assertEqual(jobspec.validate_job(raw)["shots"][0]["params"]["centerY"], 0.565)
        self.bad(lambda j: j["shots"][0]["params"].update(centerY=0.9), "<= 0.7")

    def bad(self, mutate, fragment: str):
        raw = valid_job()
        mutate(raw)
        with self.assertRaises(jobspec.JobError) as cm:
            jobspec.validate_job(raw)
        self.assertIn(fragment, str(cm.exception))

    def test_unknown_keys_are_rejected_everywhere(self):
        self.bad(lambda j: j.update(script="import os"), "unknown key")
        self.bad(lambda j: j["product"].update(command="rm -rf /"), "unknown key")
        self.bad(lambda j: j["camera"]["dof"].update(blades=6), "unknown key")
        self.bad(lambda j: j["shots"][0].update(expression="frame*2"), "unknown key")
        self.bad(lambda j: j["shots"][0]["params"].update(speed=3), "unknown key")

    def test_ids_must_be_whitelisted(self):
        self.bad(lambda j: j.update(environment="mars_base"), "job.environment")
        self.bad(lambda j: j.update(profile="ULTRA"), "job.profile")
        self.bad(lambda j: j["product"].update(format="exe"), "job.product.format")
        self.bad(lambda j: j["shots"][0].update(preset="warp"), "preset")
        self.bad(lambda j: j["shots"][0].update(technique="veo"), "technique")
        self.bad(lambda j: j["shots"][0].update(lighting="laser"), "lighting")
        self.bad(lambda j: j["shots"][0].update(productAnimation="melt"), "productAnimation")
        self.bad(lambda j: j["shots"][0]["params"].update(focus="logo"), "focus")
        self.bad(lambda j: j["shots"][0].update(id="shot1"), "sh + two digits")
        self.bad(lambda j: j.update(version="studio-job/2"), "job.version")

    def test_numbers_are_bounded(self):
        self.bad(lambda j: j["output"].update(width=100), ">= 270")
        self.bad(lambda j: j["output"].update(height=4000), "<= 3840")
        self.bad(lambda j: j["output"].update(width=1080.5), "integer")
        self.bad(lambda j: j["camera"].update(lensMm=10), ">= 18")
        self.bad(lambda j: j["camera"]["dof"].update(fStop=40), "<= 22")
        self.bad(lambda j: j["shots"][0].update(durationMs=20_000), "<= 10000")
        self.bad(lambda j: j["shots"][0].update(renderFps=120), "<= 60")
        self.bad(lambda j: j["shots"][0].update(overscan=2), "<= 1.6")
        self.bad(lambda j: j["shots"][0]["params"].update(fill=9), "<= 2.5")
        self.bad(lambda j: j["shots"][0]["params"].update(intensity=True), "finite number")
        self.bad(lambda j: j["product"].update(realHeightM=0), "positive")
        self.bad(lambda j: j.update(seed=-1), ">= 0")

    def test_types_are_strict(self):
        self.bad(lambda j: j["product"].update(emitsLight=1), "boolean")
        self.bad(lambda j: j["product"].update(emissiveHints=["x" * 41]), "longer than 40")
        self.bad(lambda j: j["product"].update(emissiveHints=["a"] * 13), "at most 12")
        self.bad(lambda j: j["product"].update(modelPath="a\x00b"), "NUL")
        self.bad(lambda j: j.update(shots=[]), "1 to 8 shots")
        self.bad(lambda j: j.update(shots=j["shots"] * 9), "1 to 8 shots")
        self.bad(lambda j: j.update(shots=j["shots"] * 2), "unique")
        self.bad(lambda j: j.update(camera=[]), "expected an object")

    def test_validation_does_not_mutate_the_input(self):
        raw = valid_job()
        raw["shots"][0]["params"] = {}
        before = copy.deepcopy(raw)
        jobspec.validate_job(raw)
        self.assertEqual(raw, before)


class LoadTest(unittest.TestCase):
    def test_load_checks_the_model_file_and_rejects_nan(self):
        with tempfile.TemporaryDirectory() as d:
            model = os.path.join(d, "m.glb")
            with open(model, "wb") as fh:
                fh.write(b"glTF")
            path = os.path.join(d, "job.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(valid_job(model), fh)
            self.assertEqual(jobspec.load_job(path)["product"]["modelPath"], model)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(valid_job(os.path.join(d, "missing.glb")), fh)
            with self.assertRaises(jobspec.JobError):
                jobspec.load_job(path)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(valid_job(model)).replace('"seed": 1234', '"seed": NaN'))
            with self.assertRaises(jobspec.JobError):
                jobspec.load_job(path)

    def test_profiles_cover_both_blender_profiles(self):
        profiles = jobspec.load_profiles()
        self.assertEqual(set(profiles), {"FAST", "QUALITY"})
        for p in profiles.values():
            self.assertTrue({"samples", "sequenceFps", "overscan", "scale", "plateScale"} <= set(p))


if __name__ == "__main__":
    unittest.main()
