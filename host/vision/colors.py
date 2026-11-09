"""Mission 5 and general colour detection: blobs of calibrated HSV colours (the red, yellow and blue poles).

A colour is an HSV range in the OpenCV 8-bit convention (H 0..179, S and V 0..255). Water absorbs red
first and adds blue-green haze, so the ranges MUST be calibrated in the pool (GUI: click on the pole);
the defaults are air values. A hue range with lo > hi wraps through 0 (red: [170, 10]). The pool itself
is blue, so blue needs a high minimum saturation. Same default numbers as DEFAULT_COLORS in
webgui/js/colors.js.
"""

from __future__ import annotations

import copy
import re

import cv2
import numpy as np

from vision.frames import mask_data_url, param_bool, param_int, param_number, round1

WORK_WIDTH = 640  # detection runs on a copy at most this wide; coordinates are scaled back
MAX_COLORS = 6
NAME_RE = re.compile(r"[a-z0-9_-]{1,16}")
# Ranges AFTER the water-colour balance (water = grey, S <= ~10), chosen on physics-based pool frames
# (tests/underwater_sim.py, tools/colors_bench.py). Red poles stay at H 2..9 out to 3 m. The upper limit
# is 8, not more, because grey / black / white things close to the camera turn orange after the balance
# (H 9..17: they have less blue water in front of them than the background): above 8 they would be "red".
# For the same reason yellow needs S >= 70 (white things turn pale yellow, S < 75), and red V >= 130:
# the water is at V 160 after the balance, a red pole is about as bright as the water or brighter
# (V >= ~140 out to 4 m), a black weight or the tether is much darker (V ~ 80..120).
DEFAULT_COLORS = {
    "red": {"h": [170, 8], "s": [45, 255], "v": [130, 255]},
    "yellow": {"h": [18, 34], "s": [70, 255], "v": [80, 255]},
    "blue": {"h": [95, 135], "s": [20, 255], "v": [40, 255]},
}
_OPEN = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))  # drops speckle
_CLOSE = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))  # fills small holes (glare, the ball's shadow)


def _int_pair(raw: dict, key: str, top: int) -> list[int] | None:
    v = raw.get(key)
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        return None
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or x != x for x in v):
        return None
    # ints first clamped as ints: float() of a huge JSON int would overflow
    return [int(round(min(max(float(min(max(x, 0), top)), 0.0), top))) for x in v]


def sanitize_color(raw: object) -> dict | None:
    """{"h": [lo, hi], "s": [lo, hi], "v": [lo, hi]} with ints clamped to range, or None if malformed.
    Only hue may wrap (lo > hi); S and V pairs are put in order."""
    if not isinstance(raw, dict):
        return None
    h, s, v = _int_pair(raw, "h", 179), _int_pair(raw, "s", 255), _int_pair(raw, "v", 255)
    if h is None or s is None or v is None:
        return None
    return {"h": h, "s": sorted(s), "v": sorted(v)}


def colors_params(params: dict) -> dict:
    colors: dict[str, dict] = {}
    raw = params.get("colors")
    if isinstance(raw, dict):
        for name, rng in raw.items():
            if len(colors) >= MAX_COLORS:
                break
            if not isinstance(name, str) or not NAME_RE.fullmatch(name):
                continue
            # a known colour with a broken range falls back to its default; an unknown one is dropped
            c = sanitize_color(rng) or copy.deepcopy(DEFAULT_COLORS.get(name))
            if c is not None:
                colors[name] = c
    if not colors:
        colors = copy.deepcopy(DEFAULT_COLORS)
    mask = params.get("mask")
    return {
        "colors": colors,
        "minAreaFrac": param_number(params, "minAreaFrac", 0.0008, 0.0, 0.5),
        "maxBlobs": param_int(params, "maxBlobs", 3, 1, 10),
        "mask": mask if isinstance(mask, str) and mask in colors else None,
        "balance": param_bool(params, "balance", True),
    }


BALANCE_GAIN = (0.5, 4.0)  # per-channel gain limits of the water-colour balance
BALANCE_W, BALANCE_ROWS = 64, 36  # the water colour is measured on a copy this small
WATER_LEVEL = 160.0  # the water's B, G and R after the balance


