"""Unit tests of the shot library keyframe math (pure python — python3 -m unittest discover tools/blender/studio)."""

from __future__ import annotations

import dataclasses
import math
import random
import sys
import unittest

import shotlib

NUMERIC = [f.name for f in dataclasses.fields(shotlib.ShotState) if f.type in ("float", float)]


def random_params(rng: random.Random) -> dict:
    return {
        "intensity": rng.uniform(0, 1),
        "angleDeg": rng.uniform(-180, 180),
        "height": rng.uniform(-0.2, 1.6),
        "focus": rng.choice(shotlib.FOCI),
        "fill": rng.uniform(0.25, 2.5),
        "sweepDeg": rng.uniform(0, 360),
    }


class PresetTableTest(unittest.TestCase):
    def test_all_21_presets_in_contract_order(self):
        self.assertEqual(len(shotlib.SHOT_PRESETS), 21)
        self.assertEqual(tuple(shotlib.PRESETS), shotlib.SHOT_PRESETS)

    def test_the_bpy_free_module_never_imports_bpy(self):
        self.assertNotIn("bpy", sys.modules)
        self.assertGreaterEqual(len(NUMERIC), 15)  # the channel list the continuity test walks

    def test_product_is_only_ever_moved_rigidly(self):
        names = {f.name for f in dataclasses.fields(shotlib.ShotState)}
        self.assertFalse({n for n in names if "scale" in n or "deform" in n or "squash" in n})

    def test_multi_part_presets_degrade_on_a_single_mesh(self):
        for preset in ("exploded_view", "parts_reveal", "assembly", "technical_cutaway"):
            rendered, fallback = shotlib.resolve_preset(preset, 1)
            self.assertEqual(rendered, fallback)
            self.assertFalse(shotlib.PRESETS[rendered].multi_part)
            self.assertEqual(shotlib.resolve_preset(preset, 3), (preset, None))
        self.assertEqual(shotlib.resolve_preset("turntable", 1), ("turntable", None))
        with self.assertRaises(ValueError):
            shotlib.resolve_preset("warp_drive", 1)


