"""Synthetic camera frames for the vision tests: AprilTags, the Mission 3 line, the Mission 5 poles.

Everything is drawn from known geometry, so a test can compare a detection with the truth. Pool-like
damage (blue-green water, uneven light, blur, sensor noise, JPEG) is added on purpose: the detectors
must work on frames like these, not only on clean renders.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass, field

import cv2
import numpy as np

# tag36h11, 8x8 cells including the black border, '1' = white (rows top to bottom). Verified with
# pupil-apriltags; rendered with one extra white cell of quiet zone all around (10x10 cells).
TAG_BITS = {
    17: "00000000 00011000 01000110 00110110 00111010 01100000 00101100 00000000",
    245: "00000000 01110000 01001010 00001000 01011100 01011010 00110000 00000000",
    503: "00000000 00111000 00100000 00001100 01011110 00000110 01110100 00000000",
}
TAG_IDS = (17, 245, 503)

WATER_BGR = (160, 145, 100)  # hazy cyan seen sideways: less saturated than a blue pole (default blue s >= 150)
FLOOR_BGR = (190, 150, 95)  # painted blue pool floor
LINE_BGR = (40, 38, 34)
TAPE_BGR = (232, 232, 225)
POLE_BGR = {"red": (40, 30, 190), "yellow": (40, 200, 220), "blue": (190, 80, 20)}


# ---------- generic ----------

def jpeg_bytes(img: np.ndarray, quality: int = 80) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return buf.tobytes()


def jpeg_roundtrip(img: np.ndarray, quality: int = 80) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(jpeg_bytes(img, quality), np.uint8), cv2.IMREAD_COLOR)


def frame_message(header: dict, jpeg: bytes) -> bytes:
    """Browser -> service binary message: uint32 BE header length, JSON header, JPEG."""
    raw = json.dumps(header).encode()
    return struct.pack(">I", len(raw)) + raw + jpeg


def water(w: int, h: int, seed: int = 0, bgr=WATER_BGR) -> np.ndarray:
    """Open water: brighter towards the surface (top), slow light blotches."""
    rng = np.random.default_rng(seed)
    y = np.linspace(1.15, 0.8, h, dtype=np.float32)[:, None, None]
    blotch = cv2.resize(rng.normal(0, 1, (6, 10)).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
    img = np.asarray(bgr, np.float32) * y * (1 + 0.05 * blotch[..., None])
    return np.clip(img, 0, 255).astype(np.uint8)


def light_gradient(img: np.ndarray, lo: float, hi: float, axis: int = 1) -> np.ndarray:
    """Uneven light: brightness scaled from lo (left/top) to hi (right/bottom)."""
    n = img.shape[axis]
    g = np.linspace(lo, hi, n, dtype=np.float32)
    g = g[None, :, None] if axis == 1 else g[:, None, None]
    return np.clip(img.astype(np.float32) * g, 0, 255).astype(np.uint8)


def degrade(img: np.ndarray, *, blur: float = 0.0, noise: float = 0.0, haze: float = 0.0,
            seed: int = 0) -> np.ndarray:
    """Camera damage: haze towards the water colour (contrast loss), lens blur, sensor noise."""
    f = img.astype(np.float32)
    if haze:
        f = f * (1 - haze) + np.asarray(WATER_BGR, np.float32) * haze
    if blur:
        f = cv2.GaussianBlur(f, (0, 0), blur)
    if noise:
        f = f + np.random.default_rng(seed).normal(0, noise, f.shape).astype(np.float32)
    return np.clip(f, 0, 255).astype(np.uint8)


# ---------- AprilTags ----------

def tag_cells(tag_id: int) -> np.ndarray:
    """10x10 uint8 (0 / 255): the 8x8 tag plus one white cell of quiet zone."""
    rows = TAG_BITS[tag_id].split()
    cells = np.array([[255 if c == "1" else 0 for c in row] for row in rows], np.uint8)
    return cv2.copyMakeBorder(cells, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=255)


def paste_tag(img: np.ndarray, tag_id: int, quad, black=(25, 22, 18), white=(225, 222, 210)) -> np.ndarray:
    """Draw a tag (with its quiet zone) so that its BLACK square lands on quad = image corners
    top-left, top-right, bottom-right, bottom-left of the tag as printed. Anti-aliased edges."""
    quad = np.asarray(quad, np.float64)
    side = max(np.linalg.norm(quad[1] - quad[0]), np.linalg.norm(quad[3] - quad[0]))
    cell = max(4, int(math.ceil(side / 8 * 2)))  # source a bit sharper than the target: mild downscale only
    src = cv2.resize(tag_cells(tag_id), None, fx=cell, fy=cell, interpolation=cv2.INTER_NEAREST)
    black_sq = np.float64([[cell, cell], [9 * cell, cell], [9 * cell, 9 * cell], [cell, 9 * cell]])
    H = cv2.getPerspectiveTransform(black_sq.astype(np.float32), quad.astype(np.float32))
    h, w = img.shape[:2]
    lum = cv2.warpPerspective(src.astype(np.float32) / 255, H, (w, h), flags=cv2.INTER_LINEAR)
    alpha = cv2.warpPerspective(np.ones(src.shape, np.float32), H, (w, h), flags=cv2.INTER_LINEAR)
    b, wt = np.asarray(black, np.float32), np.asarray(white, np.float32)
    tag = b + lum[..., None] * (wt - b)
    out = img.astype(np.float32) * (1 - alpha[..., None]) + tag * alpha[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)


def camera_matrix(w: int, h: int, hfov_deg: float) -> np.ndarray:
    f = (w / 2) / math.tan(math.radians(hfov_deg) / 2)
    return np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1]], np.float64)


def yaw_pose(dist_m: float, yaw_deg: float, shift_m=(0.0, 0.0)) -> tuple[np.ndarray, np.ndarray]:
    """Tag pose in the camera frame (x right, y down, z forward) when the camera stands dist_m from the tag
    centre, yaw_deg around the tag's vertical axis to the RIGHT of its centre line (as seen from the front),
    looking straight at the tag. shift_m moves the tag sideways/down in the camera frame afterwards.
    Returns (R tag->camera, t)."""
    a = math.radians(yaw_deg)
    # rows = camera axes in the tag frame (tag x right, y down, z into the tag) for a camera at
    # tag-frame position (d sin a, 0, -d cos a) looking at the tag centre
    R = np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])
    return R, np.array([shift_m[0], shift_m[1], dist_m], np.float64)


def tag_quad(K: np.ndarray, size_m: float, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Image corners (TL, TR, BR, BL of the printed tag) of a tag with black-square edge size_m."""
    s = size_m / 2
    obj = np.array([[-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0]], np.float64)  # tag frame: x right, y down
    cam = obj @ R.T + t
    uv = cam @ K.T
    return uv[:, :2] / uv[:, 2:3]


