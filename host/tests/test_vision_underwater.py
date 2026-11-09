"""Mission 5 under water: the colour detector on physics-based pool frames (tests/underwater_sim.py).

The question a judge asks: "red looks like another colour under water - does your robot still know the
red pole?" Water eats red light first and puts a blue-green veil in front of everything, so with the
camera's colours taken as they are, a red pole turns brown, then magenta, then blue-grey as the robot
backs off. The detector therefore first balances the picture against the water (water -> grey), and
these tests check what that buys over a range of pools, lamps, cameras and distances. The full sweep
(144 conditions) is tools/colors_bench.py; this is a faster subset of it.
"""

from __future__ import annotations

import functools
import itertools

import cv2
import numpy as np
import pytest

from tools.colors_bench import RAW_DEFAULTS, on_pole, pick_poles, score_frame
from underwater_sim import NEUTRALS, PAINT, Camera, PoleSpec, Water, render, three_poles
from vision import colors as vc

POOLS = [Water(turbidity=b, depth=d, light=light, gradient_m=g)
         for (b, d, g), light in itertools.product(
             [(0.03, 0.5, 0.0), (0.1, 1.0, 1.5), (0.3, 1.5, 0.0)], ["led4000", "daylight", "warm3000"])]
CAMERAS = [Camera(wb="auto"), Camera(wb="locked")]
CASES = list(itertools.product(range(len(POOLS)), range(len(CAMERAS))))


@functools.lru_cache(maxsize=None)
def frame(pool: int, cam: int, z: float, wall: bool = False):
    return render(three_poles(z), POOLS[pool], CAMERAS[cam], seed=pool * 10 + cam,
                  wall_m=z + 3.0 if wall else None)


def results(z: float, params: dict | None = None, wall: bool = False) -> list[dict]:
    out = []
    for pool, cam in CASES:
        img, truths = frame(pool, cam, z, wall)
        out.append(score_frame(vc.detect_colors(img, params or {})["blobs"], truths))
    return out


def hsv_at(img: np.ndarray, truth) -> np.ndarray:
    """Median HSV of the middle of a pole."""
    x, y, w, h = truth.box
    patch = img[int(y + h * 0.3):int(y + h * 0.7), int(x + w * 0.35):int(np.ceil(x + w * 0.65))]
    return np.median(cv2.cvtColor(patch, cv2.COLOR_BGR2HSV).reshape(-1, 3), axis=0)


# ---------- the judge's question ----------

def test_without_the_balance_red_stops_looking_red():
    """Camera balanced at the surface (white balance locked), clear pool, LED lamps: the red pole's hue
    leaves the red range and its colour fades towards the water's as the distance grows."""
    water, cam = Water(turbidity=0.1, depth=1.0), Camera(wb="locked")
    hues = []
    for z in (0.5, 1.5, 3.0, 5.0):
        img, truths = render(three_poles(z), water, cam)
        red = next(t for t in truths if t.color == "red")
        raw_h = hsv_at(img, red)[0]
        bal_h, bal_s, _ = hsv_at(vc.balanced(img), red)
        hues.append(raw_h)
        assert bal_h <= 8 or bal_h >= 170, f"balanced red hue {bal_h} at {z} m"   # stays red
        assert bal_s >= 45
    assert any(20 < h < 170 for h in hues), f"raw hues {hues}: expected red to drift to magenta / blue"


@pytest.mark.parametrize("z", [0.5, 1.0, 1.5, 2.0])
def test_every_pole_is_picked_right_up_close(z):
    for res in results(z):
        assert res == {"red": "ok", "yellow": "ok", "blue": "ok"}, f"{z} m: {res}"


def test_at_3_m_every_pole_is_picked_right_unless_the_water_is_cloudy():
    """3 m: clear and normal pool water - all right. Cloudy water (scattering 0.3 /m, lamps 1.5 m up)
    may miss the red pole at 3 m (too little red light is left), but never mixes it up (next test)."""
    for (pool, cam), res in zip(CASES, results(3.0)):
        if POOLS[pool].turbidity <= 0.1:
            assert res == {"red": "ok", "yellow": "ok", "blue": "ok"}, f"{POOLS[pool]} {CAMERAS[cam]}: {res}"
        else:
            assert res["yellow"] == "ok" and res["blue"] == "ok" and res["red"] in ("ok", "missed")


@pytest.mark.parametrize("z", [0.5, 1.5, 3.0, 4.0, 5.0])
@pytest.mark.parametrize("wall", [False, True])
def test_a_pole_is_never_called_another_colour(z, wall):
    """Far away a pole may be MISSED (too much water in between: the pilot sees SEARCH and comes closer),
    but it must never be reported as another colour or send the pilot somewhere else."""
    for res in results(z, wall=wall):
        assert not {c: r for c, r in res.items() if r in ("wrong", "confused")}, f"{z} m wall={wall}: {res}"


def test_the_old_raw_ranges_did_get_colours_wrong():
    """What the balance replaces: the same frames with the raw camera colours and the old ranges."""
    bad = sum(r in ("wrong", "confused") for z in (1.5, 3.0) for res in results(z, {"balance": False,
                                                                                 "colors": RAW_DEFAULTS})
              for r in res.values())
    ok_red = sum(res["red"] == "ok" for res in results(3.0, {"balance": False, "colors": RAW_DEFAULTS}))
    assert bad > 0 or ok_red < len(CASES) * 0.5


# ---------- the camera having a bad day ----------

