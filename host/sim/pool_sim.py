"""Tiny 3D pool simulator: renders what the ROV camera would see, moves the ROV like our 3 thrusters do
(surge, yaw, heave - no sideways motion) and detects contact with the chamber frame.

World frame: X right, Y forward, Z up, floor z = 0, surface z = POOL_DEPTH.
"""
import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from vision.camera_model import CameraModel
from vision.chamber import CELL, N_CELLS, PIPE_D, TAG_AXES_WORLD, TAG_FULL_M, ChamberWorld
from vision.docking import RovConfig
from vision.tag_image import render_tag
from vision.tag_tracker import Rule, select_target

POOL_DEPTH = 2.0
WATER_BGR = np.array([150, 120, 40], np.float32)  # far-away water colour (fog)
SURFACE_BGR = np.array([235, 215, 170], np.float32)
FLOOR_A = np.array([200, 175, 120], np.float32)  # light blue tiles
FLOOR_B = np.array([180, 155, 100], np.float32)
PIPE_BGR = np.array([235, 235, 235], np.float32)

THROTTLE_STEPS = 3  # like the ESC test sketch: discrete levels per axis, -3..3
MAX_SURGE = 0.30  # m/s at full level (guess for a small ROV)
MAX_YAW = 35.0  # deg/s
MAX_HEAVE = 0.15  # m/s
RESPONSE_TAU = 0.6  # s, inertia: how fast speed follows the throttle


@dataclass
class RovState:
    pos: np.ndarray  # ROV centre, world
    yaw: float  # deg, 0 = facing +Y, + = turned right
    vel: np.ndarray = field(default_factory=lambda: np.zeros(3))  # surge m/s, yaw deg/s, heave m/s


@dataclass
class SimStatus:
    contact_now: bool = False
    contacts: int = 0  # number of separate contact events this attempt
    floor_contact: bool = False
    docked_cell: int | None = None


def heading_vec(yaw_deg: float) -> np.ndarray:
    a = math.radians(yaw_deg)
    return np.array([math.sin(a), math.cos(a), 0.0])


def apply_key(levels: np.ndarray, key: int) -> bool:
    """W/S surge, A/D yaw, R/F heave, X all stop. Changes levels in place; True if the key was used."""
    mapping = {ord("w"): (0, 1), ord("s"): (0, -1), ord("d"): (1, 1), ord("a"): (1, -1),
               ord("r"): (2, 1), ord("f"): (2, -1)}
    if key == ord("x"):
        levels[:] = 0
        return True
    if key in mapping:
        axis, step = mapping[key]
        levels[axis] = int(np.clip(levels[axis] + step, -THROTTLE_STEPS, THROTTLE_STEPS))
        return True
    return False


def wander(drift: np.ndarray, rng: np.random.Generator, dt: float) -> np.ndarray:
    """Slowly wandering water current pushing the ROV sideways (it cannot fight it directly)."""
    return np.clip(drift + rng.normal(0, 0.3, 2) * dt, -1, 1)


def advance(s: RovState, levels, dt: float, rov: RovConfig, push=(0.0, 0.0)) -> tuple[np.ndarray, float]:
    """Thruster levels -> next (pos, yaw). Speeds follow the throttle with inertia (updates s.vel)."""
    target = np.asarray(levels) / THROTTLE_STEPS * np.array([MAX_SURGE, MAX_YAW, MAX_HEAVE])
    s.vel += (target - s.vel) * min(1.0, dt / RESPONSE_TAU)
    new_yaw = s.yaw + s.vel[1] * dt
    move = heading_vec(new_yaw) * s.vel[0] + np.array([0, 0, s.vel[2]])
    move[:2] += push
    new_pos = s.pos + move * dt
    new_pos[2] = np.clip(new_pos[2], rov.height / 2, POOL_DEPTH - rov.height / 2)
    return new_pos, new_yaw


def camera_pose(s: RovState, rov: RovConfig) -> tuple[np.ndarray, np.ndarray]:
    """Camera centre (front of the ROV) and world->camera rotation (rows: x right, y down, z forward)."""
    f = heading_vec(s.yaw)
    r = np.array([f[1], -f[0], 0.0])
    up = np.array([0.0, 0.0, 1.0])
    a = math.radians(rov.cam_tilt_deg)
    fwd = f * math.cos(a) - up * math.sin(a)
    down = -(up * math.cos(a) + f * math.sin(a))
    return s.pos + f * (rov.length / 2), np.stack([r, down, fwd])


def pixel_rays(cam: CameraModel, w: int, h: int) -> np.ndarray:
    """Unit camera-frame ray for every pixel of a w x h image."""
    cam = cam.scaled_to(w, h)
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    rays = np.stack([(u - cam.cx) / cam.fx, (v - cam.cy) / cam.fy, np.ones_like(u)], axis=-1)
    return (rays / np.linalg.norm(rays, axis=-1, keepdims=True)).astype(np.float32)


