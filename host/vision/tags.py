"""Missions 2.1 / 2.2: tag36h11 AprilTags and, when the camera FOV is known, where the tag is.

A wrong id costs the whole mission, a missed tag only costs time, so: at most maxHamming corrected bits
(tag36h11 codes differ in >= 11 bits, so 1 corrected bit is still practically never a wrong id) and a
decision margin of at least minMargin; the browser also asks for several sightings before it trusts an id.

Two passes, measured on hard synthetic frames (small, tilted, blurred, low-contrast tags):
1. raw grey, no pre-blur (quad_sigma 0): finds small/far tags clearly more often than a blurred pass;
2. only when pass 1 found fewer than `expect` tags: CLAHE (local contrast boost, raises the margin of
   faint tags 2-3x, helps in murky water) with a light pre-blur against sensor noise on big tags.
Results are merged by id, keeping the sighting with the higher margin. Candidates that fail the filters
come back as "weak" so the GUI can show "seen, not trusted" instead of nothing.
Ported from the team's earlier vision/apriltag_detector.py.
"""

from __future__ import annotations

import math
import threading

import cv2
import numpy as np
from pupil_apriltags import Detector

from vision.frames import param_bool, param_int, param_number, round1, round3, round_point, round_points

TAG_FAMILY = "tag36h11"
# apriltag decimates by whole factors or by the special 1.5: other values would only add cached detectors
DECIMATE_STEPS = (1.0, 1.5, 2.0, 3.0, 4.0)
DETECTOR_THREADS = 2  # the bridge runs 2 vision workers: more threads per detector only oversubscribe
# the wrong (mirror) pose solution must fit the corners this many times worse for the yaw sign to be trusted
YAW_AMBIGUITY_RATIO = 2.0
# pupil-apriltags 1.0.4 SEGFAULTS (kills the bridge) on images only a few px high (< 3 px, < 9 px with
# decimate 4); a tag needs ~20 px anyway
MIN_IMAGE_PX = 32

# quad_sigma (Gaussian pre-blur before finding edges) per pass: none for the raw pass (small tags),
# light for the CLAHE pass (CLAHE also boosts sensor noise)
RAW_SIGMA = 0.0
CLAHE_SIGMA = 0.8
MAX_WEAK = 10

# pupil-apriltags Detector is NOT thread-safe: one per (decimate, sigma), each with its own lock
_detectors: dict[tuple[float, float], tuple[Detector, threading.Lock]] = {}
_detectors_lock = threading.Lock()
_local = threading.local()  # cv2 CLAHE keeps work buffers inside the object: one per thread


def tags_params(params: dict) -> dict:
    decimate = param_number(params, "decimate", 1.0, 1.0, 4.0)
    return {
        "clahe": param_bool(params, "clahe", True),  # allow the CLAHE pass
        "minMargin": param_number(params, "minMargin", 10.0, 0.0, 200.0),
        "maxHamming": param_int(params, "maxHamming", 1, 0, 2),
        "expect": param_int(params, "expect", 3, 0, 20),  # fewer found -> run the CLAHE pass
        "decimate": min(DECIMATE_STEPS, key=lambda s: abs(s - decimate)),
        "tagSizeM": param_number(params, "tagSizeM", 0.162, 0.01, 2.0),
        "hfovDeg": param_number(params, "hfovDeg", None, 20.0, 170.0),  # null = no pose
    }


def _detector(decimate: float, sigma: float) -> tuple[Detector, threading.Lock]:
    with _detectors_lock:
        entry = _detectors.get((decimate, sigma))
        if entry is None:
            det = Detector(
                families=TAG_FAMILY,
                nthreads=DETECTOR_THREADS,
                quad_decimate=decimate,
                quad_sigma=sigma,
                refine_edges=1,
                decode_sharpening=0.25,
            )
            entry = _detectors[(decimate, sigma)] = (det, threading.Lock())
        return entry


def _run(gray: np.ndarray, decimate: float, sigma: float) -> list:
    detector, lock = _detector(decimate, sigma)
    with lock:
        return detector.detect(gray)


def _clahe() -> cv2.CLAHE:
    clahe = getattr(_local, "clahe", None)
    if clahe is None:
        clahe = _local.clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    return clahe


def camera_matrix(w: int, h: int, hfov_deg: float) -> np.ndarray:
    """Pinhole model from the horizontal FOV only: square pixels, centred, no distortion."""
    f = (w / 2) / math.tan(math.radians(hfov_deg) / 2)
    return np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1]], np.float64)