def square_quad(cx: float, cy: float, side: float, angle_deg: float = 0.0) -> np.ndarray:
    """TL, TR, BR, BL of a square of the given side, rotated in the image plane (clockwise on screen)."""
    a = math.radians(angle_deg)
    rot = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    base = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], np.float64) * side / 2
    return base @ rot.T + [cx, cy]


def tag_scene(w: int = 1280, h: int = 720, *, seed: int = 0, quads: dict | None = None) -> np.ndarray:
    """The three competition tags on a wall in the pool: one big and square, one turned in the image and
    seen at an angle, one small (far away)."""
    if quads is None:
        quads = {
            17: square_quad(w * 0.22, h * 0.45, h * 0.30),
            245: np.array([[w * 0.47, h * 0.33], [w * 0.60, h * 0.36], [w * 0.59, h * 0.60], [w * 0.46, h * 0.62]]),
            503: square_quad(w * 0.80, h * 0.55, h * 0.075, 20),
        }
    img = water(w, h, seed)
    for tag_id, quad in quads.items():
        img = paste_tag(img, tag_id, quad)
    return img


# ---------- Mission 3: line on the pool floor ----------

@dataclass
class FloorCamera:
    """Pinhole camera above a flat floor. World: X right, Y forward, Z up, floor at Z = 0.
    The line lies along +Y at X = 0. yaw_deg > 0 turns the camera to the right, tilt_deg = pitch below
    horizontal."""
    x: float = 0.0
    y: float = 0.0
    height: float = 0.7
    yaw_deg: float = 0.0
    tilt_deg: float = 55.0
    w: int = 640
    h: int = 360
    hfov_deg: float = 70.0

    def axes(self) -> np.ndarray:
        """Rows: camera x (right), y (down), z (forward) in world coordinates."""
        p, b = math.radians(self.yaw_deg), math.radians(self.tilt_deg)
        f = np.array([math.sin(p), math.cos(p), 0.0])
        r = np.array([math.cos(p), -math.sin(p), 0.0])
        u = np.array([0.0, 0.0, 1.0])
        return np.stack([r, -math.sin(b) * f - math.cos(b) * u, math.cos(b) * f - math.sin(b) * u])

    def project(self, pts) -> np.ndarray:
        """Nx3 world points -> Nx2 pixels (points must be in front of the camera)."""
        pts = np.asarray(pts, np.float64).reshape(-1, 3)
        cam = (pts - [self.x, self.y, self.height]) @ self.axes().T
        K = camera_matrix(self.w, self.h, self.hfov_deg)
        uv = cam @ K.T
        return uv[:, :2] / uv[:, 2:3]

    def floor_hits(self, ss: int = 2) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """World X, Y and distance of the floor point seen by every (supersampled) pixel; inf above horizon."""
        K = camera_matrix(self.w * ss, self.h * ss, self.hfov_deg)
        u, v = np.meshgrid(np.arange(self.w * ss) + 0.5, np.arange(self.h * ss) + 0.5)
        rays = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1)
        d = rays @ self.axes()
        with np.errstate(divide="ignore", invalid="ignore"):
            t = np.where(d[..., 2] < -1e-6, -self.height / d[..., 2], np.inf)
        X = self.x + d[..., 0] * np.where(np.isfinite(t), t, 0)
        Y = self.y + d[..., 1] * np.where(np.isfinite(t), t, 0)
        dist = t * np.linalg.norm(d, axis=-1)
        return X, Y, dist


