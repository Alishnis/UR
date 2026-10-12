"""Degrade camera frames to roughly imitate pool conditions, for testing vision on land."""
from dataclasses import asdict, dataclass, fields

import cv2
import numpy as np

WATER_BGR = np.array([120, 100, 40], np.float32)  # blue-green backscatter colour


@dataclass
class SimParams:
    tint: int = 0  # 0..100, how much red/green is absorbed
    haze: int = 0  # 0..100, blend towards water colour (turbidity, contrast loss)
    dark: int = 0  # 0..100, brightness loss
    blur: int = 0  # 0..10, gaussian sigma in px
    motion: int = 0  # 0..40, horizontal motion blur length in px
    noise: int = 0  # 0..40, sensor noise std
    resolution: int = 100  # 20..100, % of resolution kept (lost detail)


LIMITS = {"tint": 100, "haze": 100, "dark": 100, "blur": 10, "motion": 40, "noise": 40, "resolution": 100}
MIN_RESOLUTION = 20

PRESETS = {
    "clear": SimParams(tint=30, haze=15, dark=15, blur=1, motion=0, noise=4, resolution=100),
    "murky": SimParams(tint=60, haze=45, dark=40, blur=2, motion=5, noise=10, resolution=70),
    "bad": SimParams(tint=85, haze=70, dark=60, blur=4, motion=20, noise=20, resolution=50),
}


def preset_name(p: SimParams) -> str:
    return next((name for name, preset in PRESETS.items() if preset == p), "custom")


def degrade(frame: np.ndarray, p: SimParams, rng: np.random.Generator | None = None) -> np.ndarray:
    if p == SimParams():
        return frame
    rng = rng or np.random.default_rng()
    f = frame.astype(np.float32)
    if p.tint:
        t = p.tint / 100
        f *= np.array([1.0, 1 - 0.3 * t, 1 - 0.75 * t], np.float32)
    if p.haze:
        h = p.haze / 100
        f = f * (1 - h) + WATER_BGR * h
    if p.dark:
        f *= 1 - p.dark / 100
    img = np.clip(f, 0, 255).astype(np.uint8)

    if p.blur:
        img = cv2.GaussianBlur(img, (0, 0), p.blur)
    if p.motion > 1:
        kernel = np.zeros((p.motion, p.motion), np.float32)
        kernel[p.motion // 2, :] = 1 / p.motion
        img = cv2.filter2D(img, -1, kernel)
    res = max(p.resolution, MIN_RESOLUTION)
    if res < 100:
        h, w = img.shape[:2]
        small = cv2.resize(img, (w * res // 100, h * res // 100), interpolation=cv2.INTER_AREA)
        img = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    if p.noise:
        img = np.clip(img + rng.normal(0, p.noise, img.shape), 0, 255).astype(np.uint8)
    return img


class SimControls:
    """OpenCV trackbar window to tune SimParams live."""

    WINDOW = "Underwater sim"

    def __init__(self, initial: SimParams):
        self._last = initial
        self._open(initial)

    def _open(self, p: SimParams) -> None:
        cv2.namedWindow(self.WINDOW, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(self.WINDOW, 420, 330)
        for name, value in asdict(p).items():
            cv2.createTrackbar(name, self.WINDOW, value, LIMITS[name], lambda _v: None)

    def read(self) -> SimParams:
        try:
            self._last = SimParams(**{f.name: cv2.getTrackbarPos(f.name, self.WINDOW) for f in fields(SimParams)})
        except cv2.error:
            pass  # window was closed by the user: keep the last values
        return self._last

    def set(self, p: SimParams) -> None:
        self._last = p
        try:
            for name, value in asdict(p).items():
                cv2.setTrackbarPos(name, self.WINDOW, value)
        except cv2.error:
            self._open(p)
