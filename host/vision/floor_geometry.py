"""Pixel <-> pool floor mapping for a level ROV whose camera is pitched down by a fixed angle.

Floor coordinates: X right, Y forward, origin on the floor straight below the camera, in units of the camera
height above the floor (multiply by the height in metres). We have no depth sensor, so the height is either
estimated from the known line width or guessed - but directions on the floor (heading error) do not depend on it.
"""
import math

import numpy as np

from vision.camera_model import CameraModel

MIN_DIP_DEG = 2.0  # rays closer than this to the horizon hit the floor too far away to be useful


class FloorProjector:
    def __init__(self, cam: CameraModel, tilt_deg: float):
        a = math.radians(tilt_deg)
        self.cam = cam
        # camera frame (x right, y down, z optical axis) -> level frame (x right, y down, z forward horizontal)
        self.R = np.array([[1, 0, 0], [0, math.cos(a), math.sin(a)], [0, -math.sin(a), math.cos(a)]])
        self._Kinv = np.linalg.inv(cam.K)
        self._min_dip = math.sin(math.radians(MIN_DIP_DEG))

    def to_floor(self, px) -> np.ndarray:
        """Nx2 pixels -> Nx2 floor points (height units). NaN for pixels at or above the horizon."""
        px = np.asarray(px, np.float64).reshape(-1, 2)
        d = np.c_[px, np.ones(len(px))] @ self._Kinv.T @ self.R.T
        out = np.full((len(px), 2), np.nan)
        ok = d[:, 1] > self._min_dip * np.linalg.norm(d, axis=1)
        out[ok] = d[ok][:, [0, 2]] / d[ok, 1:2]
        return out

    def to_image(self, floor) -> np.ndarray:
        """Nx2 floor points (height units) -> Nx2 pixels. NaN for points behind the camera."""
        f = np.asarray(floor, np.float64).reshape(-1, 2)
        pc = np.c_[f[:, 0], np.ones(len(f)), f[:, 1]] @ self.R  # level -> camera
        out = np.full((len(f), 2), np.nan)
        ok = pc[:, 2] > 1e-3
        out[ok] = self.cam.project(pc[ok])
        return out

    def nearest_visible(self) -> float:
        """Floor distance (height units) ahead of the camera seen by the bottom-centre pixel."""
        return float(self.to_floor([[self.cam.cx, self.cam.height - 1]])[0, 1])