def balance_gains(bgr: np.ndarray) -> np.ndarray:
    """Per-row gains, shape (rows, 3) in B, G, R order, that turn the WATER grey.

    The water colour of a row is the median of each channel along that row: the poles are thin and
    vertical, so most of every row is water. Per row because the water colour changes down the picture
    (bright and green towards the surface, dark blue towards the deep floor). Each row is scaled so its
    water has equal B, G and R at its own brightness; limits BALANCE_GAIN. rows = BALANCE_ROWS, smoothed
    over 3 rows; apply_gains stretches them over the image height.

    The water is also brought to the same brightness, WATER_LEVEL, in every row and every picture, so the
    V limits mean "this much darker / brighter than the water" whatever the camera's exposure does."""
    small = cv2.resize(bgr, (BALANCE_W, BALANCE_ROWS), interpolation=cv2.INTER_AREA)
    med = np.median(small.astype(np.float64), axis=1)                       # (rows, 3)
    med = cv2.blur(med[:, None, :], (1, 3), borderType=cv2.BORDER_REPLICATE)[:, 0, :]
    gains = WATER_LEVEL / np.maximum(med, 1.0)
    return np.clip(gains, *BALANCE_GAIN)


def apply_gains(bgr: np.ndarray, gains: np.ndarray) -> np.ndarray:
    """bgr * per-row gains (balance_gains), rows interpolated over the image height, 0..255."""
    h = bgr.shape[0]
    g = cv2.resize(np.asarray(gains, np.float32)[:, None, :], (1, h), interpolation=cv2.INTER_LINEAR)
    out = bgr.astype(np.float32) * g  # (h, 1, 3) broadcasts over the width
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def balanced(bgr: np.ndarray) -> np.ndarray:
    """The frame with the water colour taken out (see balance_gains)."""
    return apply_gains(bgr, balance_gains(bgr))


def color_mask(hsv: np.ndarray, rng: dict) -> np.ndarray:
    """uint8 0/255 mask of the pixels inside one HSV range (two ranges when the hue wraps through 0)."""
    (h0, h1), (s0, s1), (v0, v1) = rng["h"], rng["s"], rng["v"]
    if h0 <= h1:
        return cv2.inRange(hsv, (h0, s0, v0), (h1, s1, v1))
    return cv2.inRange(hsv, (h0, s0, v0), (179, s1, v1)) | cv2.inRange(hsv, (0, s0, v0), (h1, s1, v1))


def detect_colors(bgr: np.ndarray, params: dict) -> dict:
    """Result fields for mode "colors": {"blobs": [...]} sorted by area, biggest first (+ "mask")."""
    p = colors_params(params)
    h, w = bgr.shape[:2]
    ww = min(WORK_WIDTH, w)
    hh = max(1, round(h * ww / w))
    small = cv2.resize(bgr, (ww, hh), interpolation=cv2.INTER_AREA) if (ww, hh) != (w, h) else bgr
    if small.ndim == 2:
        small = cv2.cvtColor(small, cv2.COLOR_GRAY2BGR)
    gains = balance_gains(small) if p["balance"] else None
    if gains is not None:
        small = apply_gains(small, gains)
    hsv = cv2.cvtColor(cv2.GaussianBlur(small, (3, 3), 0), cv2.COLOR_BGR2HSV)
    sx, sy = w / ww, h / hh  # work px -> JPEG px
    work_area = ww * hh
    min_area = max(1.0, p["minAreaFrac"] * work_area)
    blobs = []
    mask_url = None
    for name, rng in p["colors"].items():
        m = cv2.morphologyEx(color_mask(hsv, rng), cv2.MORPH_OPEN, _OPEN)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, _CLOSE)
        if name == p["mask"]:
            mask_url = mask_data_url(m)
        n, labels, stats, cents = cv2.connectedComponentsWithStats(m, connectivity=8)
        order = np.argsort(-stats[1:, cv2.CC_STAT_AREA], kind="stable") + 1
        for i in order[:p["maxBlobs"]]:
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area < min_area:
                break
            x, y, bw, bh = (int(v) for v in stats[i, :4])
            box_w, box_h = bw * sx, bh * sy
            sat = float(cv2.mean(hsv[y:y + bh, x:x + bw, 1], mask=(labels[y:y + bh, x:x + bw] == i).astype(np.uint8))[0])
            blobs.append({
                "color": name,
                "box": [round1(x * sx), round1(y * sy), round1(box_w), round1(box_h)],
                "center": [round1((cents[i][0] + 0.5) * sx - 0.5), round1((cents[i][1] + 0.5) * sy - 0.5)],
                "area": round1(area * sx * sy),
                "areaFrac": round(area / work_area, 6),
                "aspect": round(box_h / box_w, 3),
                "fill": round(area / (bw * bh), 3),
                "sat": round1(sat),  # mean saturation of the blob (after the balance)
                "widthFrac": round(bw / ww, 4),
            })
    blobs.sort(key=lambda b: -b["area"])
    result: dict = {"blobs": blobs}
    if gains is not None:
        result["balance"] = [[round(float(g), 3) for g in row] for row in gains]
    if p["mask"] is not None:
        result["mask"] = mask_url
    return result
