"""Mode "tags": tag36h11 detection on pool-like synthetic frames, filters, pose and the yaw sign."""

from __future__ import annotations

import threading

import numpy as np
import pytest

from vision.tags import detect_tags, tags_params
from vision_synth import (TAG_BITS, TAG_IDS, camera_matrix, degrade, jpeg_roundtrip, light_gradient, paste_tag,
                          square_quad, tag_quad, tag_scene, water, yaw_pose)

W, H = 1280, 720
HFOV = 60.0


def ids(result: dict) -> list[int]:
    return [t["id"] for t in result["tags"]]


def underwater(img: np.ndarray, seed: int = 0) -> np.ndarray:
    """Murky pool camera: contrast loss, blur, noise, JPEG."""
    return jpeg_roundtrip(degrade(img, haze=0.45, blur=1.2, noise=6, seed=seed), 75)


@pytest.mark.parametrize("clahe", [True, False])
@pytest.mark.parametrize("murky", [False, True])
def test_finds_the_three_competition_tags(clahe, murky):
    img = tag_scene(seed=1)
    img = underwater(img) if murky else jpeg_roundtrip(img, 85)
    res = detect_tags(img, {"clahe": clahe})
    assert ids(res) == sorted(TAG_IDS)  # also sorted by id
    for t in res["tags"]:
        assert len(t["corners"]) == 4 and all(len(c) == 2 for c in t["corners"])
        assert t["margin"] >= 20 and t["pose"] is None  # no pose without hfovDeg


def test_uneven_light_and_small_turned_far_tag():
    quads = {17: square_quad(300, 360, 150), 245: square_quad(700, 300, 24, 35),  # 24 px: ~3 px per cell
             503: np.array([[1000, 250], [1100, 290], [1095, 420], [995, 440]], float)}  # seen at a slant
    img = light_gradient(tag_scene(quads=quads), 0.35, 1.1)
    res = detect_tags(jpeg_roundtrip(degrade(img, blur=0.8, noise=4), 80), {})
    assert ids(res) == sorted(TAG_IDS)


def test_corners_counter_clockwise_and_tied_to_the_printed_tag():
    base = square_quad(640, 360, 240)  # TL, TR, BR, BL of the printed tag
    expected_order = None
    for k in range(4):  # turn the tag in the image plane by k x 90 degrees
        quad = np.roll(base, k, axis=0)
        (tag,) = detect_tags(jpeg_roundtrip(paste_tag(water(W, H), 245, quad), 90), {})["tags"]
        c = np.array(tag["corners"])
        x, y = c[:, 0], c[:, 1]
        assert np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y) < 0  # counter-clockwise on screen (y down)
        # which printed corner each detected corner is: the same for every rotation
        order = [int(np.argmin(np.linalg.norm(quad - p, axis=1))) for p in c]
        assert np.allclose(c, quad[order], atol=2.0)
        expected_order = expected_order or order
        assert order == expected_order
        assert np.allclose(tag["center"], quad.mean(axis=0), atol=1.5)


def test_margin_filter():
    img = water(W, H)
    img = paste_tag(img, 17, square_quad(300, 360, 160))  # strong contrast
    img = paste_tag(img, 503, square_quad(900, 360, 160), black=(110, 110, 110), white=(140, 140, 140))  # faint
    img = jpeg_roundtrip(degrade(img, blur=0.8, noise=3), 85)
    everything = detect_tags(img, {"clahe": False, "minMargin": 0})["tags"]
    assert ids({"tags": everything}) == [17, 503]
    faint = next(t for t in everything if t["id"] == 503)
    strong = next(t for t in everything if t["id"] == 17)
    assert faint["margin"] < strong["margin"]
    cut = (faint["margin"] + strong["margin"]) / 2
    assert ids(detect_tags(img, {"clahe": False, "minMargin": cut})) == [17]
    assert ids(detect_tags(img, {"minMargin": 200})) == []
    # CLAHE raises the margin of a faint tag (why it is on by default)
    clahe = next(t for t in detect_tags(img, {"clahe": True, "minMargin": 0})["tags"] if t["id"] == 503)
    assert clahe["margin"] > faint["margin"]


