"""Unit tests that need Blender's bpy module: product import (emission, .blend objects) and shot planning.

    .tools/blender-venv/bin/python -m unittest discover tools/blender/studio

Plain python3 skips them (no bpy). Models are built in-process, tiny, and nothing is rendered.
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest

HAVE_BPY = importlib.util.find_spec("bpy") is not None
bpy = framing = jobspec = product_import = shotlib = studio_main = None


def setUpModule():
    # imported only when these tests run: test_shotlib checks the pure modules never pull bpy in
    global bpy, framing, jobspec, product_import, shotlib, studio_main
    if not HAVE_BPY:
        return
    import bpy
    import framing
    import jobspec
    import product_import
    import shotlib
    import studio_main


HINTS = ["shade", "bulb", "diffuser", "lampshade", "led", "emissive", "glow"]


def _material(name: str, base, *, transmission=0.0, alpha=1.0, emission=None, strength=0.0, blended=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    n = m.node_tree.nodes["Principled BSDF"]
    n.inputs["Base Color"].default_value = (*base, 1.0)
    n.inputs["Transmission Weight"].default_value = transmission
    n.inputs["Alpha"].default_value = alpha
    if emission is not None:
        n.inputs["Emission Color"].default_value = (*emission, 1.0)
    n.inputs["Emission Strength"].default_value = strength
    if blended:
        m.surface_render_method = "BLENDED"
    return m


def _lamp(path: str, shade) -> None:
    """A wooden base + a cone shade, exported as glb / obj."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.08, depth=0.3, location=(0, 0, 0.15))
    bpy.context.object.name = "Base"
    bpy.context.object.data.materials.append(_material("Base_Wood", (0.4, 0.25, 0.1)))
    bpy.ops.mesh.primitive_cone_add(radius1=0.2, radius2=0.12, depth=0.2, location=(0, 0, 0.4))
    bpy.context.object.name = "Shade"
    bpy.context.object.data.materials.append(shade())
    if path.endswith(".obj"):
        bpy.ops.wm.obj_export(filepath=path)
    else:
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")


def _import(path: str, emits: bool = True, hints=HINTS) -> "product_import.ProductModel":
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return product_import.import_product(path, path.rsplit(".", 1)[1], None, emits, hints)