class EvaluateTest(unittest.TestCase):
    def test_every_preset_is_finite_bounded_and_deterministic(self):
        rng = random.Random(7)
        for preset in shotlib.SHOT_PRESETS:
            for parts in (1, 4):
                rendered, _ = shotlib.resolve_preset(preset, parts)
                for _ in range(12):
                    params = random_params(rng)
                    anim = rng.choice(shotlib.PRODUCT_ANIMATIONS)
                    for t in (0.0, 0.13, 0.5, 0.77, 1.0):
                        a, _ = shotlib.evaluate(rendered, t, params, anim, part_count=parts, emits_light=True)
                        b, _ = shotlib.evaluate(rendered, t, params, anim, part_count=parts, emits_light=True)
                        self.assertEqual(a, b)
                        for name in NUMERIC:
                            self.assertTrue(math.isfinite(getattr(a, name)), (preset, name))
                        self.assertGreater(a.cam_dolly, 0.5)
                        self.assertLess(a.cam_dolly, 1.6)
                        self.assertLessEqual(abs(a.cam_truck), 0.2)
                        self.assertTrue(0 <= a.product_light <= 1)
                        self.assertTrue(0 <= a.explode <= 1)
                        for level in (a.key, a.fill, a.rim, a.accent):
                            self.assertTrue(0 <= level <= 1.5)
                        self.assertTrue(a.sweep is None or -1 <= a.sweep <= 1)
                        self.assertGreaterEqual(a.prod_lift, 0)
                        self.assertLess(a.prod_lift, 0.6)

    def test_moves_are_continuous(self):
        """No keyframe jumps: a 1/1000 step changes every channel by a small amount."""
        params = {"intensity": 1.0, "sweepDeg": 360.0}
        for preset in shotlib.SHOT_PRESETS:
            prev = None
            for k in range(1001):
                s, _ = shotlib.evaluate(preset, k / 1000, params, "none", part_count=3, emits_light=True)
                if prev is not None:
                    for name in NUMERIC:
                        step = abs(getattr(s, name) - getattr(prev, name))
                        limit = 3.0 if name in ("cam_az", "prod_rot", "spin_part") else 0.05
                        self.assertLess(step, limit, (preset, name, k))
                prev = s

    def test_turntable_sweeps_exactly_the_requested_angle(self):
        for sweep in (0.0, 40.0, 90.0, 360.0):
            s0, _ = shotlib.evaluate("turntable", 0.0, {"sweepDeg": sweep})
            s1, _ = shotlib.evaluate("turntable", 1.0, {"sweepDeg": sweep})
            self.assertAlmostEqual(s1.prod_rot - s0.prod_rot, sweep)
            mid, _ = shotlib.evaluate("turntable", 0.5, {"sweepDeg": sweep})
            self.assertAlmostEqual(mid.prod_rot, 0.0)  # the hero angle is at mid-shot
        slow0, _ = shotlib.evaluate("slow_turntable", 0.0, {"sweepDeg": 40})
        slow1, _ = shotlib.evaluate("slow_turntable", 1.0, {"sweepDeg": 40})
        self.assertAlmostEqual(slow1.prod_rot - slow0.prod_rot, 20.0)

    def test_macro_push_and_pull_end_and_start_on_the_composed_framing(self):
        for i in (0.0, 0.5, 1.0):
            p = {"intensity": i}
            dolly = [shotlib.evaluate("macro_push", k / 20, p)[0].cam_dolly for k in range(21)]
            self.assertTrue(all(a >= b for a, b in zip(dolly, dolly[1:])))
            self.assertAlmostEqual(dolly[-1], 1.0)
            self.assertAlmostEqual(dolly[0], 1.12 + 0.3 * i)
            pull = [shotlib.evaluate("macro_pull", k / 20, p)[0].cam_dolly for k in range(21)]
            self.assertAlmostEqual(pull[0], 1.0)
            self.assertTrue(all(a <= b for a, b in zip(pull, pull[1:])))

    def test_camera_slide_is_symmetric_and_follows_the_angle(self):
        left, _ = shotlib.evaluate("camera_slide", 0.0, {"angleDeg": -25, "intensity": 1})
        right, _ = shotlib.evaluate("camera_slide", 1.0, {"angleDeg": -25, "intensity": 1})
        self.assertAlmostEqual(left.cam_truck, -right.cam_truck)
        self.assertLess(left.cam_truck, 0)
        flipped, _ = shotlib.evaluate("camera_slide", 0.0, {"angleDeg": 25, "intensity": 1})
        self.assertGreater(flipped.cam_truck, 0)
        self.assertAlmostEqual(shotlib.evaluate("camera_slide", 0.5, {})[0].cam_truck, 0.0)

    def test_impact_punches_in_then_settles(self):
        d = [shotlib.evaluate("impact", k / 100, {"intensity": 1})[0].cam_dolly for k in range(101)]
        self.assertAlmostEqual(d[0], 1.4)
        self.assertLess(min(d[:30]), 1.0)  # ease-out-back overshoot past the composed framing
        self.assertTrue(all(a >= b - 1e-12 for a, b in zip(d[30:], d[31:])))

    def test_product_drop_lands_and_rests(self):
        lifts = [shotlib.evaluate("product_drop", k / 100, {})[0].prod_lift for k in range(101)]
        self.assertAlmostEqual(lifts[0], 0.55)
        self.assertEqual(lifts[50:], [0.0] * 51)
        self.assertGreater(max(lifts[36:50]), 0)  # one small rebound after the first contact

    def test_light_on_switches_once_between_30_and_42_percent(self):
        levels = [
            shotlib.evaluate("hero_reveal", k / 100, {}, "light_on", emits_light=True)[0].product_light
            for k in range(101)
        ]
        self.assertEqual(levels[:31], [0.0] * 31)
        self.assertEqual(levels[42:], [1.0] * 59)
        self.assertTrue(all(a <= b for a, b in zip(levels, levels[1:])))

    def test_light_on_needs_a_light_emitting_product(self):
        s, notes = shotlib.evaluate("hero_reveal", 1.0, {}, "light_on", emits_light=False)
        self.assertEqual(s.product_light, 0.0)
        self.assertEqual(notes, {"animationFallback": "none"})
        warm, _ = shotlib.evaluate("orbit", 0.0, {}, "none", emits_light=True, lighting="warm_practical")
        self.assertEqual(warm.product_light, 1.0)

    def test_part_animations_degrade_on_a_single_mesh(self):
        s, notes = shotlib.evaluate("orbit", 1.0, {}, "explode", part_count=1)
        self.assertEqual((s.explode, notes), (0.0, {"animationFallback": "none"}))
        s, notes = shotlib.evaluate("orbit", 1.0, {"sweepDeg": 40}, "spin_part", part_count=1)
        self.assertEqual(notes, {"animationFallback": "rotate"})
        self.assertAlmostEqual(s.prod_rot, 10.0)
        s, notes = shotlib.evaluate("orbit", 1.0, {}, "explode", part_count=3)
        self.assertEqual((s.explode, notes), (1.0, {}))

    def test_animations_do_not_stack_on_preset_motion(self):
        base, _ = shotlib.evaluate("turntable", 0.9, {"sweepDeg": 90})
        rot, _ = shotlib.evaluate("turntable", 0.9, {"sweepDeg": 90}, "rotate")
        self.assertEqual(base.prod_rot, rot.prod_rot)
        lifted, _ = shotlib.evaluate("hero_reveal", 0.25, {}, "float")
        self.assertGreater(lifted.prod_lift, 0.04)

    def test_unknown_animation_is_rejected(self):
        with self.assertRaises(ValueError):
            shotlib.evaluate("orbit", 0.5, {}, "teleport")


