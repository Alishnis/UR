"""Mode "line": the dark line and its tapes on a ray-cast pool floor, compared with the scene truth."""

from __future__ import annotations

import base64

import cv2
import numpy as np
import pytest

from vision.line import PASSES, detect_line, line_params
from vision_synth import FloorCamera, jpeg_roundtrip, line_scene


def run(scene, params=None, quality: int = 75) -> dict:
    return detect_line(jpeg_roundtrip(scene.img, quality), params or {})


def truth_offset(scene, ref_y: float) -> float:
    half = scene.cam.w / 2
    return (scene.axis_x_at(ref_y) - half) / half


def assert_matches_truth(scene, res, angle_tol=2.0, offset_tol=0.04):
    line = res["line"]
    assert line is not None
    assert line["angleDeg"] == pytest.approx(scene.angle_deg(), abs=angle_tol)
    assert line["offset"] == pytest.approx(truth_offset(scene, res["refY"]), abs=offset_tol)
    assert line["p0"][1] > line["p1"][1]  # p0 = the end nearer the image bottom
    h, w = scene.img.shape[:2]
    for x, y in (line["p0"], line["p1"]):
        assert 0 <= x <= w and 0 <= y <= h
    return line


def assert_tapes(found, truth, tol_px=6.0):
    found = np.array(found).reshape(-1, 2)
    assert len(found) == len(truth), (found.tolist(), truth.tolist())
    assert list(found[:, 1]) == sorted(found[:, 1], reverse=True)  # bottom -> top
    if len(truth):
        assert np.abs(found - truth).max() <= tol_px


def test_centred_straight_line():
    scene = line_scene(FloorCamera(y=0.2), tapes_y=(0.5, 1.0, 1.5, 2.0))
    res = run(scene)
    assert res["refY"] == pytest.approx(0.75 * 360)
    line = assert_matches_truth(scene, res)
    assert abs(line["angleDeg"]) < 1 and abs(line["offset"]) < 0.02
    assert_tapes(line["tapes"], scene.visible_tapes(margin=12))
    assert line["confidence"] > 0.8
    assert 15 < line["widthPx"] < 45


@pytest.mark.parametrize("cam_x, sign", [(-0.2, 1), (0.2, -1)])
def test_offset_sign(cam_x, sign):
    scene = line_scene(FloorCamera(x=cam_x))  # camera left of the line -> the line is right of centre
    line = assert_matches_truth(scene, run(scene))
    assert np.sign(line["offset"]) == sign and abs(line["offset"]) > 0.25


@pytest.mark.parametrize("yaw, sign", [(-20, 1), (20, -1)])
def test_angle_sign(yaw, sign):
    scene = line_scene(FloorCamera(yaw_deg=yaw))  # ROV turned left -> the far end leans right
    line = assert_matches_truth(scene, run(scene))
    assert np.sign(line["angleDeg"]) == sign and abs(line["angleDeg"]) > 10


@pytest.mark.parametrize("height, line_w, cam_x", [(0.2, 0.05, 0.0), (0.25, 0.08, -0.06), (0.3, 0.08, 0.1)])
def test_rov_low_over_a_wide_line(height, line_w, cam_x):
    # the line fills 15-30 % of the frame width: wider than the fine pass can see
    scene = line_scene(FloorCamera(height=height, tilt_deg=70, x=cam_x, yaw_deg=5), line_w=line_w)
    line = assert_matches_truth(scene, run(scene), angle_tol=3.0, offset_tol=0.05)
    assert line["widthPx"] > 0.11 * 640 and line["confidence"] > 0.8


def test_line_crossing_the_frame_at_a_steep_angle():
    scene = line_scene(FloorCamera(yaw_deg=60, tilt_deg=70, height=0.8))
    res = run(scene)
    line = assert_matches_truth(scene, res, angle_tol=2.5, offset_tol=0.06)
    assert line["angleDeg"] < -45
    assert_tapes(line["tapes"], scene.visible_tapes(margin=12))


HIGH = FloorCamera(y=-0.3, height=1.2, tilt_deg=45)  # sees the whole 1.5 m course


def test_all_tapes_seen_from_higher_up():
    scene = line_scene(HIGH, line_y=(-1.0, 2.0))
    line = assert_matches_truth(scene, run(scene))
    assert_tapes(line["tapes"], scene.visible_tapes())
    assert len(line["tapes"]) == 3


@pytest.mark.parametrize("cam", [HIGH, FloorCamera(y=0.0, height=1.2, tilt_deg=45),
                                 FloorCamera(y=-0.2, height=1.0, tilt_deg=40, yaw_deg=-6)])
def test_tape_at_the_far_end_of_the_line(cam):
    with_tape = line_scene(cam, line_y=(-1.0, 1.5), tapes_y=(0.5, 1.0, 1.5))  # final tape = end of the line
    line = assert_matches_truth(with_tape, run(with_tape))
    assert_tapes(line["tapes"], with_tape.visible_tapes())
    without = line_scene(cam, line_y=(-1.0, 1.5), tapes_y=(0.5, 1.0))  # the line just ends
    line = assert_matches_truth(without, run(without))
    assert_tapes(line["tapes"], without.visible_tapes())