def test_corrected_bit_errors():
    rows = TAG_BITS[245].split()
    rows[3] = rows[3][:3] + ("1" if rows[3][3] == "0" else "0") + rows[3][4:]  # one wrong cell
    TAG_BITS[-245] = " ".join(rows)
    try:
        img = paste_tag(water(W, H), -245, square_quad(640, 360, 200))
        # one corrected bit: still 245 (tag36h11 codes differ in >= 11 bits), accepted by default
        assert ids(detect_tags(img, {"minMargin": 0})) == [245]
        # maxHamming 0: not trusted, but reported as weak so the GUI can show "seen"
        res = detect_tags(img, {"minMargin": 0, "maxHamming": 0})
        assert res["tags"] == []
        assert [(t["id"], t["hamming"]) for t in res["weak"]] == [(245, 1)]
    finally:
        del TAG_BITS[-245]


def test_weak_below_margin_and_clahe_pass_only_when_needed():
    img = water(W, H)
    img = paste_tag(img, 17, square_quad(300, 360, 160))
    img = paste_tag(img, 503, square_quad(900, 360, 160), black=(110, 110, 110), white=(140, 140, 140))
    img = jpeg_roundtrip(degrade(img, blur=0.8, noise=3), 85)
    res = detect_tags(img, {"minMargin": 200})
    assert res["tags"] == [] and sorted(t["id"] for t in res["weak"]) == [17, 503]
    # expect 1: the raw pass already found one tag, so no CLAHE pass -> the faint tag keeps its raw margin
    one = detect_tags(img, {"minMargin": 0, "expect": 1})["tags"]
    both = detect_tags(img, {"minMargin": 0, "expect": 3})["tags"]
    m = lambda tags: next(t["margin"] for t in tags if t["id"] == 503)  # noqa: E731
    assert m(both) >= m(one)


def test_empty_and_odd_frames():
    assert detect_tags(water(W, H), {})["tags"] == []
    assert detect_tags(np.zeros((8, 8, 3), np.uint8), {})["tags"] == []
    assert detect_tags(np.full((720, 1280, 3), 255, np.uint8), {})["tags"] == []


@pytest.mark.parametrize("decimate", [1, 1.5, 4])
def test_tiny_frames_do_not_crash_the_detector(decimate):
    # pupil-apriltags segfaults on images a few px high: that would take the whole bridge down
    for shape in [(1, 1), (1, 640), (2, 700), (5, 300), (8, 1280), (31, 900), (300, 2), (40, 40)]:
        assert detect_tags(np.full(shape + (3,), 90, np.uint8), {"decimate": decimate})["tags"] == []


def test_params_are_sanitised():
    p = tags_params({"clahe": "yes", "minMargin": 900, "decimate": 1.6, "tagSizeM": -1, "hfovDeg": "70", "x": 1})
    assert p == {"clahe": True, "minMargin": 200.0, "maxHamming": 1, "expect": 3, "decimate": 1.5,
                 "tagSizeM": 0.01, "hfovDeg": None}
    assert tags_params({"maxHamming": 7, "expect": -2})["maxHamming"] == 2
    assert tags_params({"expect": -2})["expect"] == 0
    assert tags_params({"decimate": 2.7, "hfovDeg": 500})["decimate"] == 3.0
    assert tags_params({"hfovDeg": 500})["hfovDeg"] == 170.0


def test_decimate_still_finds_big_tags():
    img = jpeg_roundtrip(tag_scene(quads={17: square_quad(400, 360, 220), 245: square_quad(900, 360, 180)}), 85)
    assert ids(detect_tags(img, {"decimate": 2.0})) == [17, 245]


