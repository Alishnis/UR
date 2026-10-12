"""Pool simulator for Mission 5: three coloured poles with a golf ball on top, seen by the ROV camera, with the
same thruster model as the other simulators (surge, yaw, heave - no sideways motion).

World frame: X right, Y forward, Z up, floor z = 0. The ROV starts near the origin facing +Y; the poles stand
in a loose diagonal row about 3 m ahead (road map in the props manual). Water absorbs red light much faster
than blue, along the way down from the surface and on the way to the camera, so a red pole gets dark and
yellow turns greenish with distance - the reason the colour ranges must be calibrated in the real pool.
"""
import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from sim.line_sim import floor_image
from sim.pool_sim import POOL_DEPTH, WATER_BGR, RovState, _clip_near, advance, apply_key, camera_pose, pixel_rays, wander
from vision.camera_model import CameraModel
from vision.docking import RovConfig
from vision.pole_detector import COLORS

POLE_H = 0.60  # m, top of the coloured pole above the floor - props drawing says 60 cm, contest text "~1 m": ASK
POLE_D = 0.05  # m, pole diameter - UNCONFIRMED (looks like 40-90 mm on the props drawing)
BALL_D = 0.0427  # m, standard golf ball
BASE_D, BASE_H = 0.16, 0.02  # flat base plate (props drawing)
SPACING = 0.7  # m between neighbouring poles
TRIGGER_ZONE = 0.10  # m: touching the ball or the top this much of the pole releases the ball (mechanism UNKNOWN)
BASE_BGR = {"red": (40, 40, 215), "yellow": (40, 210, 235), "blue": (210, 90, 25)}  # colours in air
BALL_BGR = (240, 240, 240)
ABSORB = np.array([0.02, 0.05, 0.25])  # 1/m for B, G, R: water eats red first
BALL_FALL_SPEED = 0.4  # m/s


@dataclass
class PoleState:
    color: str
    xy: np.ndarray
    ball_z: float  # ball centre height
    falling: bool = False
    touching: bool = False


@dataclass
class PoleSimStatus:
    activated: list[str] = field(default_factory=list)  # colours whose ball dropped, in order
    touches: list[str] = field(default_factory=list)  # every separate contact with a pole (any height)
    floor_contact: bool = False


