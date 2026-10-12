"""Pool-floor simulator for Mission 3: a dark pipe with tape bands lying on a tiled floor, seen by the ROV
camera, with the same thruster model as the docking simulator (surge, yaw, heave - no sideways motion).

World frame: X right, Y forward, Z up, floor z = 0. Layout from the props manual: a ~1.5 m black line with a
tape every 50 cm, the first tape is the start.
"""
from dataclasses import dataclass

import cv2
import numpy as np

from sim.pool_sim import (POOL_DEPTH, SURFACE_BGR, WATER_BGR, RovState, advance, apply_key, camera_pose,
                          heading_vec, pixel_rays, wander)
from vision.camera_model import CameraModel
from vision.docking import RovConfig
from vision.line_follow import MILESTONES, TAPE_SPACING

LINE_START = np.array([0.0, 1.0])  # where the pipe begins on the floor
LINE_D = 0.025  # pipe diameter (UNCONFIRMED, looks like ~20-25 mm PVC on the props photo)
LINE_LEN = 1.7
TAPE_FIRST = 0.1  # along the pipe
TAPE_W = 0.05
TAPES = TAPE_FIRST + TAPE_SPACING * np.arange(len(MILESTONES))
PIPE_BGR = np.array([38, 38, 38], np.float32)
PIPE_TOP_BGR = np.array([75, 75, 75], np.float32)  # lit top of the round pipe
TAPE_BGR = np.array([235, 235, 235], np.float32)
FLOOR_BGR = np.array([205, 180, 120], np.float32)
TILE = 0.25
GROUT_HALF = 0.012  # fraction of a tile: ~6 mm grout lines


@dataclass
class LineSimStatus:
    floor_contact: bool = False
    floor_contacts: int = 0
    max_offset: float = 0.0  # m, worst sideways distance of the ROV centre from the line inside the course
    furthest: int = 0  # most tapes passed at any moment (the referee scores the furthest milestone)


