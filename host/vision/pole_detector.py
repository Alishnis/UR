"""Mission 5: find the red, yellow and blue poles by colour, and check whether the golf ball still sits on top.

Colour = HSV ranges, one per pole. Water absorbs red first and adds blue-green haze, so the ranges MUST be
calibrated in the real pool (mission5.py: click on a pole) and are saved to a JSON file. OpenCV hue is 0..179 and
red sits at both ends, so a range with h_lo > h_hi wraps around 0 (two masks).

Shape filter: a pole is a tall, narrow, mostly filled blob. The pool floor and walls are blue-ish too, so blue
needs a high minimum saturation and relies on the shape check.
"""
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

COLORS = ("red", "yellow", "blue")
LETTER = {"R": "red", "Y": "yellow", "B": "blue"}
DRAW_BGR = {"red": (0, 0, 255), "yellow": (0, 230, 255), "blue": (255, 120, 0)}
DEFAULT_FILE = Path(__file__).resolve().parent.parent / "pole_colors.json"


@dataclass
class ColorRange:
    h_lo: int
    h_hi: int  # h_lo > h_hi means the range wraps around 0 (red)
    s_lo: int
    v_lo: int

    def mask(self, hsv: np.ndarray) -> np.ndarray:
        s_v = (hsv[..., 1] >= self.s_lo) & (hsv[..., 2] >= self.v_lo)
        h = hsv[..., 0]
        hue = (h >= self.h_lo) & (h <= self.h_hi) if self.h_lo <= self.h_hi else (h >= self.h_lo) | (h <= self.h_hi)
        return (hue & s_v).astype(np.uint8)

    @classmethod
    def around(cls, hsv_pixel, hue_margin: int = 10) -> "ColorRange":
        """Range centred on a sampled pole colour (click calibration): generous below, since the far and the
        shaded side of the pole are darker and less saturated than the spot that was clicked."""
        h, s, v = (int(x) for x in hsv_pixel)
        return cls((h - hue_margin) % 180, (h + hue_margin) % 180, max(40, int(s * 0.55)), max(25, int(v * 0.45)))


def sample_hsv(frame: np.ndarray, x: int, y: int) -> np.ndarray:
    """Median HSV of a 7x7 spot (click calibration). Hue is circular (red sits at 0 and 179), so the median is
    taken with the hue shifted away from the wrap when the spot spans it."""
    hsv = cv2.cvtColor(frame[max(0, y - 3):y + 4, max(0, x - 3):x + 4], cv2.COLOR_BGR2HSV).reshape(-1, 3)
    h = hsv[:, 0].astype(np.int32)
    if h.max() - h.min() > 90:
        h = (h + 90) % 180
        return np.array([(int(np.median(h)) - 90) % 180, np.median(hsv[:, 1]), np.median(hsv[:, 2])])
    return np.median(hsv, axis=0)


def range_from_click(frame: np.ndarray, x: int, y: int, own_frac: float = 0.7,
                     max_area_frac: float = 0.08) -> ColorRange:
    """Click calibration: a generous range around the clicked colour, then the minimum saturation is raised until
    the blob under the click is pole-sized (not merged with the floor) and most of the mask. Needed for blue: the
    pool itself is blue, only less saturated."""
    h, s, v = (int(c) for c in sample_hsv(frame, x, y))
    r = ColorRange((h - 12) % 180, (h + 12) % 180, max(30, int(s * 0.4)), max(20, int(v * 0.35)))
    hsv = cv2.cvtColor(cv2.GaussianBlur(frame, (0, 0), 1.0), cv2.COLOR_BGR2HSV)
    while r.s_lo < s * 0.9:
        mask = r.mask(hsv)
        _, labels = cv2.connectedComponents(mask, connectivity=8)
        own = labels[y, x]
        if own == 0:
            break
        area = (labels == own).sum()
        if area >= own_frac * mask.sum() and area <= max_area_frac * mask.size:
            break
        r.s_lo += 8
    return r


