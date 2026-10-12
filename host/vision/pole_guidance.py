"""Mission 5 guidance: which pole is next in the announced order, and how to fly to its ball.

Geometry from one camera, no depth sensor: the pole diameter is known, so its width in pixels gives the
distance; the image row of the pole top gives the top's height relative to the camera (the camera tilt is
undone first). The pilot flies; this only shows the next target and what to do.

Approach ("glide path"): with a camera pitched down, a ball at camera height is above the image top. So far
away the ROV stays high enough to keep the ball in view and descends while closing in, ending with the camera
AIM_ABOVE over the ball so the front of the ROV hits it. The last ~0.5 m may be blind; then the last
measurement and the slow speed give a countdown.
"""
import math
from dataclasses import dataclass, field

import numpy as np

from vision.camera_model import CameraModel
from vision.docking import RovConfig, _level_matrix
from vision.pole_detector import LETTER, Pole, PoleDetection


def parse_order(text: str) -> list[str]:
    """'R-B-Y' (or 'rby', 'R B Y') -> ['red', 'blue', 'yellow']. Each colour exactly once."""
    letters = [ch for ch in text.upper() if ch.isalpha()]
    if sorted(letters) != sorted(LETTER) or len(letters) != 3:
        raise ValueError(f"order must use R, Y and B once each, like R-B-Y (got {text!r})")
    return [LETTER[ch] for ch in letters]


def order_text(order: list[str]) -> str:
    return "-".join(c[0].upper() for c in order)


@dataclass
class PoleGuideConfig:
    pole_d_m: float = 0.05  # pole diameter - UNCONFIRMED, measure at the venue (sets every distance)
    ball_d_m: float = 0.0427  # golf ball
    pole_h_m: float = 0.60  # top of the pole above the floor - UNCONFIRMED (props drawing 0.6 m, text "~1 m");
                            # only used when the top is out of view and the bottom is visible
    aim_above_m: float = 0.08  # camera this much above the ball centre at the hit (front of the ROV hits it)
    max_above_m: float = 0.8  # never ask to climb higher than this above the ball (steep camera, far away)
    view_margin_deg: float = 4.0  # keep the ball at least this far below the image top while approaching
    lateral_tol_m: float = 0.08  # allowed sideways miss of the ball at the hit
    vertical_tol_m: float = 0.06
    slow_dist_m: float = 1.0  # closer than this: slow forward
    hit_dist_m: float = 0.35  # closer than this: the final push
    blind_dist_m: float = 0.9  # target lost closer than this = we are at it (count down), not "search"
    blind_extra_m: float = 0.12  # push this much further than measured (speed-up lag, the pole stops us anyway)
    group_dist_m: float = 1.0  # target not seen: approach the other poles to about this distance and look again
    search_turn_s: float = 32.0  # one full turn on the spot at the slow yaw throttle - MEASURE (sim: 11 deg/s)
    search_rise_s: float = 6.0  # steep camera: rise this long at the slow heave throttle when the search starts
    ball_gone_s: float = 0.7  # ball not seen on a visible top this long -> ask the pilot whether it dropped
    backoff_m: float = 0.7  # after a hit: back away this far before turning (poles stand ~0.7 m apart)


@dataclass
class PoleMeasure:
    color: str
    bearing_deg: float  # + = to the right
    dist_m: float  # horizontal, camera to the pole axis
    top_dz_m: float | None  # pole top minus camera height, None if the top is above the image
    bottom_dz_m: float | None  # pole bottom (floor) minus camera height, None if below the image
    xz: np.ndarray  # level frame position (x right, z forward), m
    pole: Pole


@dataclass
class PoleGuidance:
    commands: list[str]
    aligned: bool  # heading and height fine
    vertical_m: float | None  # + = go up
    warning: str | None = None  # another pole in the way


