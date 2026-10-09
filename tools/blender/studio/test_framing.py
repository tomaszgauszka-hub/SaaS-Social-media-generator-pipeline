"""Unit tests of the pure camera math (python3 -m unittest discover tools/blender/studio)."""

from __future__ import annotations

import math
import unittest

import framing


def lamp_points() -> list[framing.Vec]:
    """A synthetic table lamp (0.55 m): disc base, thin stem, wide drum shade from 0.38 to 0.55 m."""
    pts: list[framing.Vec] = []
    for k in range(48):
        a = 2 * math.pi * k / 48
        c, s = math.cos(a), math.sin(a)
        pts += [(0.13 * c, 0.13 * s, 0.0), (0.13 * c, 0.13 * s, 0.03)]
        pts += [(0.012 * c, 0.012 * s, z / 10 * 0.38) for z in range(11)]
        pts += [(0.2 * c, 0.2 * s, 0.38 + 0.17 * z / 6) for z in range(7)]
    return pts


def box_points(w: float, d: float, h: float) -> list[framing.Vec]:
    return [(x, y, z) for x in (-w / 2, w / 2) for y in (-d / 2, d / 2) for z in (0.0, h)]


class VectorTest(unittest.TestCase):
    def test_look_at_is_orthonormal_and_right_handed(self):
        for cam in ((0.3, -2.0, 0.4), (0.0, -1.0, 3.0), (2.0, 2.0, -0.5), (0.0, 0.0, 5.0)):
            b = framing.look_at(cam, (0.0, 0.0, 0.2))
            for v in (b.right, b.up, b.forward):
                self.assertAlmostEqual(framing.length(v), 1.0)
            self.assertAlmostEqual(framing.dot(b.right, b.up), 0.0)
            self.assertAlmostEqual(framing.dot(b.right, b.forward), 0.0)
            # Blender camera: local X right, Y up, looking down -Z → right × up = -forward
            n = framing.cross(b.right, b.up)
            for k in range(3):
                self.assertAlmostEqual(n[k], -b.forward[k])

    def test_direction_conventions(self):
        front = framing.direction(0, 0)
        self.assertAlmostEqual(front[1], -1.0)
        right = framing.direction(90, 0)
        self.assertAlmostEqual(right[0], 1.0)
        up = framing.direction(0, 90)
        self.assertAlmostEqual(up[2], 1.0)
        self.assertEqual(framing.rotate_z((1.0, 0.0, 0.5), 90)[2], 0.5)
        self.assertAlmostEqual(framing.rotate_z((1.0, 0.0, 0.5), 90)[1], 1.0)


class ProjectionTest(unittest.TestCase):
    def test_axis_point_projects_to_the_centre_and_shift_moves_it(self):
        cam = (0.0, -2.0, 0.3)
        b = framing.look_at(cam, (0.0, 0.0, 0.3))
        u, v, z = framing.project((0.0, 0.0, 0.3), cam, b, framing.Lens(50, 1080, 1920))
        self.assertAlmostEqual(u, 0.5)
        self.assertAlmostEqual(v, 0.5)
        self.assertAlmostEqual(z, 2.0)
        _, v_up, _ = framing.project((0.0, 0.0, 0.3), cam, b, framing.Lens(50, 1080, 1920, shift_y=0.1))
        self.assertAlmostEqual(v_up, 0.6)  # shift up → the subject moves down the image
        u_l, _, _ = framing.project((0.0, 0.0, 0.3), cam, b, framing.Lens(50, 1080, 1920, shift_x=0.1))
        self.assertAlmostEqual(u_l, 0.5 - 0.1 * 1920 / 1080)

    def test_vertical_field_matches_the_36mm_sensor(self):
        cam = (0.0, -3.0, 0.0)
        b = framing.look_at(cam, (0.0, 0.0, 0.0))
        h = framing.frame_height_at(3.0, 65)
        _, v_top, _ = framing.project((0.0, 0.0, h / 2), cam, b, framing.Lens(65, 1080, 1920))
        self.assertAlmostEqual(v_top, 0.0)

    def test_points_behind_the_camera_are_ignored(self):
        cam = (0.0, -1.0, 0.0)
        b = framing.look_at(cam, (0.0, 0.0, 0.0))
        u, v, z = framing.project((0.0, -2.0, 0.0), cam, b, framing.Lens(50, 1080, 1920))
        self.assertTrue(math.isnan(u) and z < 0)
        with self.assertRaises(ValueError):
            framing.project_box([(0.0, -2.0, 0.0)], cam, b, framing.Lens(50, 1080, 1920))