@dataclass
class LineScene:
    img: np.ndarray
    cam: FloorCamera
    line_y: tuple[float, float]
    tapes_y: list[float] = field(default_factory=list)

    def axis_x_at(self, row: float) -> float:
        """Image x where the projected line axis crosses an image row."""
        (x0, y0), (x1, y1) = self.cam.project([[0, self.line_y[0], 0], [0, self.line_y[1], 0]])
        return x0 + (row - y0) * (x1 - x0) / (y1 - y0)

    def angle_deg(self) -> float:
        """0 = straight up the image, + = far end leans right."""
        (x0, y0), (x1, y1) = self.cam.project([[0, self.line_y[0], 0], [0, self.line_y[1], 0]])
        if y1 > y0:
            (x0, y0), (x1, y1) = (x1, y1), (x0, y0)
        return math.degrees(math.atan2(x1 - x0, y0 - y1))

    def visible_tapes(self, margin: float = 4.0) -> np.ndarray:
        """Image px of the tape centres that are inside the frame, bottom to top."""
        if not self.tapes_y:
            return np.zeros((0, 2))
        px = self.cam.project([[0, ty, 0] for ty in self.tapes_y])
        inside = ((px[:, 0] > margin) & (px[:, 0] < self.cam.w - margin)
                  & (px[:, 1] > margin) & (px[:, 1] < self.cam.h - margin))
        px = px[inside]
        return px[np.argsort(-px[:, 1])]