def default_ranges() -> dict[str, ColorRange]:
    # starting guesses only (tuned on the simulator) - calibrate in the pool. Underwater yellow drifts towards
    # green (hue 40 -> 70 at 4 m) and red loses saturation fast; blue must be more saturated than the pool itself
    return {"red": ColorRange(158, 15, 50, 35), "yellow": ColorRange(25, 80, 100, 60),
            "blue": ColorRange(102, 128, 195, 30)}


def load_ranges(path: Path = DEFAULT_FILE) -> dict[str, ColorRange]:
    ranges = default_ranges()
    if Path(path).exists():
        data = json.loads(Path(path).read_text())
        ranges.update({k: ColorRange(**v) for k, v in data.items() if k in COLORS})
    return ranges


def save_ranges(ranges: dict[str, ColorRange], path: Path = DEFAULT_FILE) -> Path:
    Path(path).write_text(json.dumps({k: asdict(v) for k, v in ranges.items()}, indent=2))
    return Path(path)


@dataclass
class PoleConfig:
    work_width: int = 640  # detection runs on a downscaled copy (speed)
    min_area_frac: float = 0.0004  # smallest blob, fraction of the work image area
    min_elongation: float = 2.0  # visible height / width, unless the pole is cut by the image border
    min_fill: float = 0.55  # blob area / (height x width): a pole is a filled band, not a scatter
    max_slant_deg: float = 35.0  # vertical poles look slanted off-centre with a tilted camera, but not more
    ball_ratio: float = 0.85  # golf ball diameter / pole diameter (42.7 mm / ~50 mm pole - pole UNCONFIRMED)
    ball_contrast: float = 14.0  # BGR distance between the spot above the pole top and the background beside it


@dataclass
class Pole:
    """One detected pole, in full-frame pixels."""
    color: str
    top: np.ndarray  # top end of the visible pole axis (x, y)
    bottom: np.ndarray
    width_px: float  # median horizontal width
    area: float
    top_cut: bool  # the pole continues above the image top: its real top is not visible
    bottom_cut: bool
    ball: np.ndarray | None = None  # ball centre (x, y) if seen
    ball_px: float = 0.0  # ball diameter
    ball_checked: bool = False  # True if the spot above the top was visible, so "no ball" means something

    @property
    def mid(self) -> np.ndarray:
        return (self.top + self.bottom) / 2


@dataclass
class PoleDetection:
    poles: dict[str, Pole]  # best blob per colour
    masks: dict[str, np.ndarray] = field(default_factory=dict)  # work size, for the debug view
    scale: float = 1.0