def tag_pose(corners: np.ndarray, K: np.ndarray, size_m: float) -> dict | None:
    """Tag centre in the camera frame (x right, y down, z forward, metres) and its yaw.

    yawDeg: angle about the vertical (camera y) axis between the tag's normal and the line from the tag to
    the camera; 0 = the tag faces the camera squarely. POSITIVE = the ROV is to the RIGHT of the tag's
    centre line (seen from the ROV), so the operator must yaw/move LEFT to get in front of it; the right
    edge of the tag then looks taller (nearer) than the left one. Only the tag's normal is used, so the
    sign does not depend on how the tag is turned within its plane. Assumes the ROV is roughly level.

    yawOk (extra field): False when the two mirror-image pose solutions of a flat square fit the corners
    almost equally well - typical for small, far or nearly square-on tags - so the yaw SIGN is a guess.
    """
    s = size_m / 2
    # pupil-apriltags corner order (counter-clockwise on screen) matches SOLVEPNP_IPPE_SQUARE's points
    obj = np.array([[-s, s, 0], [s, s, 0], [s, -s, 0], [-s, -s, 0]], np.float64)
    n_sol, rvecs, tvecs, errs = cv2.solvePnPGeneric(obj, corners.astype(np.float64), K, None,
                                                    flags=cv2.SOLVEPNP_IPPE_SQUARE)
    if not n_sol:
        return None
    t = tvecs[0].reshape(3)  # solutions come sorted by reprojection error
    if not np.all(np.isfinite(t)) or t[2] <= 0:
        return None
    n = cv2.Rodrigues(rvecs[0])[0][:, 2]
    if n @ t > 0:
        n = -n  # normal pointing out of the tag's face, towards the camera
    # signed angle in the horizontal (x, z) plane from the normal to the tag->camera direction (-t)
    yaw = math.degrees(math.atan2(t[0] * n[2] - t[2] * n[0], -(t[0] * n[0] + t[2] * n[2])))
    e = np.asarray(errs, np.float64).ravel()
    yaw_ok = bool(len(e) < 2 or e[1] >= YAW_AMBIGUITY_RATIO * max(e[0], 1e-3))
    return {"x": round3(t[0]), "y": round3(t[1]), "z": round3(t[2]), "dist": round3(np.linalg.norm(t)),
            "yawDeg": round1(yaw), "yawOk": yaw_ok}


def detect_tags(bgr: np.ndarray, params: dict) -> dict:
    """Result fields for mode "tags": {"tags": [{id, corners, center, margin, pose}]} sorted by id, and
    "weak": [{id, corners, center, margin, hamming}] - seen but below minMargin / above maxHamming (never
    counted, display only). corners: pupil-apriltags order, counter-clockwise on screen, always starting at
    the same physical corner of the tag."""
    p = tags_params(params)
    h, w = bgr.shape[:2]
    if min(h, w) < MIN_IMAGE_PX:
        return {"tags": [], "weak": []}
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else np.ascontiguousarray(bgr)

    def usable(r) -> bool:
        return r.hamming <= p["maxHamming"] and r.decision_margin >= p["minMargin"]

    # best sighting per id over the passes (corners must be finite: the C code can return NaN on junk)
    best: dict[int, object] = {}
    def collect(raw) -> None:
        for r in raw:
            if r.hamming > 2 or not np.all(np.isfinite(np.asarray(r.corners, np.float64))):
                continue
            old = best.get(int(r.tag_id))
            key = (usable(r), -r.hamming, r.decision_margin)
            if old is None or key > (usable(old), -old.hamming, old.decision_margin):
                best[int(r.tag_id)] = r

    collect(_run(gray, p["decimate"], RAW_SIGMA))
    if p["clahe"] and sum(usable(r) for r in best.values()) < p["expect"]:
        collect(_run(_clahe().apply(gray), p["decimate"], CLAHE_SIGMA))

    K = camera_matrix(w, h, p["hfovDeg"]) if p["hfovDeg"] is not None else None
    tags, weak = [], []
    for tag_id, r in best.items():
        corners = np.asarray(r.corners, np.float64)
        if not usable(r):
            weak.append({"id": tag_id, "corners": round_points(corners), "center": round_point(r.center),
                         "margin": round1(r.decision_margin), "hamming": int(r.hamming)})
            continue
        tags.append({
            "id": tag_id,
            "corners": round_points(corners),
            "center": round_point(r.center),
            "margin": round1(r.decision_margin),
            "pose": tag_pose(corners, K, p["tagSizeM"]) if K is not None else None,
        })
    tags.sort(key=lambda t: (t["id"], t["center"][0], t["center"][1]))
    weak.sort(key=lambda t: -t["margin"])
    return {"tags": tags, "weak": weak[:MAX_WEAK]}