class PoleSim:
    def __init__(self, rov: RovConfig | None = None, width: int = 1280, height: int = 720, hfov_deg: float = 70.0,
                 visibility: float = 7.0, drift: float = 0.0, caustics: float = 0.3, pole_h: float = POLE_H,
                 pole_d: float = POLE_D, order: list[str] | None = None, seed: int | None = None):
        self.rov = rov or RovConfig(cam_tilt_deg=30)
        self.camera = CameraModel.from_hfov(width, height, hfov_deg)
        self.visibility = visibility
        self.drift_speed = drift
        self.caustics = caustics
        self.pole_h, self.pole_d = pole_h, pole_d
        self.fixed_order = order
        self.rng = np.random.default_rng(seed)
        self.levels = np.zeros(3, int)
        self.time = 0.0
        self._rays_cam = pixel_rays(self.camera, width // 2, height // 2)
        self.reset()

    # ---------- state ----------
    def reset(self) -> None:
        """New random layout, announced order and start pose."""
        rng = self.rng
        colors = list(rng.permutation(COLORS))
        centre = np.array([rng.uniform(-0.6, 0.6), rng.uniform(2.6, 3.4)])
        a = math.radians(rng.uniform(20, 60) * rng.choice([-1, 1]))
        along = np.array([math.cos(a), math.sin(a)])
        self.poles = [PoleState(c, centre + (k - 1) * SPACING * along + rng.uniform(-0.08, 0.08, 2),
                                self.pole_h + BALL_D / 2) for k, c in enumerate(colors)]
        self.order = list(self.fixed_order) if self.fixed_order else [str(c) for c in rng.permutation(COLORS)]
        j = rng.uniform(-1, 1, 3)
        self.set_pose((0.4 * j[0], 0.0, 0.9 + 0.2 * j[1]), 12 * j[2])

    def set_pose(self, pos, yaw: float) -> None:
        self.state = RovState(pos=np.asarray(pos, float), yaw=float(yaw))
        self.levels[:] = 0
        self.status = PoleSimStatus()
        self._drift = np.zeros(2)
        for p in self.poles:
            p.ball_z, p.falling, p.touching = self.pole_h + BALL_D / 2, False, False

    def pole(self, color: str) -> PoleState:
        return next(p for p in self.poles if p.color == color)

    def handle_key(self, key: int) -> bool:
        return apply_key(self.levels, key)

    def step(self, dt: float) -> None:
        dt = min(dt, 0.1)
        self.time += dt
        if self.drift_speed:
            self._drift = wander(self._drift, self.rng, dt)
        s = self.state
        new_pos, new_yaw = advance(s, self.levels, dt, self.rov, self._drift * self.drift_speed)
        blocked = False
        for p in self.poles:
            hit, trigger = self._contact(p, new_pos, new_yaw)
            if hit and not p.touching:
                self.status.touches.append(p.color)
            p.touching = hit
            if trigger and not p.falling and p.color not in self.status.activated:
                p.falling = True
                self.status.activated.append(p.color)
            blocked |= hit
        if blocked:
            s.vel[:] = 0  # bounce off: the pole does not move
        else:
            s.pos, s.yaw = new_pos, new_yaw
        self.status.floor_contact = s.pos[2] <= self.rov.height / 2 + 1e-3
        for p in self.poles:
            if p.falling:
                p.ball_z = max(BALL_D / 2, p.ball_z - BALL_FALL_SPEED * dt)

    def _contact(self, p: PoleState, pos: np.ndarray, yaw: float) -> tuple[bool, bool]:
        """(ROV box touches the pole or its ball, the touch is high enough to release the ball)."""
        f = np.array([math.sin(math.radians(yaw)), math.cos(math.radians(yaw))])
        axes = np.array([[f[1], -f[0]], f])  # rows: right, forward
        half = np.array([self.rov.width, self.rov.length]) / 2
        local = axes @ (p.xy - pos[:2])
        gap_xy = float(np.linalg.norm(local - np.clip(local, -half, half)))
        z_lo, z_hi = pos[2] - self.rov.height / 2, pos[2] + self.rov.height / 2
        on_top = abs(p.ball_z - (self.pole_h + BALL_D / 2)) < 1e-6
        ball = False
        if on_top:  # sphere vs box
            gz = max(z_lo - p.ball_z, p.ball_z - z_hi, 0.0)
            ball = math.hypot(gap_xy, gz) <= BALL_D / 2
        pole = gap_xy <= self.pole_d / 2 and z_lo <= self.pole_h
        trigger = ball or (pole and z_hi >= self.pole_h - TRIGGER_ZONE)
        return pole or ball, trigger

    # ---------- referee ----------
    def score(self) -> tuple[int, str]:
        act = self.status.activated
        bonus = len(act) == 3 and act == self.order
        pts = 10 * len(act) + (20 if bonus else 0)
        text = "-".join(c[0].upper() for c in act) or "none"
        return pts, f"dropped {text}" + (" IN ORDER +20" if bonus else "")

    def truth(self, color: str) -> tuple[float, float, float]:
        """(bearing deg + = right, horizontal distance camera -> pole axis m, ball centre minus camera height m)."""
        c, _ = camera_pose(self.state, self.rov)
        p = self.pole(color)
        v = p.xy - c[:2]
        yaw = math.radians(self.state.yaw)
        fwd, right = np.array([math.sin(yaw), math.cos(yaw)]), np.array([math.cos(yaw), -math.sin(yaw)])
        return math.degrees(math.atan2(v @ right, v @ fwd)), float(np.linalg.norm(v)), p.ball_z - c[2]

    # ---------- camera ----------
    def _water(self, bgr, dist: float, z: float) -> np.ndarray:
        light = np.asarray(bgr, float) * np.exp(-ABSORB * ((POOL_DEPTH - z) + dist)) * 1.15
        k = math.exp(-dist / self.visibility)
        return np.clip(light * k + WATER_BGR * (1 - k), 0, 255)

    def _cylinder(self, img, c, Rwc, xy, z0, z1, radius, bgr, strips=8):
        cam = self.camera
        v = xy - c[:2]
        dist = float(np.linalg.norm(v))
        if dist <= radius + 0.01:
            return
        to_cam = -v / dist
        perp = np.array([-to_cam[1], to_cam[0]])
        half = math.asin(min(1.0, radius / dist))  # visible half angle (just under 90 deg when far)
        phis = np.linspace(-(math.pi / 2 - half), math.pi / 2 - half, strips + 1)
        edges = []
        for phi in phis:
            pt = xy + radius * (math.cos(phi) * to_cam + math.sin(phi) * perp)
            a, b = Rwc @ (np.r_[pt, z0] - c), Rwc @ (np.r_[pt, z1] - c)
            edges.append(_clip_near(a, b, 0.05))
        for k in range(strips):
            ea, eb = edges[k], edges[k + 1]
            if ea is None or eb is None:
                continue
            quad = cam.project(np.stack([ea[0], ea[1], eb[1], eb[0]]))
            if not np.isfinite(quad).all() or np.abs(quad).max() > 1e5:
                continue
            phi = (phis[k] + phis[k + 1]) / 2
            col = self._water(np.asarray(bgr) * (0.55 + 0.45 * math.cos(phi)), dist, (z0 + z1) / 2)
            cv2.fillConvexPoly(img, np.round(quad).astype(np.int32), tuple(int(x) for x in col), cv2.LINE_AA)
        if c[2] > z1:  # looking down on it: the flat top is visible
            ring = [Rwc @ (np.r_[xy + radius * np.array([math.cos(t), math.sin(t)]), z1] - c)
                    for t in np.linspace(0, 2 * math.pi, 24, endpoint=False)]
            if min(q[2] for q in ring) > 0.05:
                col = self._water(bgr, dist, z1)
                cv2.fillConvexPoly(img, np.round(cam.project(np.stack(ring))).astype(np.int32),
                                   tuple(int(x) for x in col), cv2.LINE_AA)

    def _ball(self, img, c, Rwc, center):
        pc = Rwc @ (center - c)
        if pc[2] < 0.05:
            return
        dist = float(np.linalg.norm(pc))
        (u, v), = self.camera.project(pc[None])
        r = self.camera.fx * BALL_D / 2 / pc[2]
        col = tuple(int(x) for x in self._water(np.asarray(BALL_BGR) * 0.85, dist, center[2]))
        top = tuple(int(x) for x in self._water(BALL_BGR, dist, center[2]))
        cv2.circle(img, (int(round(u)), int(round(v))), max(1, int(round(r))), col, -1, cv2.LINE_AA)
        if r >= 3:
            cv2.circle(img, (int(round(u)), int(round(v - r * 0.3))), max(1, int(round(r * 0.55))), top, -1,
                       cv2.LINE_AA)

    def render(self) -> np.ndarray:
        c, Rwc = camera_pose(self.state, self.rov)
        img = floor_image(self._rays_cam, c, Rwc, (self.camera.width, self.camera.height), self.visibility,
                          self.caustics, self.time)
        for p in sorted(self.poles, key=lambda p: -np.linalg.norm(p.xy - c[:2])):  # far to near
            bgr = BASE_BGR[p.color]
            self._cylinder(img, c, Rwc, p.xy, 0.0, BASE_H, BASE_D / 2, bgr)
            ball = np.r_[p.xy, p.ball_z]
            if p.ball_z < self.pole_h:  # dropped: lies next to the pole, drawn before it
                ball[:2] += [BASE_D / 2 + BALL_D, 0.0]
                self._ball(img, c, Rwc, ball)
            self._cylinder(img, c, Rwc, p.xy, BASE_H, self.pole_h, self.pole_d / 2, bgr)
            if p.ball_z >= self.pole_h:
                self._ball(img, c, Rwc, ball)
        return img