class PoleDetector:
    def __init__(self, ranges: dict[str, ColorRange] | None = None, cfg: PoleConfig | None = None):
        self.ranges = ranges or default_ranges()
        self.cfg = cfg or PoleConfig()

    def detect(self, frame: np.ndarray) -> PoleDetection:
        cfg = self.cfg
        h, w = frame.shape[:2]
        scale = min(1.0, cfg.work_width / w)
        small = cv2.resize(frame, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA) \
            if scale < 1 else frame
        small = cv2.GaussianBlur(small, (0, 0), 1.0)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hh, ww = small.shape[:2]
        min_area = cfg.min_area_frac * hh * ww
        poles, masks = {}, {}
        for color in COLORS:
            mask = self.ranges[color].mask(hsv)
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 3), np.uint8))  # rejoin along the pole
            masks[color] = mask * 255
            best = None
            n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
            for i in np.argsort(-stats[1:, cv2.CC_STAT_AREA])[:8] + 1:
                area = stats[i, cv2.CC_STAT_AREA]
                if area < min_area:
                    break
                pole = self._pole_shape(labels == i, area, (ww, hh))
                if pole is not None:
                    best = pole
                    break  # largest pole-shaped blob of this colour
            if best is not None:
                best.color = color
                self._find_ball(small, best)
                poles[color] = _rescale(best, 1 / scale)
        return PoleDetection(poles, masks, scale)

    def _pole_shape(self, blob: np.ndarray, area: float, size) -> Pole | None:
        cfg = self.cfg
        ww, hh = size
        ys, xs = np.nonzero(blob)
        rows = np.unique(ys)
        if len(rows) < 3:
            return None
        # per-row extent and centre (rows are the natural slices of a near-vertical pole)
        counts = np.bincount(ys - rows[0])
        mins = np.full(len(counts), ww, np.int64)
        maxs = np.full(len(counts), -1, np.int64)
        np.minimum.at(mins, ys - rows[0], xs)
        np.maximum.at(maxs, ys - rows[0], xs)
        ok = counts > 0
        widths = (maxs - mins + 1)[ok].astype(np.float64)
        centres = ((mins + maxs) / 2)[ok]
        yy = np.arange(len(counts))[ok] + rows[0]
        med = float(np.median(widths))
        # mean of the typical rows (not the base plate or a ragged end): antialiased edges make single rows
        # +-1 px off, the mean over many rows is sub-pixel - matters, since far away the pole is only ~10 px wide
        typical = widths[(widths >= 0.6 * med) & (widths <= 1.4 * med)]
        width = float(typical.mean()) if len(typical) else med
        height = float(yy[-1] - yy[0] + 1)
        top_cut, bottom_cut = yy[0] <= 1, yy[-1] >= hh - 2
        if area / max(height * width, 1) < cfg.min_fill:
            return None
        # cut by the image border: only a stub may be visible (e.g. just under the ball when close)
        if height / max(width, 1) < (0.7 if top_cut or bottom_cut else cfg.min_elongation):
            return None
        a, b = np.polyfit(yy, centres, 1)  # x = a*y + b: the pole axis
        if abs(np.degrees(np.arctan(a))) > cfg.max_slant_deg:
            return None
        top = np.array([a * yy[0] + b, yy[0]], float)
        bottom = np.array([a * yy[-1] + b, yy[-1]], float)
        return Pole("", top, bottom, width, float(area), bool(top_cut), bool(bottom_cut))

    def _find_ball(self, img: np.ndarray, pole: Pole) -> None:
        """Is something sitting on the pole top? A white ball underwater looks light blue, much like the tiles
        behind it, so instead of "white" this asks: does the spot where the ball should be differ from the
        background just left and right of it? Only judged when all three spots are inside the image."""
        cfg = self.cfg
        hh, ww = img.shape[:2]
        d = max(pole.width_px * cfg.ball_ratio, 3.0)  # expected ball diameter
        r = max(1, int(round(d * 0.35)))  # half size of the sampled squares (inside the ball)
        cx, cy = pole.top[0], pole.top[1] - d / 2
        side = d * 1.6 + pole.width_px / 2
        spots = [(cx, cy), (cx - side, cy), (cx + side, cy)]
        if pole.top_cut or any(x - r < 0 or y - r < 0 or x + r + 1 > ww or y + r + 1 > hh for x, y in spots):
            return
        means = [img[int(y) - r:int(y) + r + 1, int(x) - r:int(x) + r + 1].reshape(-1, 3).mean(axis=0)
                 for x, y in spots]
        bg = (means[1] + means[2]) / 2
        diff = float(np.linalg.norm(means[0] - bg))
        sides = float(np.linalg.norm(means[1] - means[2]))  # uneven background (another pole, caustics)
        pole.ball_checked = True
        if diff > max(cfg.ball_contrast, 1.5 * sides):
            pole.ball, pole.ball_px = np.array([cx, cy]), d


def _rescale(p: Pole, k: float) -> Pole:
    p.top, p.bottom = p.top * k, p.bottom * k
    p.width_px *= k
    p.area *= k * k
    if p.ball is not None:
        p.ball, p.ball_px = p.ball * k, p.ball_px * k
    return p
