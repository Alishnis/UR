from dataclasses import dataclass

import cv2
import numpy as np
from pupil_apriltags import Detector

from vision.camera_model import CameraModel

TAG_FAMILY = "tag36h11"
TAG_SIZE_M = 0.162

# Tag corners in the tag frame (x left, y up, z into the tag - pupil-apriltags convention) in the order
# pupil-apriltags returns image corners; this is also the order SOLVEPNP_IPPE_SQUARE expects.
_H = TAG_SIZE_M / 2
TAG_OBJECT_POINTS = np.array([[-_H, _H, 0], [_H, _H, 0], [_H, -_H, 0], [-_H, -_H, 0]], np.float64)


@dataclass
class Detection:
    id: int
    corners: np.ndarray  # 4x2 float, pixel coordinates
    center: np.ndarray  # 2 float
    margin: float
    # filled only when a camera model is given: tag pose in the camera frame (x right, y down, z forward)
    R: np.ndarray | None = None  # 3x3, columns = tag x (left), y (up), z (into the tag) axes, seen from the front
    t: np.ndarray | None = None  # 3, tag centre in metres


@dataclass
class DetectorConfig:
    quad_decimate: float = 1.0
    # Gaussian blur before finding tag edges: without it sensor noise breaks the edges of big, low-contrast tags
    quad_sigma: float = 0.8
    # decision margin grows with image contrast: murky water drops it to ~20 even for a perfectly read tag.
    # A wrong ID is still very unlikely: zero bit errors are required and a tag must be seen in several frames
    min_margin: float = 20.0
    use_clahe: bool = True  # local contrast boost: raises the margin 2-3x in murky water, harmless in clear water
    nthreads: int = 4


class TagDetector:
    def __init__(self, cfg: DetectorConfig | None = None):
        self.cfg = cfg or DetectorConfig()
        self._detector = Detector(
            families=TAG_FAMILY,
            nthreads=self.cfg.nthreads,
            quad_decimate=self.cfg.quad_decimate,
            quad_sigma=self.cfg.quad_sigma,
            refine_edges=1,
            decode_sharpening=0.25,
        )
        self._clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    def preprocess(self, frame: np.ndarray) -> np.ndarray:
        gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if self.cfg.use_clahe:
            gray = self._clahe.apply(gray)
        return gray

    def detect(self, frame: np.ndarray, camera: CameraModel | None = None) -> list[Detection]:
        gray = self.preprocess(frame)
        results = []
        for r in self._detector.detect(gray):
            # hamming > 0 means bit errors were corrected: too risky, a wrong ID costs the whole mission
            if r.hamming != 0 or r.decision_margin < self.cfg.min_margin:
                continue
            det = Detection(int(r.tag_id), np.asarray(r.corners), np.asarray(r.center), float(r.decision_margin))
            if camera is not None:
                det.R, det.t = estimate_pose(det.corners, camera)
            results.append(det)
        return results


def estimate_pose(corners: np.ndarray, camera: CameraModel) -> tuple[np.ndarray, np.ndarray]:
    # frames are undistorted before detection, so no distortion coefficients here
    _, rvec, tvec = cv2.solvePnP(TAG_OBJECT_POINTS, corners.astype(np.float64), camera.K, None,
                                 flags=cv2.SOLVEPNP_IPPE_SQUARE)
    return cv2.Rodrigues(rvec)[0], tvec.reshape(3)