@dataclass
class PoleView:
    order: list[str] = field(default_factory=list)
    done: list[str] = field(default_factory=list)
    target: str | None = None
    measures: dict[str, PoleMeasure] = field(default_factory=dict)
    guidance: PoleGuidance | None = None
    advice: str | None = None  # when there is nothing to steer by (search, blind, done)
    ball: str = "not visible"  # "on top", "GONE?", "not visible"
    seconds_lost: float = 0.0


def measure(pole: Pole, cam: CameraModel, tilt_deg: float, cfg: PoleGuideConfig) -> PoleMeasure:
    L = _level_matrix(tilt_deg)
    Kinv = np.linalg.inv(cam.K)
    z_cam = cam.fx * cfg.pole_d_m / max(pole.width_px, 1.0)  # depth along the optical axis
    p = L @ (Kinv @ np.r_[pole.mid, 1.0] * z_cam)
    dist = float(math.hypot(p[0], p[2]))

    def dz(px) -> float:
        d = L @ (Kinv @ np.r_[px, 1.0])
        return float(-d[1] / math.hypot(d[0], d[2]) * dist)
    return PoleMeasure(pole.color, math.degrees(math.atan2(p[0], p[2])), dist,
                       None if pole.top_cut else dz(pole.top), None if pole.bottom_cut else dz(pole.bottom),
                       np.array([p[0], p[2]]), pole)


def ball_height(m: PoleMeasure, cfg: PoleGuideConfig) -> float | None:
    """Ball centre minus camera height: from the top if visible, else from the floor and the pole height."""
    if m.top_dz_m is not None:
        return m.top_dz_m + cfg.ball_d_m / 2
    if m.bottom_dz_m is not None:
        return m.bottom_dz_m + cfg.pole_h_m + cfg.ball_d_m / 2
    return None


def glide_height(dist: float, cam: CameraModel, tilt_deg: float, cfg: PoleGuideConfig) -> float:
    """How far above the ball the camera should be at this distance, to keep the ball inside the image."""
    below_top = math.radians(tilt_deg - cam.vfov_deg / 2 + cfg.view_margin_deg)  # image top, below horizontal
    if below_top <= 0:
        return cfg.aim_above_m
    return min(max(cfg.aim_above_m, dist * math.tan(below_top)), cfg.max_above_m)


def blind_zone(cam: CameraModel, tilt_deg: float, cfg: PoleGuideConfig) -> float:
    """Distance below which the ball (at the final height) is above the image top."""
    below_top = math.radians(tilt_deg - cam.vfov_deg / 2)
    return cfg.aim_above_m / math.tan(below_top) if below_top > 0 else 0.0


def compute_guidance(m: PoleMeasure, others: list[PoleMeasure], cam: CameraModel, rov: RovConfig,
                     cfg: PoleGuideConfig) -> PoleGuidance:
    cmds = []
    dist = m.dist_m
    vertical = None
    vert_ok = True
    ball_dz = ball_height(m, cfg)
    if ball_dz is not None and (m.top_dz_m is not None or dist > blind_zone(cam, rov.cam_tilt_deg, cfg) + 0.15):
        vertical = ball_dz + glide_height(dist, cam, rov.cam_tilt_deg, cfg)
        tol = max(cfg.vertical_tol_m, 0.05 * dist)
        if abs(vertical) > tol:
            cmds.append(f"{'UP' if vertical > 0 else 'DOWN'} {abs(vertical) * 100:.0f} cm")
            vert_ok = False
    elif dist > blind_zone(cam, rov.cam_tilt_deg, cfg) + 0.15:
        cmds.append("UP (top above view)")
        vert_ok = False
    # else: close and the top left the image as planned - keep the depth

    # another pole between us and the target: steer past it on the side away from it
    warning, aim = None, m.xz
    path = m.xz / max(np.linalg.norm(m.xz), 1e-6)
    for o in others:
        along = float(o.xz @ path)
        side = float(o.xz[0] * path[1] - o.xz[1] * path[0])  # + = other pole is right of the path
        clear = rov.width / 2 + cfg.pole_d_m / 2 + 0.05
        if 0 < along < dist - cfg.pole_d_m and abs(side) < clear:
            go = "LEFT" if side > 0 else "RIGHT"
            warning = f"{o.color.upper()} POLE IN THE WAY - pass it on the {go}"
            left = np.array([-path[1], path[0]])  # (x right, z forward): left of the path
            aim = o.xz + (left if side > 0 else -left) * (clear + 0.15)
            break
    bearing = math.degrees(math.atan2(aim[0], aim[1]))
    thresh = min(12.0, max(2.0, math.degrees(math.atan(cfg.lateral_tol_m / max(dist, 0.3)))))
    heading_ok = abs(bearing) <= thresh
    if not heading_ok:
        cmds.append(f"TURN {'RIGHT' if bearing > 0 else 'LEFT'} {abs(bearing):.0f} deg")
    if abs(bearing) <= 3 * thresh and (vert_ok or dist > cfg.slow_dist_m):
        surface = dist - cfg.pole_d_m / 2
        if warning:
            cmds.append("FORWARD SLOWLY")
        elif surface > cfg.slow_dist_m:
            cmds.append("FORWARD")
        elif surface > cfg.hit_dist_m:
            cmds.append("FORWARD SLOWLY")
        else:
            cmds.append("HIT: FORWARD SLOWLY")
    return PoleGuidance(cmds, heading_ok and vert_ok, vertical, warning)


