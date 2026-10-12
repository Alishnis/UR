"""Shared helpers for the operator windows (text, frame sources, screenshots)."""
import sys
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

FRAME_HEIGHT = 720  # the ROV camera is 720p, so every source is scaled to this to keep tuning comparable
CAPTURE_DIR = Path(__file__).resolve().parent / "captures"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp"}

GREEN = (0, 220, 0)
ORANGE = (0, 165, 255)
MAGENTA = (255, 0, 255)
YELLOW = (0, 255, 255)
RED = (0, 0, 255)
WHITE = (255, 255, 255)
GREY = (180, 180, 180)
CYAN = (255, 255, 0)


def put_text(img, text, org, scale, color, thick=2):
    # shadow instead of a thicker outline: in OpenCV 5 glyph width grows with thickness, so outlines smear
    org = (int(org[0]), int(org[1]))
    cv2.putText(img, text, (org[0] + 2, org[1] + 2), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), thick, cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, thick, cv2.LINE_AA)


def shade_rect(img, p1, p2, alpha=0.55):
    """Darken a rectangle in place so text on top stays readable."""
    x1, y1 = max(p1[0], 0), max(p1[1], 0)
    x2, y2 = min(p2[0], img.shape[1]), min(p2[1], img.shape[0])
    if x2 > x1 and y2 > y1:
        img[y1:y2, x1:x2] = (img[y1:y2, x1:x2] * (1 - alpha)).astype(np.uint8)


def fit_height(frame: np.ndarray, height: int = FRAME_HEIGHT) -> np.ndarray:
    h, w = frame.shape[:2]
    if h == height:
        return frame
    return cv2.resize(frame, (round(w * height / h), height), interpolation=cv2.INTER_AREA)


def save_capture(img: np.ndarray, prefix: str) -> Path:
    CAPTURE_DIR.mkdir(exist_ok=True)
    path = CAPTURE_DIR / f"{prefix}_{datetime.now():%Y%m%d_%H%M%S}.png"
    cv2.imwrite(str(path), img)
    return path


class FrameSource:
    """Camera index, stream URL, video file or a still image (looped)."""

    def __init__(self, source: str):
        self._still = None
        self._cap = None
        if Path(source).suffix.lower() in IMAGE_EXTS:
            self._still = cv2.imread(source)
            if self._still is None:
                sys.exit(f"Cannot read image {source}")
        elif source.isdigit():
            backend = cv2.CAP_AVFOUNDATION if sys.platform == "darwin" else cv2.CAP_ANY
            self._cap = cv2.VideoCapture(int(source), backend)
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        else:
            self._cap = cv2.VideoCapture(source)
        if self._cap is not None and not self._cap.isOpened():
            sys.exit(f"Cannot open source {source!r}. Try: python -m tools.list_cameras")

    def read(self):
        if self._still is not None:
            return True, self._still.copy()
        return self._cap.read()

    def release(self):
        if self._cap is not None:
            self._cap.release()