# ---------- pose ----------

def render_pose(dist: float, yaw: float, shift=(0.1, -0.05), roll: int = 0, tag_id: int = 245, seed: int = 0):
    K = camera_matrix(W, H, HFOV)
    R, t = yaw_pose(dist, yaw, shift)
    quad = np.roll(tag_quad(K, 0.162, R, t), roll, axis=0)
    img = paste_tag(water(W, H, seed), tag_id, quad)
    return jpeg_roundtrip(degrade(img, blur=0.8, noise=4, seed=seed), 80), quad, R, t


@pytest.mark.parametrize("dist", [0.6, 1.5, 3.0, 5.0])
@pytest.mark.parametrize("yaw", [0, 35])
def test_pose_distance_within_ten_percent(dist, yaw):
    img, _, _, t = render_pose(dist, yaw)
    (tag,) = detect_tags(img, {"hfovDeg": HFOV, "tagSizeM": 0.162})["tags"]
    pose = tag["pose"]
    assert pose["dist"] == pytest.approx(np.linalg.norm(t), rel=0.10)
    assert [pose["x"], pose["y"], pose["z"]] == pytest.approx(t.tolist(), abs=0.1 * dist)
    assert set(pose) == {"x", "y", "z", "dist", "yawDeg", "yawOk"}


@pytest.mark.parametrize("roll", [0, 1, 2, 3])
@pytest.mark.parametrize("dist", [0.8, 2.0])
def test_yaw_sign_positive_when_rov_is_right_of_the_tag_centre_line(roll, dist):
    """yaw_pose(+30) puts the camera 30 degrees to the RIGHT of the tag's centre line (seen from the ROV),
    looking at the tag. The right edge of the tag is then nearer, so it looks taller. yawDeg must be +30;
    the mirror case -30. Turning the tag in its own plane (roll) must not change the sign."""
    for yaw in (30, -30):
        img, quad, R, t = render_pose(dist, yaw, shift=(0.0, 0.0), roll=roll)
        if roll == 0:
            tl, tr, br, bl = quad
            right_h, left_h = np.linalg.norm(br - tr), np.linalg.norm(bl - tl)
            assert (right_h > left_h) == (yaw > 0)  # the visual cue the sign stands for
        (tag,) = detect_tags(img, {"hfovDeg": HFOV})["tags"]
        assert tag["pose"]["yawDeg"] == pytest.approx(yaw, abs=5)
        assert tag["pose"]["yawOk"] is True


def test_yaw_is_measured_from_the_tag_centre_line_not_the_view_direction():
    # camera straight in front of the tag but the tag off to the side of the image: yaw ~0
    K = camera_matrix(W, H, HFOV)
    a = np.radians(20)  # the camera is turned 20 degrees: the tag appears on the left of the image
    R = np.array([[np.cos(a), 0, -np.sin(a)], [0, 1, 0], [np.sin(a), 0, np.cos(a)]])
    t = R @ np.array([0.0, 0.0, 1.5])
    img = jpeg_roundtrip(paste_tag(water(W, H), 17, tag_quad(K, 0.162, R, t)), 85)
    (tag,) = detect_tags(img, {"hfovDeg": HFOV})["tags"]
    assert tag["center"][0] < W / 2 - 100
    assert tag["pose"]["yawDeg"] == pytest.approx(0, abs=5)


# ---------- threads ----------

def test_parallel_calls_give_the_same_results():
    frames = [underwater(tag_scene(seed=s), seed=s) for s in range(3)]
    expected = [detect_tags(f, {}) for f in frames]
    errors, results = [], []

    def worker(k: int) -> None:
        try:
            for i in range(6):
                j = (i + k) % 3
                results.append((j, detect_tags(frames[j], {})))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(k,)) for k in range(4)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert not errors
    assert len(results) == 24
    for j, res in results:
        assert res == expected[j]