@pytest.mark.parametrize("seed", range(4))
def test_strong_caustics_make_no_tape_at_a_bare_line_end(seed):
    cam = FloorCamera(y=0.5, height=0.9, tilt_deg=50, yaw_deg=5 * seed - 8)
    scene = line_scene(cam, line_y=(-1.0, 1.5), tapes_y=(1.0,), caustics=1.2, seed=seed)
    line = assert_matches_truth(scene, run(scene))
    assert_tapes(line["tapes"], scene.visible_tapes(), tol_px=8)


@pytest.mark.parametrize("kwargs", [
    {},
    {"grout": True},
    {"caustics": 1.2, "light": (0.45, 1.1)},
    {"grout": True, "caustics": 1.0, "light": (1.1, 0.5), "noise": 9},
])
def test_no_line_means_null(kwargs):
    for seed in range(3):
        cam = FloorCamera(yaw_deg=15 * seed - 15, tilt_deg=45 + 10 * seed)
        scene = line_scene(cam, draw_line=False, seed=seed, **kwargs)
        assert run(scene)["line"] is None


def test_tile_joints_are_not_the_line():
    scene = line_scene(FloorCamera(x=0.12, yaw_deg=8), grout=True)  # joints run next to and across the line
    assert_matches_truth(scene, run(scene))


@pytest.mark.parametrize("light", [(0.3, 1.1), (1.1, 0.3)])
def test_uneven_light(light):
    cam = FloorCamera(x=-0.1, yaw_deg=-8)
    plain = run(line_scene(cam))["line"]
    scene = line_scene(cam, light=light)
    line = assert_matches_truth(scene, run(scene))
    assert line["angleDeg"] == pytest.approx(plain["angleDeg"], abs=1.0)
    assert line["offset"] == pytest.approx(plain["offset"], abs=0.02)
    assert len(line["tapes"]) == len(plain["tapes"])


def test_vertical_light_falloff():
    scene = line_scene(FloorCamera(yaw_deg=10), caustics=0.6)
    dark_top = scene.img.astype(np.float32) * np.linspace(0.3, 1.0, scene.img.shape[0])[:, None, None]
    scene.img = dark_top.astype(np.uint8)
    line = assert_matches_truth(scene, run(scene))
    assert_tapes(line["tapes"], scene.visible_tapes(margin=25))  # one more tape is cut by the dark top edge


def test_murky_water_and_the_dark_threshold():
    murky = line_scene(visibility=2.0, noise=8, blur=1.5)
    assert_matches_truth(murky, run(murky, quality=60))
    # far line in very murky water: too faint for the default, found with a lower threshold
    faint = line_scene(FloorCamera(height=1.5, tilt_deg=30), visibility=1.5, noise=8, blur=1.5)
    assert run(faint)["line"] is None
    assert_matches_truth(faint, run(faint, {"darkThresh": 12}), offset_tol=0.06)


def test_full_resolution_frame_gives_the_same_answer():
    small = line_scene(FloorCamera(x=-0.1, yaw_deg=-10))
    big = line_scene(FloorCamera(x=-0.1, yaw_deg=-10, w=1280, h=720))
    a, b = run(small)["line"], run(big)["line"]
    assert_matches_truth(big, run(big))
    assert b["angleDeg"] == pytest.approx(a["angleDeg"], abs=1.0)
    assert b["offset"] == pytest.approx(a["offset"], abs=0.02)
    assert b["widthPx"] == pytest.approx(2 * a["widthPx"], rel=0.2)
    assert len(b["tapes"]) == len(a["tapes"])


def test_mask_is_a_work_size_png_with_the_line_white():
    scene = line_scene()
    res = run(scene, {"mask": True})
    assert "mask" not in run(scene)
    png = base64.b64decode(res["mask"].split(",", 1)[1])
    mask = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
    work_w = PASSES[0][0]
    assert mask.shape == (270, work_w)
    x = int(round(scene.axis_x_at(200) * work_w / 640))
    assert mask[150, x - 2:x + 3].max() == 255  # on the line
    assert mask[150, 20] == 0 and mask[150, 460] == 0  # floor


def test_params_and_odd_frames():
    assert line_params({"darkThresh": 500, "refRow": 0.1, "mask": 1, "junk": 2}) == {
        "darkThresh": 120.0, "refRow": 0.3, "mask": False}
    res = detect_line(np.full((360, 640, 3), 120, np.uint8), {"refRow": 0.5})
    assert res == {"refY": 180.0, "line": None}
    assert detect_line(np.zeros((6, 9, 3), np.uint8), {"mask": True})["line"] is None
    assert detect_line(np.zeros((100, 4, 3), np.uint8), {})["line"] is None


def test_start_tape_at_the_near_end_of_the_line_is_reported():
    # the line begins AT the start tape: that tape is only ever the near end of the line
    from vision_synth import FloorCamera, line_scene
    seen = 0
    for y in (-0.6, -0.5, -0.45):
        cam = FloorCamera(y=y, height=0.6, tilt_deg=55)
        sc = line_scene(cam, line_y=(-0.025, 3.0), tapes_y=(0.0, 0.5, 1.0, 1.5))
        res = detect_line(sc.img, {})["line"]
        truth = [float(p[1]) for p in sc.visible_tapes()]
        assert res is not None
        got = [p[1] for p in res["tapes"]]
        lowest = max(truth)  # the start tape is the lowest one in the picture
        seen += any(abs(g - lowest) < 0.03 * sc.img.shape[0] for g in got)
    assert seen == 3