@pytest.mark.parametrize("cam", [
    Camera(exposure=0.18), Camera(exposure=0.75), Camera(jpeg=40), Camera(noise=0.035), Camera(blur=1.8),
    Camera(wb="none"), Camera(w=1280, h=720),
])
def test_dark_bright_noisy_blurry_and_unbalanced_frames(cam):
    for pool in POOLS[::2]:
        img, truths = render(three_poles(1.5), pool, cam, seed=5)
        res = score_frame(vc.detect_colors(img, {})["blobs"], truths)
        assert res == {"red": "ok", "yellow": "ok", "blue": "ok"}, f"{cam} {pool}: {res}"


@pytest.mark.parametrize("color", ["red", "yellow", "blue"])
@pytest.mark.parametrize("z", [0.2, 0.3])
def test_one_pole_right_in_front_of_the_camera(color, z):
    """The last metre before the hit: one pole, up to a quarter of the picture wide."""
    for pool in POOLS[::2]:
        img, (t,) = render([PoleSpec(color, 0.0, z)], pool, Camera(), seed=6)
        picks = pick_poles(vc.detect_colors(img, {})["blobs"])
        assert color in picks and on_pole(picks[color], t), f"{color} at {z} m, {pool}: {picks}"


# ---------- things that are not poles ----------

def test_grey_white_and_black_pipes_are_rarely_taken_for_a_pole():
    """Known limit, kept small: after the balance a grey / black / white object CLOSE to the camera looks
    warm (it has less blue water in front of it than the background). The red hue limit (8), the red
    brightness limit and yellow's saturation limit keep most of them out; tools/colors_bench.py measures
    ~9 % of worst-case frames (a pole-shaped pipe alone, 0.4..1.5 m away). The pilot sees the video."""
    false, n = 0, 0
    for pool, cam in CASES:
        for z in (0.4, 0.8, 1.5):
            for name in NEUTRALS:
                img, (t,) = render([PoleSpec(name, 0.0, z)], POOLS[pool], CAMERAS[cam], seed=pool + 40)
                picks = pick_poles(vc.detect_colors(img, {})["blobs"])
                false += any(on_pole(b, t) for b in picks.values())
                n += 1
    assert false / n <= 0.15, f"{false}/{n}"


def test_open_water_and_pool_walls_are_never_a_pole():
    for pool, cam in CASES:
        for wall in (None, 2.0, 6.0):
            img, _ = render([], POOLS[pool], CAMERAS[cam], seed=pool, wall_m=wall)
            assert vc.detect_colors(img, {})["blobs"] == [], f"{POOLS[pool]} {CAMERAS[cam]} wall={wall}"


def test_blue_pole_on_a_wall_of_the_same_blue_is_a_known_limit(monkeypatch):
    """A blue pole in front of a wall painted the same blue: no colour method can see it (it IS the
    background). It must be missed, not called another colour."""
    import underwater_sim
    monkeypatch.setattr(underwater_sim, "WALL_TILE", PAINT["blue"] * 0.9)
    img, truths = render(three_poles(1.5), Water(turbidity=0.03), Camera(), wall_m=3.0)
    res = score_frame(vc.detect_colors(img, {})["blobs"], truths)
    assert res["red"] == "ok" and res["yellow"] == "ok"
    assert res["blue"] in ("ok", "missed")


# ---------- the balance itself ----------

def test_balance_makes_the_water_grey_at_one_brightness_in_every_row():
    water = Water(turbidity=0.1, depth=1.0, gradient_m=1.5)
    for cam in (Camera(wb="locked", exposure=0.25), Camera(wb="auto", exposure=0.6)):
        img, _ = render([], water, cam)
        out = vc.balanced(img).astype(np.float64)
        rows = out.reshape(36, -1, 3).mean(axis=1)   # 36 bands down the picture
        assert np.abs(rows - vc.WATER_LEVEL).max() < 12, rows.round()
        hsv = cv2.cvtColor(vc.balanced(img), cv2.COLOR_BGR2HSV)
        assert np.percentile(hsv[..., 1], 99) <= 15


def test_balance_gains_shape_limits_and_the_result_fields():
    img, _ = render(three_poles(1.5), Water(), Camera())
    g = vc.balance_gains(img)
    assert g.shape == (vc.BALANCE_ROWS, 3)
    assert g.min() >= vc.BALANCE_GAIN[0] and g.max() <= vc.BALANCE_GAIN[1]
    black = np.zeros((90, 160, 3), np.uint8)
    assert np.all(vc.balance_gains(black) == vc.BALANCE_GAIN[1])   # nothing to balance: capped
    res = vc.detect_colors(img, {})
    assert len(res["balance"]) == vc.BALANCE_ROWS and all(len(r) == 3 for r in res["balance"])
    assert "balance" not in vc.detect_colors(img, {"balance": False})
    assert all({"sat", "widthFrac"} <= set(b) for b in res["blobs"])


def test_apply_gains_matches_a_plain_per_pixel_multiply():
    rng = np.random.default_rng(1)
    img = rng.integers(0, 256, (72, 128, 3), dtype=np.uint8)
    gains = np.tile([[0.8, 1.0, 2.0]], (vc.BALANCE_ROWS, 1))
    expect = np.clip(np.floor(img * np.array([0.8, 1.0, 2.0]) + 0.5), 0, 255)
    assert np.abs(vc.apply_gains(img, gains).astype(int) - expect).max() <= 1
