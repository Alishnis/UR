"""Pinhole camera intrinsics, needed to turn a tag in the image into a 3D distance/offset."""
import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

WATER_REFRACTIVE_INDEX = 1.333


@dataclass
class CameraModel:
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int
    dist: list[float] = field(default_factory=list)  # OpenCV distortion coefficients, empty = none

    @classmethod
    def from_hfov(cls, width: int, height: int, hfov_deg: float) -> "CameraModel":
        """Rough model when no calibration exists: square pixels, centred principal point."""
        f = (width / 2) / math.tan(math.radians(hfov_deg) / 2)
        return cls(f, f, width / 2, height / 2, width, height)

    @classmethod
    def load(cls, path: str | Path) -> "CameraModel":
        data = json.loads(Path(path).read_text())
        return cls(**{k: data[k] for k in ("fx", "fy", "cx", "cy", "width", "height")}, dist=data.get("dist", []))

    def save(self, path: str | Path, **extra) -> None:
        Path(path).write_text(json.dumps({**asdict(self), **extra}, indent=2))

    def scaled_to(self, width: int, height: int) -> "CameraModel":
        if (width, height) == (self.width, self.height):
            return self
        sx, sy = width / self.width, height / self.height
        return CameraModel(self.fx * sx, self.fy * sy, self.cx * sx, self.cy * sy, width, height, list(self.dist))

    def in_water(self, n: float = WATER_REFRACTIVE_INDEX) -> "CameraModel":
        """Approximation for a camera calibrated in air behind a flat port: water magnifies by ~n.
        Calibrating directly underwater is better."""
        return CameraModel(self.fx * n, self.fy * n, self.cx, self.cy, self.width, self.height, list(self.dist))

    @property
    def params(self) -> tuple[float, float, float, float]:
        return self.fx, self.fy, self.cx, self.cy

    @property
    def K(self) -> np.ndarray:
        return np.array([[self.fx, 0, self.cx], [0, self.fy, self.cy], [0, 0, 1]], np.float64)

    @property
    def hfov_deg(self) -> float:
        return math.degrees(2 * math.atan(self.width / 2 / self.fx))

    @property
    def vfov_deg(self) -> float:
        return math.degrees(2 * math.atan(self.height / 2 / self.fy))

    def project(self, pts_cam: np.ndarray) -> np.ndarray:
        """Nx3 camera-frame points (x right, y down, z forward, z > 0) -> Nx2 pixels."""
        pts = np.asarray(pts_cam, np.float64).reshape(-1, 3)
        return np.stack([self.fx * pts[:, 0] / pts[:, 2] + self.cx, self.fy * pts[:, 1] / pts[:, 2] + self.cy], axis=1)


class Undistorter:
    """Removes lens distortion so the pinhole model (used by the tag pose) holds."""

    def __init__(self, cam: CameraModel):
        self._maps = None
        if cam.dist and any(abs(c) > 1e-9 for c in cam.dist):
            self._maps = cv2.initUndistortRectifyMap(
                cam.K, np.array(cam.dist), None, cam.K, (cam.width, cam.height), cv2.CV_16SC2)

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        if self._maps is None:
            return frame
        return cv2.remap(frame, self._maps[0], self._maps[1], cv2.INTER_LINEAR)