@unittest.skipUnless(HAVE_BPY, "needs bpy (.tools/blender-venv/bin/python)")
class EmissionTest(unittest.TestCase):
    """A light-emitting product never changes colour: only authored emission or a translucent shade glows."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.models = {}
        shades = {
            "black_metal": lambda: _material("Black_Metal_Shade", (0.02, 0.02, 0.02)),
            "fabric": lambda: _material("Fabric_Shade", (0.9, 0.85, 0.8), transmission=0.6),
            "glass": lambda: _material("Glass_Shade", (0.9, 0.9, 0.9), alpha=0.5, blended=True),
            "authored": lambda: _material("Glow_Shade", (0.9, 0.9, 0.9), emission=(1.0, 0.8, 0.5), strength=2.0),
        }
        for name, shade in shades.items():
            for ext in ("glb", "obj"):
                path = os.path.join(cls.tmp.name, f"{name}.{ext}")
                _lamp(path, shade)
                cls.models[f"{name}.{ext}"] = path

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def shade_node(self):
        mat = next(m for m in bpy.data.materials if "Shade" in m.name)
        return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

    def test_an_opaque_shade_without_emission_never_glows(self):
        for f in ("black_metal.glb", "black_metal.obj"):
            model = _import(self.models[f])
            before = tuple(self.shade_node().inputs["Emission Color"].default_value)
            self.assertEqual(model.emissive, [], f)
            self.assertEqual(model.emissive_mode, "none", f)
            product_import.set_product_light_level(model, 1.0)
            self.assertEqual(tuple(self.shade_node().inputs["Emission Color"].default_value), before, f)

    def test_a_translucent_shade_glows_warm_and_is_dark_while_off(self):
        for f in ("fabric.glb", "glass.glb", "glass.obj"):
            model = _import(self.models[f])
            self.assertEqual(model.emissive_mode, "name_hint", f)
            self.assertEqual(len(model.emissive), 1, f)
            t = model.emissive[0]
            self.assertEqual((t.off, t.on), (0.0, 1.2), f)
            col = self.shade_node().inputs["Emission Color"].default_value
            self.assertEqual(tuple(round(c, 3) for c in col), product_import.WARM_GLOW, f)

    def test_authored_emission_keeps_its_colour(self):
        for f in ("authored.glb", "authored.obj"):
            model = _import(self.models[f])
            self.assertEqual(model.emissive_mode, "name_hint", f)
            self.assertEqual((model.emissive[0].off, model.emissive[0].on), (2.0, 2.0), f)
            col = self.shade_node().inputs["Emission Color"].default_value
            self.assertEqual(tuple(round(c, 3) for c in col[:3]), (1.0, 0.8, 0.5), f)

    def test_nothing_glows_when_the_product_emits_no_light(self):
        model = _import(self.models["fabric.glb"], emits=False)
        self.assertEqual((model.emissive, model.bulb), ([], None))


@unittest.skipUnless(HAVE_BPY, "needs bpy (.tools/blender-venv/bin/python)")
class BlendImportTest(unittest.TestCase):
    def test_curves_and_text_are_part_of_the_product(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "lamp.blend")
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.mesh.primitive_cube_add(size=0.2, location=(0, 0, 0.1))
            bpy.ops.curve.primitive_bezier_curve_add(radius=0.1, location=(0, 0, 0.5))
            bpy.context.object.name = "Cable"
            bpy.context.object.data.bevel_depth = 0.01
            bpy.ops.curve.primitive_bezier_circle_add(radius=0.3, location=(3, 0, 3))
            bpy.context.object.name = "BevelProfile"  # no faces: renders nothing, must not widen the bounds
            bpy.ops.object.text_add(radius=0.05, location=(0, -0.11, 0.05))
            bpy.context.object.name = "Logo"
            bpy.ops.object.camera_add(location=(0, -3, 1))
            bpy.ops.wm.save_as_mainfile(filepath=path)
            model = _import(path, emits=False)
            scene = {o.name for o in bpy.context.scene.objects}
            self.assertTrue({"Cube", "Cable", "Logo", "BevelProfile"} <= scene)
            self.assertFalse(any(o.type == "CAMERA" for o in bpy.context.scene.objects))
            self.assertEqual(sorted(o.name for o in model.meshes), ["Cable", "Cube", "Logo"])
            self.assertAlmostEqual(model.height, 0.51, places=3)  # the cable (z 0.5 + bevel) tops the cube
            self.assertLess(model.radius, 1.0)


def _job(model_path: str, emits: bool, shots: list[dict]) -> dict:
    return jobspec.validate_job({
        "version": jobspec.STUDIO_JOB_VERSION,
        "jobKey": "k",
        "product": {"modelPath": model_path, "modelSha": "a" * 64, "format": "glb", "emitsLight": emits,
                    "emissiveHints": HINTS},
        "environment": "warm_living",
        "profile": "FAST",
        "output": {"dir": "/tmp/unused", "width": 1080, "height": 1920},
        "camera": {"lensMm": 65, "dof": {"enabled": False, "fStop": 4}, "motionBlur": False},
        "shots": shots,
        "seed": 1,
    })


def _spec(preset: str, technique: str, **over) -> dict:
    return {"id": "sh01", "preset": preset, "technique": technique, "durationMs": 2000,
            "params": {"intensity": 1.0, "angleDeg": -30}, "productAnimation": "none",
            "lighting": "three_point", "renderFps": 8, "overscan": 1.18, **over}


@unittest.skipUnless(HAVE_BPY, "needs bpy (.tools/blender-venv/bin/python)")
class PlanShotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.bench = os.path.join(cls.tmp.name, "bench.glb")  # wide: its width sets the framing
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.4))
        bpy.context.object.scale = (2.0, 0.9, 0.8)
        bpy.ops.export_scene.gltf(filepath=cls.bench, export_format="GLB")
        cls.cfg = jobspec.load_profiles()["FAST"]

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def plan(self, spec: dict, emits: bool = False):
        job = _job(self.bench, emits, [spec])
        model = _import(self.bench, emits=emits)
        return studio_main.plan_shot(model, job, job["shots"][0], self.cfg, None), model

    def test_a_relight_without_a_light_of_its_own_is_one_plate_at_full_light(self):
        plan, _ = self.plan(_spec("silhouette_reveal", "relight", productAnimation="light_on",
                                  lighting="rim_dramatic"))
        self.assertEqual(plan.technique, "plate")
        self.assertEqual(plan.files, [studio_main.PLATE_NAME])
        self.assertEqual(len(plan.poses), 1)
        self.assertGreaterEqual(plan.poses[0].state.key, 1.0)
        lit, model = self.plan(_spec("silhouette_reveal", "relight", productAnimation="light_on"), emits=True)
        self.assertTrue(studio_main.has_own_light(model, _job(self.bench, True, [_spec("hero_reveal", "plate")])))
        self.assertEqual((lit.technique, lit.files), ("relight", list(studio_main.RELIGHT_NAMES)))

    def test_a_plate_slide_keeps_the_wide_product_inside_the_window(self):
        travel = 0.075  # camera_slide at intensity 1 (moves.ts windowTravelX)
        free, _ = self.plan(_spec("camera_slide", "plate"))
        self.assertAlmostEqual(free.fit.box[2] - free.fit.box[0], studio_main.MAX_WIDTH, places=3)
        plan, _ = self.plan(_spec("camera_slide", "plate", travelX=travel))
        u0, _, u1, _ = plan.fit.box
        # the window moves ±travel frame widths: the product keeps the usual margin at both ends
        margin = (1 - studio_main.MAX_WIDTH) / 2
        self.assertGreaterEqual(u0 - travel, margin - 1e-3)
        self.assertLessEqual(u1 + travel, 1 - margin + 1e-3)

    def test_a_sequence_truck_keeps_the_wide_product_in_frame(self):
        plan, model = self.plan(_spec("camera_slide", "sequence"))
        lens = framing.Lens(65, plan.width, plan.height, plan.fit.shift_x, plan.fit.shift_y)
        pts = studio_main._subsample(model.points, 400)
        for pose in plan.poses:
            posed = [framing.add(framing.rotate_z(p, pose.prod_rot), (0.0, 0.0, pose.lift)) for p in pts]
            u0, _, u1, _ = framing.project_box(posed, pose.cam, pose.basis, lens)
            self.assertGreater(u0, 0.0)
            self.assertLess(u1, 1.0)
        self.assertGreater(max(abs(p.state.cam_truck) for p in plan.poses), 0.1)
        self.assertEqual(shotlib.resolve_preset("camera_slide", 1), ("camera_slide", None))


if __name__ == "__main__":
    unittest.main()