class FitTest(unittest.TestCase):
    def test_fit_fills_the_requested_share_and_centres_the_product(self):
        pts = lamp_points()
        for fill, el, cy in ((0.62, 5.0, 0.5), (0.4, 20.0, 0.56), (0.66, -3.0, 0.47)):
            fit = framing.fit_camera(pts, (0.0, 0.0, 0.275), -25.0, el, 65, 1080, 1920, fill, (0.5, cy))
            u0, v0, u1, v1 = fit.box
            self.assertAlmostEqual(v1 - v0, fill, places=3)
            self.assertAlmostEqual((u0 + u1) / 2, 0.5, places=4)
            self.assertAlmostEqual((v0 + v1) / 2, cy, places=4)
            self.assertGreater(fit.distance, 0.2)

    def test_wide_products_are_limited_by_the_frame_width(self):
        pts = box_points(2.0, 0.4, 0.3)  # a low, wide sideboard
        fit = framing.fit_camera(pts, (0.0, 0.0, 0.15), 0.0, 10.0, 50, 1080, 1920, 0.62, max_width=0.92)
        u0, v0, u1, v1 = fit.box
        self.assertAlmostEqual(u1 - u0, 0.92, places=3)
        self.assertLess(v1 - v0, 0.62)

    def test_overfill_closeups_have_no_width_limit(self):
        pts = lamp_points()
        fit = framing.fit_camera(pts, (0.0, 0.0, 0.275), 0.0, 0.0, 65, 1080, 1920, 2.0, max_width=None)
        self.assertAlmostEqual(fit.box[3] - fit.box[1], 2.0, places=3)

    def test_fit_at_height_puts_the_camera_at_the_requested_z(self):
        pts = lamp_points()
        for z in (0.03, 0.3, 0.7):
            fit = framing.fit_at_height(pts, (0.0, 0.0, 0.275), 0.0, z, 65, 1080, 1920, 0.62)
            self.assertAlmostEqual(fit.camera[2], z, delta=0.002)

    def test_focus_distance_is_along_the_view_axis(self):
        fit = framing.fit_camera(lamp_points(), (0.0, 0.0, 0.275), 30.0, 12.0, 85, 1080, 1920, 0.62)
        self.assertAlmostEqual(fit.focus_distance, fit.distance)

    def test_plate_lens_keeps_the_composed_frame_in_the_centre(self):
        pts = lamp_points()
        fit = framing.fit_camera(pts, (0.0, 0.0, 0.275), -25.0, 6.0, 65, 810, 1440, 0.62, (0.5, 0.53))
        lens = framing.Lens(65, 810, 1440, fit.shift_x, fit.shift_y)
        plate = framing.plate_lens(lens, 1.18)
        self.assertEqual((plate.width, plate.height), (956, 1699))
        for p in pts[::17]:
            u, v, _ = framing.project(p, fit.camera, fit.basis, lens)
            pu, pv, _ = framing.project(p, fit.camera, fit.basis, plate)
            self.assertAlmostEqual(pu, 0.5 + (u - 0.5) / 1.18, delta=2e-3)
            self.assertAlmostEqual(pv, 0.5 + (v - 0.5) / 1.18, delta=2e-3)


class HelpersTest(unittest.TestCase):
    def test_subsample_keeps_the_extremes(self):
        pts = [(math.sin(k), math.cos(k * 0.7), k / 1000) for k in range(1000)]
        sub = framing.subsample(pts, 50)
        self.assertLessEqual(len(sub), 56)
        self.assertEqual(framing.bounds(sub), framing.bounds(pts))
        self.assertEqual(framing.subsample(pts[:10], 50), pts[:10])

    def test_bulb_sits_inside_the_drum_shade(self):
        pos, radius = framing.emitter_spot(lamp_points(), 0.55)
        self.assertEqual(pos[:2], (0.0, 0.0))
        self.assertTrue(0.38 < pos[2] < 0.55, pos)
        self.assertLess(radius, 0.2)

    def test_bulb_below_a_flat_disc(self):
        pts = [(0.01, 0.0, z / 10 * 0.5) for z in range(11)]
        pts += [(0.3 * math.cos(a), 0.3 * math.sin(a), 0.5) for a in range(6)]
        pos, _ = framing.emitter_spot(pts, 0.5)
        self.assertLess(pos[2], 0.5)

    def test_bulb_fallback_without_geometry(self):
        self.assertEqual(framing.emitter_spot([], 0.4)[0], (0.0, 0.0, 0.24))


if __name__ == "__main__":
    unittest.main()