class PoolSim:
    def __init__(self, tag_ids: list[int], rov: RovConfig | None = None, mount: str = "above",
                 width: int = 1280, height: int = 720, hfov_deg: float = 70.0, visibility: float = 7.0,
                 drift: float = 0.0, seed: int | None = None):
        if len(tag_ids) != N_CELLS:
            raise ValueError(f"need {N_CELLS} tag ids")
        self.tag_ids = list(tag_ids)
        self.rov = rov or RovConfig()
        self.world = ChamberWorld(origin=np.array([-CELL * N_CELLS / 2, 3.0, 0.0]), mount=mount)
        self.camera = CameraModel.from_hfov(width, height, hfov_deg)
        self.visibility = visibility
        self.drift_speed = drift
        self.rng = np.random.default_rng(seed)
        self.levels = np.zeros(3, int)  # surge, yaw, heave
        self._tag_imgs = [cv2.cvtColor(render_tag(i, 240), cv2.COLOR_GRAY2BGR) for i in tag_ids]
        self._bars = self.world.bars()
        self._rays_cam = pixel_rays(self.camera, width // 2, height // 2)
        self.reset()

    # ---------- state ----------
    def reset(self) -> None:
        jitter = self.rng.uniform(-1, 1, 3)
        self.state = RovState(pos=np.array([0.5 * jitter[0], 0.4, 0.7 + 0.2 * jitter[1]]), yaw=12 * jitter[2])
        self.levels[:] = 0
        self.status = SimStatus()
        self._drift = np.zeros(2)

    def set_pose(self, pos, yaw: float) -> None:
        self.state = RovState(pos=np.asarray(pos, float), yaw=float(yaw))
        self.levels[:] = 0
        self.status = SimStatus()

    def handle_key(self, key: int) -> bool:
        return apply_key(self.levels, key)

    def correct_cell(self, rule: Rule | None) -> int | None:
        target = select_target(self.tag_ids, rule)
        return None if target is None else self.tag_ids.index(target)

    def score(self, rule: Rule | None) -> tuple[int | None, str]:
        """Points the referee would give right now (None = not docked yet)."""
        cell = self.status.docked_cell
        if cell is None:
            return None, "not docked"
        if cell != self.correct_cell(rule):
            return 0, f"WRONG chamber (ID {self.tag_ids[cell]})"
        if self.status.contacts:
            return 10, f"docked ID {self.tag_ids[cell]} with contact"
        return 20, f"docked ID {self.tag_ids[cell]} clean"

    # ---------- motion ----------
    def step(self, dt: float) -> None:
        dt = min(dt, 0.1)
        s = self.state
        if self.drift_speed:
            self._drift = wander(self._drift, self.rng, dt)
        new_pos, new_yaw = advance(s, self.levels, dt, self.rov, self._drift * self.drift_speed)

        hit = self._touches_frame(new_pos, new_yaw)
        if hit:
            if not self.status.contact_now:
                self.status.contacts += 1
            s.vel[:] = 0  # bounce off: do not let the ROV pass through pipes
        else:
            s.pos, s.yaw = new_pos, new_yaw
        self.status.contact_now = hit
        self.status.floor_contact = s.pos[2] <= self.rov.height / 2 + 1e-3
        self.status.docked_cell = self._docked_cell()

    def _rov_axes(self, yaw: float) -> np.ndarray:
        f = heading_vec(yaw)
        r = np.array([f[1], -f[0], 0.0])
        return np.stack([r, f, [0.0, 0.0, 1.0]])  # rows: right, forward, up

    def _touches_frame(self, pos: np.ndarray, yaw: float) -> bool:
        half = np.array([self.rov.width, self.rov.length, self.rov.height]) / 2
        ts = np.linspace(0, 1, 120)[None, :, None]
        pts = self._bars[:, 0:1, :] + (self._bars[:, 1:2, :] - self._bars[:, 0:1, :]) * ts
        local = (pts.reshape(-1, 3) - pos) @ self._rov_axes(yaw).T
        gap = np.maximum(np.abs(local) - half, 0)
        return bool((np.linalg.norm(gap, axis=1) <= PIPE_D / 2).any())

    def _docked_cell(self) -> int | None:
        s = self.state
        axes = self._rov_axes(s.yaw)
        half = np.array([self.rov.width, self.rov.length, self.rov.height]) / 2
        signs = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)])
        corners = s.pos + (signs * half) @ axes
        for i in range(N_CELLS):
            lo, hi = self.world.cell_box(i)
            if ((corners >= lo) & (corners <= hi)).all():
                return i
        return None

    # ---------- camera ----------
    def camera_pose(self) -> tuple[np.ndarray, np.ndarray]:
        return camera_pose(self.state, self.rov)

    def true_tag_pose(self, i: int) -> tuple[np.ndarray, np.ndarray]:
        """Ground truth (R, t) of tag i in the camera frame, same convention as pupil-apriltags."""
        c, Rwc = self.camera_pose()
        return Rwc @ TAG_AXES_WORLD, Rwc @ (self.world.tag_center(i) - c)

    def _fog(self, dist) -> np.ndarray:
        return np.exp(-np.asarray(dist, np.float32) / self.visibility)

    def _background(self, c: np.ndarray, Rwc: np.ndarray) -> np.ndarray:
        d = self._rays_cam @ Rwc.astype(np.float32)  # camera rays -> world directions
        dz = d[..., 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            t_floor = np.where(dz < -1e-4, -c[2] / dz, np.inf)
            t_surf = np.where(dz > 1e-4, (POOL_DEPTH - c[2]) / dz, np.inf)
        img = np.broadcast_to(WATER_BGR, d.shape).copy()

        floor = np.isfinite(t_floor)
        t_hit = np.where(floor, t_floor, 0.0)
        hx = c[0] + d[..., 0] * t_hit
        hy = c[1] + d[..., 1] * t_hit
        tiles = ((np.floor(hx / 0.5) + np.floor(hy / 0.5)) % 2 == 0)[..., None]
        floor_col = np.where(tiles, FLOOR_A, FLOOR_B)
        grout = ((np.abs(hx / 0.5 - np.round(hx / 0.5)) < 0.03) | (np.abs(hy / 0.5 - np.round(hy / 0.5)) < 0.03))
        floor_col = np.where(grout[..., None], floor_col * 0.8, floor_col)
        k = self._fog(np.where(floor, t_floor, 0))[..., None]
        img = np.where(floor[..., None], floor_col * k + WATER_BGR * (1 - k), img)

        surf = np.isfinite(t_surf)
        k = self._fog(np.where(surf, t_surf, 0))[..., None]
        img = np.where(surf[..., None], SURFACE_BGR * k + WATER_BGR * (1 - k), img)
        img = np.clip(img, 0, 255).astype(np.uint8)
        return cv2.resize(img, (self.camera.width, self.camera.height), interpolation=cv2.INTER_LINEAR)

    def render(self) -> np.ndarray:
        c, Rwc = self.camera_pose()
        img = self._background(c, Rwc)
        cam = self.camera
        items = []  # (depth, kind, data) drawn far to near
        for i in range(N_CELLS):
            corners = (self.world.tag_corners_world(i, TAG_FULL_M) - c) @ Rwc.T
            if (corners[:, 2] > 0.05).all():
                items.append((float(corners[:, 2].mean()), "tag", (i, corners)))
        for a, b in self._bars:
            pa, pb = Rwc @ (a - c), Rwc @ (b - c)
            seg = _clip_near(pa, pb, 0.05)
            if seg is not None:
                items.append((float((seg[0][2] + seg[1][2]) / 2), "bar", seg))
        for depth, kind, data in sorted(items, key=lambda it: -it[0]):
            k = float(self._fog(depth))
            if kind == "tag":
                i, corners = data
                src = self._tag_imgs[i]
                hs, ws = src.shape[:2]
                dst = cam.project(corners).astype(np.float32)
                M = cv2.getPerspectiveTransform(np.float32([[0, 0], [ws, 0], [ws, hs], [0, hs]]), dst)
                warped = cv2.warpPerspective(src, M, (cam.width, cam.height), flags=cv2.INTER_LINEAR)
                mask = cv2.warpPerspective(np.full((hs, ws), 255, np.uint8), M, (cam.width, cam.height))
                fogged = (warped * k + WATER_BGR * (1 - k)).astype(np.uint8)
                img[mask > 127] = fogged[mask > 127]
            else:
                pa, pb = data
                (ua, va), (ub, vb) = cam.project(np.stack([pa, pb]))
                thick = int(np.clip(cam.fx * PIPE_D / max(depth, 0.05), 1, 200))
                col = tuple(int(x) for x in PIPE_BGR * k + WATER_BGR * (1 - k))
                cv2.line(img, (int(ua), int(va)), (int(ub), int(vb)), col, thick, cv2.LINE_AA)
        return img


def _clip_near(pa: np.ndarray, pb: np.ndarray, near: float):
    """Clip a camera-frame segment to z >= near; None if fully behind."""
    if pa[2] < near and pb[2] < near:
        return None
    if pa[2] < near:
        pa = pb + (pa - pb) * (pb[2] - near) / (pb[2] - pa[2])
    elif pb[2] < near:
        pb = pa + (pb - pa) * (pa[2] - near) / (pa[2] - pb[2])
    return pa, pb