class PoleAssistant:
    """Order, progress and advice (used by the app, the tests and the bot)."""

    def __init__(self, rov: RovConfig, cam: CameraModel, cfg: PoleGuideConfig | None = None,
                 order: list[str] | None = None):
        self.rov, self.cam = rov, cam
        self.cfg = cfg or PoleGuideConfig()
        self.order: list[str] = list(order or [])
        self.reset()

    def _reset_target(self) -> None:
        self.last: PoleMeasure | None = None
        self.last_seen: float | None = None
        self.ball_seen = False  # ball seen on the current target at least once
        self.ball_missing_since: float | None = None
        self.checking = False  # the blind push is over: back up and look whether the ball dropped
        self.search_since: float | None = None  # target out of view since

    def reset(self) -> None:
        self.done = []
        self.hit_time: float | None = None  # when the last hit was confirmed (for the back-off countdown)
        self._now = 0.0
        self._reset_target()

    def set_order(self, order: list[str]) -> None:
        self.order = list(order)
        self.reset()

    @property
    def target(self) -> str | None:
        return next((c for c in self.order if c not in self.done), None)

    def mark_hit(self) -> str | None:
        """Pilot confirms the current target's ball dropped; returns the next target."""
        if self.target is not None:
            self.done.append(self.target)
            self._reset_target()
            self.hit_time = self._now
        return self.target

    def undo(self) -> None:
        if self.done:
            self.done.pop()
            self._reset_target()

    def update(self, det: PoleDetection, now: float) -> PoleView:
        self._now = now
        tilt = self.rov.cam_tilt_deg
        measures = {c: measure(p, self.cam, tilt, self.cfg) for c, p in det.poles.items()}
        view = PoleView(list(self.order), list(self.done), self.target, measures)
        if not self.order:
            view.advice = "ENTER THE ORDER: press O, then R / Y / B"
            return view
        target = self.target
        if target is None:
            view.advice = f"ALL DONE ({order_text(self.order)}) - fly back to the start"
            return view
        if self.hit_time is not None:
            left = self.cfg.backoff_m / self.rov.slow_speed - (now - self.hit_time)
            if left > 0.5:
                view.advice = f"BACK UP SLOWLY ~{left:.0f} s (clear of the pole), then find {target.upper()}"
                return view
            self.hit_time = None
        m = measures.get(target)
        if m is not None and self._jump(m, now):
            m = None  # a sudden jump in distance is a wrong blob (e.g. a stub of the pole at the image edge)
        if m is not None:
            self.last, self.last_seen, self.search_since = m, now, None
            view.ball = self._ball_state(m.pole, now)
            if view.ball == "GONE?":
                view.advice = f"BALL GONE? press H if the {target.upper()} ball dropped"
                self.checking = False
            elif self.checking and view.ball == "on top":
                self.checking = False  # missed: the ball is still there, approach again
            if self.checking:
                view.advice = "BACK UP SLOWLY until the pole top is in view - did the ball drop?"
                return view
            others = [o for c, o in measures.items() if c != target]
            view.guidance = compute_guidance(m, others, self.cam, self.rov, self.cfg)
            return view
        if self.search_since is None:
            self.search_since = now
        # first a full turn on the spot; if that did not find it, it is too far / too dark to see: fly towards
        # the other poles (they stand together) until close to them, then turn a full circle again
        if now - self.search_since > self.cfg.search_turn_s and (self.last is None
                                                                 or self.last.dist_m > self.cfg.blind_dist_m):
            others = [o for c, o in measures.items() if c != target]
            if others and min(o.dist_m for o in others) < self.cfg.group_dist_m:
                self.search_since = now  # at the group now: look around from here
            elif others:
                view.guidance = self._approach_group(others)
                view.advice = f"{target.upper()} NOT FOUND after a full turn - approach the other poles, look again"
                return view
        if self.last is None:
            view.advice = f"SEARCH: turn slowly a full circle to find the {target.upper()} pole"
            # camera pitched steeply down: from mid-depth it sees only ~2 m of floor. Rising a little helps,
            # rising to the surface does not (the poles then sit at the image bottom), so only ~30 cm
            if self.rov.cam_tilt_deg - self.cam.vfov_deg / 2 > 15 and now - self.search_since < self.cfg.search_rise_s:
                view.advice += " - and go UP ~30 cm to see farther"
            return view
        lost = now - self.last_seen
        view.seconds_lost = lost
        if self.last.dist_m < self.cfg.blind_dist_m:
            left = (self.last.dist_m - self.cfg.pole_d_m / 2 + self.cfg.blind_extra_m) / self.rov.slow_speed - lost
            if left > 0.5 and not self.checking:
                view.advice = f"BLIND: FORWARD SLOWLY ~{left:.0f} s more - should touch the top"
            else:
                self.checking = True
                view.advice = "BACK UP SLOWLY until the pole top is in view - did the ball drop? (H = yes)"
        else:
            side = "RIGHT" if self.last.bearing_deg > 0 else "LEFT"
            view.advice = f"TARGET LOST - TURN {side} slowly (last seen there)"
        return view

    def _approach_group(self, others: list[PoleMeasure]) -> PoleGuidance:
        """Target not visible but other poles are, far away: fly towards them (red fades first underwater)."""
        # aim between them: the missing pole may be at the far end of the row
        mid = np.mean([o.xz for o in others], axis=0)
        bearing = math.degrees(math.atan2(mid[0], mid[1]))
        near = min(o.dist_m for o in others)
        names = " / ".join(o.color.upper() for o in others)
        cmds = [f"TURN {'RIGHT' if bearing > 0 else 'LEFT'} {abs(bearing):.0f} deg"] if abs(bearing) > 8 else []
        if abs(bearing) < 25:
            cmds.append(f"FORWARD towards {names}" if near > 2.5 else f"FORWARD SLOWLY towards {names}")
        return PoleGuidance(cmds, False, None)

    def _jump(self, m: PoleMeasure, now: float) -> bool:
        last = self.last
        return (last is not None and now - self.last_seen < 1.0
                and abs(m.dist_m - last.dist_m) > 0.3 + 0.3 * last.dist_m)

    def _ball_state(self, pole: Pole, now: float) -> str:
        if not pole.ball_checked:
            return "not visible"
        if pole.ball is not None:
            self.ball_seen = True
            self.ball_missing_since = None
            return "on top"
        if self.ball_missing_since is None:
            self.ball_missing_since = now
        # only after the push: in murky water a far ball fades into the background and would look "gone"
        if self.checking and now - self.ball_missing_since >= self.cfg.ball_gone_s:
            return "GONE?"
        return "not visible"