def line_scene(cam: FloorCamera | None = None, *, line_y=(-1.0, 3.0), tapes_y=(0.5, 1.0, 1.5),
               line_w: float = 0.05, tape_len: float = 0.05, tape_w: float = 0.09, caustics: float = 0.3,
               grout: bool = False, visibility: float = 6.0, light=(1.0, 1.0), blur: float = 0.8,
               noise: float = 5.0, seed: int = 0, draw_line: bool = True) -> LineScene:
    """Ray-cast pool floor (2x supersampled) with a dark line along +Y and white tapes across it.
    line_w = line width (m), tape_len = tape extent along the line, tape_w = across it (wider than the line).
    light = brightness multiplier at the left / right image edge (uneven light)."""
    cam = cam or FloorCamera()
    ss = 2
    X, Y, dist = cam.floor_hits(ss)
    floor = np.isfinite(dist)
    col = np.broadcast_to(np.asarray(FLOOR_BGR, np.float32), X.shape + (3,)).copy()
    shade = np.ones(X.shape, np.float32)
    if caustics:  # ripples of light from the surface waves
        ripple = np.sin(X * 9 + 1.0) * np.sin(Y * 7 - 0.5) + 0.5 * np.sin((X + Y) * 15)
        shade *= 1 + 0.12 * caustics * ripple.astype(np.float32)
    if grout:  # 25 cm tiles with thin, slightly darker joints
        gx, gy = X / 0.25, Y / 0.25
        joint = (np.abs(gx - np.round(gx)) < 0.02) | (np.abs(gy - np.round(gy)) < 0.02)
        shade *= np.where(joint, 0.88, 1.0).astype(np.float32)
    if draw_line:
        on_line = (np.abs(X) < line_w / 2) & (Y >= line_y[0]) & (Y <= line_y[1])
        col[on_line] = LINE_BGR
        for ty in tapes_y:
            on_tape = (np.abs(X) < tape_w / 2) & (np.abs(Y - ty) < tape_len / 2)
            col[on_tape] = TAPE_BGR
    col *= shade[..., None]
    k = np.exp(-np.where(floor, dist, 50) / visibility).astype(np.float32)[..., None]  # fog with distance
    img = col * k + np.asarray(WATER_BGR, np.float32) * (1 - k)
    img = cv2.resize(np.clip(img, 0, 255), (cam.w, cam.h), interpolation=cv2.INTER_AREA).astype(np.uint8)
    if light != (1.0, 1.0):
        img = light_gradient(img, *light)
    img = degrade(img, blur=blur, noise=noise, seed=seed)
    return LineScene(img, cam, tuple(line_y), list(tapes_y) if draw_line else [])


# ---------- Mission 5: coloured poles ----------

@dataclass
class Pole:
    color: str
    x: float  # centre x, px
    top: float  # px
    bottom: float
    width: float

    @property
    def box(self) -> tuple[float, float, float, float]:
        return self.x - self.width / 2, self.top, self.width, self.bottom - self.top


def poles_scene(w: int = 640, h: int = 360, poles: list[Pole] | None = None, *, seed: int = 0,
                haze: float = 0.2, noise: float = 5.0, blur: float = 0.8) -> tuple[np.ndarray, list[Pole]]:
    """Coloured poles (round: darker towards the edges) with a white golf ball on top, against open water."""
    if poles is None:
        poles = [Pole("red", w * 0.2, h * 0.30, h * 0.92, w * 0.045),
                 Pole("yellow", w * 0.5, h * 0.40, h * 0.88, w * 0.035),
                 Pole("blue", w * 0.78, h * 0.25, h * 0.95, w * 0.05)]
    img = water(w, h, seed).astype(np.float32)
    for p in poles:
        x0, x1 = max(0, int(round(p.x - p.width / 2))), min(w, int(round(p.x + p.width / 2)))
        y0, y1 = max(0, int(round(p.top))), min(h, int(round(p.bottom)))
        xs = np.arange(x0, x1) + 0.5
        across = np.clip(1 - ((xs - p.x) / (p.width / 2)) ** 2, 0, 1)
        shade = 0.65 + 0.35 * np.sqrt(across)  # cylinder: lit in the middle
        img[y0:y1, x0:x1] = np.asarray(POLE_BGR[p.color], np.float32) * shade[None, :, None]
        r = max(3, int(p.width * 0.45))
        cv2.circle(img, (int(p.x), y0 - r + 1), r, (235, 235, 235), -1, cv2.LINE_AA)
    img = np.clip(img, 0, 255).astype(np.uint8)
    return degrade(img, haze=haze, blur=blur, noise=noise, seed=seed), poles