class PlateStateTest(unittest.TestCase):
    def test_plates_use_the_composed_camera_and_full_light(self):
        for preset in shotlib.SHOT_PRESETS:
            rendered, _ = shotlib.resolve_preset(preset, 1)
            s, _ = shotlib.plate_state(rendered, {"intensity": 1}, "light_on", emits_light=True)
            self.assertEqual((s.cam_az, s.cam_el, s.cam_dolly, s.cam_truck, s.cam_pedestal), (0, 0, 1, 0, 0))
            self.assertEqual(s.product_light, 1.0)
            if rendered != "light_sweep":
                self.assertGreaterEqual(min(s.key, s.fill), 1.0)

    def test_resting_poses(self):
        self.assertEqual(shotlib.plate_state("product_drop")[0].prod_lift, 0.0)
        self.assertGreater(shotlib.plate_state("floating_product")[0].prod_lift, 0.07)
        self.assertEqual(shotlib.plate_state("feature_highlight")[0].accent, 1.0)


class CompositionTest(unittest.TestCase):
    def test_closeups_frame_the_detail_band(self):
        self.assertEqual(shotlib.composition("macro_push", {}).focus, "detail")
        self.assertEqual(shotlib.composition("macro_push", {"focus": "top"}).focus, "top")
        self.assertEqual(shotlib.composition("orbit", {}).focus, "whole")

    def test_close_up_of_a_thin_part_frames_the_widest_band(self):
        # marble cube base 0.2 m wide, thin rod 0.01 m, shade 0.25 m: a macro of the rod is a blur
        widths = {"base": 0.20, "middle": 0.01, "top": 0.25, "detail": 0.2}
        focus, note = shotlib.macro_focus("middle", widths, 0.25)
        self.assertEqual(focus, "top")
        self.assertIn("thin middle band", note)
        self.assertEqual(shotlib.macro_focus("base", widths, 0.25), ("base", None))
        # nothing wide enough anywhere: keep what the plan asked for
        self.assertEqual(shotlib.macro_focus("middle", {"base": 0.01, "middle": 0.01}, 0.25), ("middle", None))

    def test_plan_can_move_the_product_down_for_a_text_panel(self):
        self.assertEqual(shotlib.composition("silhouette_reveal", {}).center_y, 0.5)
        self.assertEqual(shotlib.composition("silhouette_reveal", {"centerY": 0.565}).center_y, 0.565)
        self.assertEqual(shotlib.composition("cta_hero", {}).center_y, 0.56)

    def test_top_down_and_low_angle(self):
        td = shotlib.composition("top_down", {"intensity": 0.0})
        self.assertIsNone(td.height)
        self.assertEqual(td.elevation_deg, 50.0)
        self.assertEqual(shotlib.composition("top_down", {"intensity": 1.0}).elevation_deg, 75.0)
        self.assertEqual(shotlib.composition("low_angle", {"height": 1.2}).height, 0.06)

    def test_focus_bands_are_inside_the_product(self):
        for focus in shotlib.FOCI:
            lo, hi = shotlib.focus_band(focus)
            self.assertTrue(0 <= lo < hi <= 1)


class TimingTest(unittest.TestCase):
    def test_sequence_frames_cover_the_whole_shot(self):
        for duration, fps in ((300, 6), (2500, 15), (3000, 15), (10_000, 60), (1234, 7)):
            n = shotlib.sequence_frame_count(duration, fps)
            self.assertGreaterEqual((n - 1) * 1000 / fps, duration)
            self.assertLess((n - 2) * 1000 / fps, duration)
            times = shotlib.sequence_times(duration, fps)
            self.assertEqual(len(times), n)
            self.assertEqual((times[0], times[-1]), (0.0, 1.0))
            self.assertTrue(all(a < b or b == 1.0 for a, b in zip(times, times[1:])))
        self.assertEqual(shotlib.sequence_frame_count(3000, 15), 46)


class PartsTest(unittest.TestCase):
    centres = [(0.0, 0.0, 0.1), (0.0, 0.0, 0.5), (0.2, 0.0, 0.3)]

    def test_no_explode_no_offset(self):
        self.assertEqual(shotlib.part_offsets(self.centres, (0, 0, 0.3), 1.0, 0.0), [(0, 0, 0)] * 3)

    def test_parts_move_outward_by_a_third_of_the_size(self):
        offs = shotlib.part_offsets(self.centres, (0, 0, 0.3), 1.0, 1.0)
        for c, o in zip(self.centres, offs):
            self.assertAlmostEqual(math.sqrt(sum(x * x for x in o)), 0.35)
            outward = sum((c[k] - (0, 0, 0.3)[k]) * o[k] for k in range(3))
            self.assertGreater(outward, 0)

    def test_stagger_starts_the_nearest_part_first(self):
        offs = shotlib.part_offsets(self.centres, (0, 0, 0.32), 1.0, 0.3, stagger=True)
        mags = [math.sqrt(sum(x * x for x in o)) for o in offs]
        self.assertGreater(mags[2], 0)  # nearest to the centre
        self.assertEqual(mags[0], 0)

    def test_cutaway_lifts_the_largest_part(self):
        offs = shotlib.part_offsets(self.centres, (0, 0, 0.3), 1.0, 0.0, cutaway=1.0, volumes=[1, 5, 2])
        self.assertEqual(offs[1], (0, 0, 0.6))
        self.assertEqual(offs[0], (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