class LineSim:
    def __init__(self, rov: RovConfig | None = None, width: int = 1280, height: int = 720, hfov_deg: float = 70.0,
                 visibility: float = 7.0, drift: float = 0.0, caustics: float = 0.3, line_yaw: float = 0.0,
                 seed: int | None = None):
        self.rov = rov or RovConfig(cam_tilt_deg=30)
        self.camera = CameraModel.from_hfov(width, height, hfov_deg)
        self.visibility = visibility
        self.drift_speed = drift
        self.caustics = caustics
        self.line_yaw = line_yaw
        self.rng = np.random.default_rng(seed)
        self.levels = np.zeros(3, int)
        self.time = 0.0
        self._rays_cam = pixel_rays(self.camera, width // 2, height // 2)
        self.reset()

    @property
    def line_dir(self) -> np.ndarray:
        return heading_vec(self.line_yaw)[:2]

    @property
    def line_right(self) -> np.ndarray:
        d = self.line_dir
        return np.array([d[1], -d[0]])

    # ---------- state ----------
    def reset(self) -> None:
        j = self.rng.uniform(-1, 1, 3)
        start = LINE_START + self.line_dir * -1.0 + self.line_right * 0.25 * j[0]
        self.set_pose((*start, 0.6 + 0.15 * j[1]), self.line_yaw + 15 * j[2])

    def set_pose(self, pos, yaw: float) -> None:
        self.state = RovState(pos=np.asarray(pos, float), yaw=float(yaw))
        self.levels[:] = 0
        self.status = LineSimStatus()
        self._drift = np.zeros(2)

    def handle_key(self, key: int) -> bool:
        return apply_key(self.levels, key)

    def step(self, dt: float) -> None:
        dt = min(dt, 0.1)
        self.time += dt
        if self.drift_speed:
            self._drift = wander(self._drift, self.rng, dt)
        s = self.state
        s.pos, s.yaw = advance(s, self.levels, dt, self.rov, self._drift * self.drift_speed)
        on_floor = s.pos[2] <= self.rov.height / 2 + 1e-3
        if on_floor and not self.status.floor_contact:
            self.status.floor_contacts += 1
        self.status.floor_contact = on_floor
        self.status.furthest = max(self.status.furthest, self.passed())
        along, offset, _ = self.truth()
        if TAPES[0] <= along <= TAPES[-1]:
            self.status.max_offset = max(self.status.max_offset, abs(offset))

    # ---------- ground truth ----------
    def truth(self) -> tuple[float, float, float]:
        """(along, offset, heading): ROV centre position along the line from the pipe start (m); where the line is
        relative to the ROV (+ = to the right, m); line direction relative to the ROV heading (+ = turn right)."""
        rel = self.state.pos[:2] - LINE_START
        heading = (self.line_yaw - self.state.yaw + 180) % 360 - 180
        return float(rel @ self.line_dir), float(-(rel @ self.line_right)), heading

    def passed(self) -> int:
        """Tapes the whole ROV (its tail) has passed."""
        tail = self.truth()[0] - self.rov.length / 2
        return int((TAPES < tail).sum())

    def camera_height(self) -> float:
        return float(camera_pose(self.state, self.rov)[0][2])

    # ---------- camera ----------
    def _fog(self, dist) -> np.ndarray:
        return np.exp(-np.asarray(dist, np.float32) / self.visibility)

    def _background(self, c: np.ndarray, Rwc: np.ndarray) -> np.ndarray:
        return floor_image(self._rays_cam, c, Rwc, (self.camera.width, self.camera.height), self.visibility,
                           self.caustics, self.time)

    def _pipe_pieces(self, step: float = 0.02):
        """(start, end, colour) of short pipe pieces along the line, tapes in white."""
        cuts = np.unique(np.concatenate([np.arange(0, LINE_LEN, step), TAPES - TAPE_W / 2, TAPES + TAPE_W / 2,
                                         [LINE_LEN]]))
        for a, b in zip(cuts[:-1], cuts[1:]):
            mid = (a + b) / 2
            on_tape = bool((np.abs(TAPES - mid) < TAPE_W / 2).any())
            p0 = np.r_[LINE_START + self.line_dir * a, LINE_D / 2]
            p1 = np.r_[LINE_START + self.line_dir * b, LINE_D / 2]
            yield p0, p1, on_tape

    def render(self) -> np.ndarray:
        c, Rwc = camera_pose(self.state, self.rov)
        img = self._background(c, Rwc)
        cam = self.camera
        pieces = []
        for p0, p1, on_tape in self._pipe_pieces():
            pa, pb = Rwc @ (p0 - c), Rwc @ (p1 - c)
            if min(pa[2], pb[2]) > 0.05:
                pieces.append(((pa[2] + pb[2]) / 2, pa, pb, on_tape))
        for depth, pa, pb, on_tape in sorted(pieces, key=lambda it: -it[0]):
            k = float(self._fog(np.linalg.norm((pa + pb) / 2)))
            (ua, va), (ub, vb) = cam.project(np.stack([pa, pb]))
            width = cam.fx * LINE_D / depth
            ends = (int(round(ua)), int(round(va))), (int(round(ub)), int(round(vb)))
            base = TAPE_BGR if on_tape else PIPE_BGR
            if width < 1.5:  # thinner than a pixel: blend like a camera would average it
                frac = width / 1.5
                col = tuple(int(x) for x in (base * k + WATER_BGR * (1 - k)) * frac + FLOOR_BGR * k * (1 - frac))
                cv2.line(img, *ends, col, 1, cv2.LINE_AA)
                continue
            col = tuple(int(x) for x in base * k + WATER_BGR * (1 - k))
            cv2.line(img, *ends, col, int(round(width)), cv2.LINE_AA)
            if not on_tape and width >= 4:
                top = tuple(int(x) for x in PIPE_TOP_BGR * k + WATER_BGR * (1 - k))
                cv2.line(img, *ends, top, max(1, int(width * 0.3)), cv2.LINE_AA)
        return img


def floor_image(rays_cam: np.ndarray, c: np.ndarray, Rwc: np.ndarray, size, visibility: float, caustics: float,
                t: float) -> np.ndarray:
    """Tiled pool floor (with grout, moving caustics and fog) and the surface, ray cast at the rays' resolution
    and scaled to size = (width, height)."""
    d = rays_cam @ Rwc.astype(np.float32)
    dz = d[..., 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = np.where(dz < -1e-4, -c[2] / dz, np.inf)
        t_surf = np.where(dz > 1e-4, (POOL_DEPTH - c[2]) / dz, np.inf)
    img = np.broadcast_to(WATER_BGR, d.shape).copy()

    floor = np.isfinite(t_floor)
    t_hit = np.where(floor, t_floor, 0.0)
    hx, hy = c[0] + d[..., 0] * t_hit, c[1] + d[..., 1] * t_hit
    gx, gy = hx / TILE, hy / TILE
    grout = (np.abs(gx - np.round(gx)) < GROUT_HALF) | (np.abs(gy - np.round(gy)) < GROUT_HALF)
    shade = np.where(grout, 0.85, 1.0)
    if caustics:  # moving light ripples from the surface waves
        ripple = np.sin(hx * 9 + t * 1.3) * np.sin(hy * 7 - t * 0.9) + 0.5 * np.sin((hx + hy) * 15 + t * 2)
        shade = shade * (1 + 0.12 * caustics * ripple)
    k = np.exp(-t_hit / visibility).astype(np.float32)[..., None]
    img = np.where(floor[..., None], FLOOR_BGR * shade[..., None] * k + WATER_BGR * (1 - k), img)
    surf = np.isfinite(t_surf)
    k = np.exp(-np.where(surf, t_surf, 0) / visibility).astype(np.float32)[..., None]
    img = np.where(surf[..., None], SURFACE_BGR * k + WATER_BGR * (1 - k), img)
    img = np.clip(img, 0, 255).astype(np.uint8)
    return cv2.resize(img, size, interpolation=cv2.INTER_LINEAR)


def pose_along(along: float, offset: float, height: float, rel_yaw: float, line_yaw: float = 0.0):
    """ROV centre pose for a spot `along` m down the line and `offset` m to its right, heading rel_yaw from it."""
    d = heading_vec(line_yaw)[:2]
    right = np.array([d[1], -d[0]])
    xy = LINE_START + d * along + right * offset
    return (xy[0], xy[1], height), line_yaw + rel_yaw

