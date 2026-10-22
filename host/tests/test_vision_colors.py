"""Mode "colors": HSV blobs (Mission 5 poles) on pool-like synthetic frames."""

from __future__ import annotations

import base64

import cv2
import numpy as np
import pytest

from vision.colors import DEFAULT_COLORS, MAX_COLORS, colors_params, detect_colors, sanitize_color
from vision_synth import Pole, degrade, jpeg_roundtrip, poles_scene, water


def by_color(blobs: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for b in blobs:
        out.setdefault(b["color"], []).append(b)
    return out


def hsv_patch(img: np.ndarray, x0: int, y0: int, x1: int, y1: int, hsv) -> None:
    """Paint a rectangle with an exact OpenCV HSV colour."""
    px = cv2.cvtColor(np.uint8([[hsv]]), cv2.COLOR_HSV2BGR)[0, 0]
    img[y0:y1, x0:x1] = px


@pytest.mark.parametrize("size", [(640, 360), (1280, 720)])
@pytest.mark.parametrize("murky", [False, True])
def test_each_pole_found_once_where_it_is(size, murky):
    w, h = size
    img, poles = poles_scene(w, h, haze=0.3 if murky else 0.15, noise=7 if murky else 4, seed=3)
    res = detect_colors(jpeg_roundtrip(img, 75), {})
    found = by_color(res["blobs"])
    assert sorted(found) == ["blue", "red", "yellow"]  # nothing else: the blue-green water is not "blue"
    s = w / 640  # tolerance grows with the frame size
    for p in poles:
        (blob,) = found[p.color]
        assert blob["box"] == pytest.approx(list(p.box), abs=3 * s)
        assert blob["center"] == pytest.approx([p.x, (p.top + p.bottom) / 2], abs=3 * s)
        assert blob["aspect"] > 5 and blob["fill"] > 0.9
        assert blob["area"] == pytest.approx(p.width * (p.bottom - p.top), rel=0.15)  # dim edges may drop
        assert blob["areaFrac"] == pytest.approx(blob["area"] / (w * h), rel=0.02)
    areas = [b["area"] for b in res["blobs"]]
    assert areas == sorted(areas, reverse=True)


def test_red_hue_wraps_through_zero():
    img = water(640, 360)
    hsv_patch(img, 200, 100, 230, 300, (175, 220, 200))  # one pole, two hues either side of 0
    hsv_patch(img, 230, 100, 260, 300, (3, 220, 200))
    (blob,) = detect_colors(img, {})["blobs"]
    assert blob["color"] == "red" and blob["box"] == pytest.approx([200, 100, 60, 200], abs=1)
    no_wrap = {"colors": {"red": {"h": [0, 10], "s": [100, 255], "v": [70, 255]}}}
    (half,) = detect_colors(img, no_wrap)["blobs"]
    assert half["box"] == pytest.approx([230, 100, 30, 200], abs=1)


def test_min_area_and_max_blobs():
    img = water(640, 360)
    for i, side in enumerate((40, 30, 20, 12, 6)):  # five yellow squares, biggest first
        hsv_patch(img, 30 + 120 * i, 150, 30 + 120 * i + side, 150 + side, (28, 220, 220))
    yellow = {"colors": {"yellow": DEFAULT_COLORS["yellow"]}}
    sizes = lambda res: [round(b["box"][2]) for b in res["blobs"]]  # noqa: E731
    assert sizes(detect_colors(img, {**yellow, "maxBlobs": 10, "minAreaFrac": 0})) == [40, 30, 20, 12, 6]
    assert sizes(detect_colors(img, {**yellow, "maxBlobs": 2})) == [40, 30]
    # 15 x 15 px of 640 x 360 is ~0.001 of the frame: 12 px (and smaller) squares are dropped
    assert sizes(detect_colors(img, {**yellow, "maxBlobs": 10, "minAreaFrac": 0.001})) == [40, 30, 20]
    assert sizes(detect_colors(img, {**yellow, "minAreaFrac": 0.5})) == []
    # default minAreaFrac 0.0008 = ~184 px at 640 x 360: 20 px passes, 12 px does not
    assert sizes(detect_colors(img, {**yellow, "maxBlobs": 10})) == [40, 30, 20]


def test_speckle_noise_is_not_a_blob():
    rng = np.random.default_rng(0)
    img = water(640, 360)
    ys, xs = rng.integers(0, 360, 400), rng.integers(0, 640, 400)
    img[ys, xs] = (20, 200, 230)  # isolated yellow pixels
    assert detect_colors(degrade(img, noise=4), {"minAreaFrac": 0})["blobs"] == []


def test_mask_for_the_requested_colour():
    img, poles = poles_scene(1280, 720)
    res = detect_colors(img, {"mask": "blue"})
    png = base64.b64decode(res["mask"].split(",", 1)[1])
    mask = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
    assert mask.shape == (360, 640)  # work size: at most 640 wide
    blue = next(p for p in poles if p.color == "blue")
    assert mask[int(blue.bottom / 2) - 20, int(blue.x / 2)] == 255
    red = next(p for p in poles if p.color == "red")
    assert mask[int(red.bottom / 2) - 20, int(red.x / 2)] == 0
    assert "mask" not in detect_colors(img, {})
    assert "mask" not in detect_colors(img, {"mask": "green"})  # not one of the colours
    assert "mask" not in detect_colors(img, {"mask": 3})


def test_custom_colours_replace_the_defaults():
    img, _ = poles_scene()
    hsv_patch(img, 300, 40, 340, 120, (60, 200, 200))  # a green object
    green = {"h": [50, 70], "s": [100, 255], "v": [60, 255]}
    res = detect_colors(img, {"colors": {"green": green}})
    assert [b["color"] for b in res["blobs"]] == ["green"]
    assert res["blobs"][0]["box"] == pytest.approx([300, 40, 40, 80], abs=1)


def test_colour_params_are_sanitised():
    many = {f"c{i}": {"h": [i, i + 5], "s": [0, 255], "v": [0, 255]} for i in range(9)}
    assert list(colors_params({"colors": many})["colors"]) == [f"c{i}" for i in range(MAX_COLORS)]
    raw = {
        "Bad Name": {"h": [1, 2], "s": [0, 255], "v": [0, 255]},  # names: 1..16 of [a-z0-9_-]
        "x" * 17: {"h": [1, 2], "s": [0, 255], "v": [0, 255]},
        "red": {"h": "oops"},  # known colour, broken range -> its default
        "mystery": {"h": [1, 2]},  # unknown colour, broken range -> dropped
        "pink_2": {"h": [300.4, -5], "s": [255, 90.6], "v": [10, 999]},  # clamped, rounded, S/V ordered
    }
    p = colors_params({"colors": raw, "minAreaFrac": "big", "maxBlobs": 0, "mask": "pink_2"})
    assert p["colors"] == {"red": DEFAULT_COLORS["red"], "pink_2": {"h": [179, 0], "s": [91, 255], "v": [10, 255]}}
    assert p["minAreaFrac"] == 0.0008 and p["maxBlobs"] == 1 and p["mask"] == "pink_2"
    for empty in (None, {}, [], "red", {"BAD": {}}):
        assert colors_params({"colors": empty})["colors"] == DEFAULT_COLORS
    assert sanitize_color({"h": [True, 3], "s": [0, 255], "v": [0, 255]}) is None
    assert sanitize_color({"h": [1, 2, 3], "s": [0, 255], "v": [0, 255]}) is None
    assert sanitize_color([1, 2]) is None


def test_defaults_are_not_changed_by_a_call():
    before = {k: {kk: list(vv) for kk, vv in v.items()} for k, v in DEFAULT_COLORS.items()}
    p = colors_params({})
    p["colors"]["red"]["h"][0] = 0
    assert DEFAULT_COLORS == before


def test_pole_partly_out_of_the_frame_and_far_small_pole():
    poles = [Pole("red", 8, 40, 300, 30), Pole("yellow", 500, 200, 240, 6)]  # cut by the left edge; far
    img, _ = poles_scene(640, 360, poles)
    found = by_color(detect_colors(jpeg_roundtrip(img, 80), {"minAreaFrac": 0.0002})["blobs"])
    assert found["red"][0]["box"][0] == pytest.approx(0, abs=1)
    assert found["yellow"][0]["aspect"] > 4
