"""Mission 2.2 docking guidance from the target tag pose.

Our ROV can only surge (forward/back), yaw (turn) and heave (up/down) - there is no sideways thruster.
A sideways offset is therefore fixed like parking a car: turn towards a point on the chamber axis,
drive, then straighten up - all before the staging distance. Inside it only small heading fixes are
possible, so a sideways error there means backing up.
"""
import math
from dataclasses import dataclass, field

import numpy as np

from vision.apriltag_detector import TAG_SIZE_M
from vision.chamber import CELL, PIPE_D, TAG_MOUNTS, entrance_in_tag


@dataclass
class RovConfig:
    width: float = 0.40  # m, widest point incl. thruster guards - MEASURE the real ROV
    height: float = 0.30  # m
    length: float = 0.45  # m
    cam_tilt_deg: float = 0.0  # camera pitched down by this angle (positive = looking down)
    safety: float = 0.7  # use only this fraction of the free gap as tolerance
    slow_speed: float = 0.10  # m/s at the slow forward throttle - MEASURE: time 1 m in the pool


@dataclass
class Tolerances:
    lateral: float  # m, allowed sideways offset of the ROV centre line from the chamber axis
    vertical: float  # m
    yaw_deg: float  # allowed heading error
    fits: bool  # False if the ROV cannot pass the opening without contact
    lateral_hard: float = 0.0  # m, physical free gap per side: beyond this the ROV WILL touch

    @classmethod
    def for_rov(cls, rov: RovConfig) -> "Tolerances":
        clear = CELL - PIPE_D
        lat = (clear - rov.width) / 2 * rov.safety
        vert = (clear - rov.height) / 2 * rov.safety
        fits = lat > 0 and vert > 0
        # a heading error swings the ROV's corners sideways by about length/2 * sin(yaw)
        yaw = math.degrees(math.asin(min(1.0, max(lat, 0) / (rov.length / 2)))) if fits else 0.0
        return cls(max(lat, 0.0), max(vert, 0.0), min(yaw, 10.0), fits, max((clear - rov.width) / 2, 0.0))


@dataclass
class Guidance:
    distance: float  # m along the chamber axis from the camera to the entrance plane (+ = entrance ahead)
    lateral: float  # m, + = ROV is to the RIGHT of the chamber axis
    vertical: float  # m, + = entrance is BELOW the camera
    yaw_deg: float  # + = chamber axis points to the right of our heading -> turn right to align
    bearing_deg: float  # direction to the entrance centre, + = right
    aligned: bool
    commands: list[str] = field(default_factory=list)  # e.g. ["TURN LEFT 12 deg", "UP 8 cm"]
    tag_bearing_deg: float = 0.0  # direction to the target tag centre, + = right


def _level_matrix(tilt_deg: float) -> np.ndarray:
    """Camera frame -> level ROV frame (x right, y down, z forward), undoing a downward camera tilt."""
    a = math.radians(tilt_deg)
    # camera pitched down by a: camera z = level z*cos(a) + level y*sin(a) (y is down)
    return np.array([[1, 0, 0], [0, math.cos(a), math.sin(a)], [0, -math.sin(a), math.cos(a)]])


def staging_distance(mount_offset: np.ndarray, vfov_deg: float, tilt_deg: float, margin: float = 0.3,
                     minimum: float = 0.8) -> float:
    """Distance from the entrance at which the ROV must already be lined up.

    With the tag mounted above the entrance, the tag leaves the top of the image when the ROV gets close
    (we fly at entrance height, the tag is higher). From there on the pilot flies blind, so lateral offset
    and heading must be fixed before that point. mount_offset = tag centre minus entrance centre (world X, Y, Z).
    """
    up = mount_offset[2] + TAG_SIZE_M / 2
    half_view_up = math.radians(vfov_deg / 2 - tilt_deg)
    blind = up / math.tan(half_view_up) - mount_offset[1] if up > 0 and half_view_up > 0 else 0.0
    return max(blind + margin, minimum)


def row_rotation(tag_positions: list[np.ndarray], t_target: np.ndarray, tilt_deg: float) -> np.ndarray | None:
    """Target tag orientation rebuilt from the line through two or more tag centres.

    A single tag's angle is noisy at range (10-20 deg), but tag positions are accurate to ~1 cm, and the three
    chamber tags sit in a row on the same frame. The chamber axis is horizontal and perpendicular to that row.
    """
    if len(tag_positions) < 2:
        return None
    L = _level_matrix(tilt_deg)
    pts = sorted((L @ p for p in tag_positions), key=lambda v: v[0])
    row = pts[-1] - pts[0]
    row[1] = 0.0
    if np.linalg.norm(row) < 0.3:  # tags too close together to be two different chambers
        return None
    row /= np.linalg.norm(row)
    axis = np.array([row[2], 0.0, -row[0]])
    if axis @ (L @ t_target) < 0:
        axis = -axis
    y_up = np.array([0.0, -1.0, 0.0])
    x_left = np.cross(y_up, axis)
    return L.T @ np.stack([x_left, y_up, axis], axis=1)


def inside_window(rov: RovConfig) -> tuple[float, float]:
    """How far the camera (ROV nose) must be past the entrance: whole ROV inside, nose clear of the back bars."""
    return rov.length + 0.03, CELL - 0.04


def travel_to_dock(g: Guidance, rov: RovConfig) -> float:
    """Metres still to drive forward (from the last guidance) until the ROV sits in the middle of the window."""
    need, limit = inside_window(rov)
    return g.distance + (need + limit) / 2


def blind_countdown(g: Guidance, rov: RovConfig, seconds_since_seen: float) -> float:
    """Seconds of SLOW forward still needed after the target tag left the image (no speed sensor: time-based)."""
    return travel_to_dock(g, rov) / rov.slow_speed - seconds_since_seen


def compute_guidance(R: np.ndarray, t: np.ndarray, entrance_tag: np.ndarray, rov: RovConfig,
                     tol: Tolerances, stage_dist: float = 1.0, view_limit_deg: float = 25.0,
                     turn_threshold_deg: float = 6.0) -> Guidance:
    """view_limit_deg: never advise a turn that would put the target tag further than this from the image
    centre (use about half the horizontal field of view minus a margin), so the tag stays in sight."""
    L = _level_matrix(rov.cam_tilt_deg)
    p_e = L @ (R @ entrance_tag + t)  # entrance centre, level ROV frame
    p_t = L @ t  # tag centre
    axis = L @ R[:, 2]  # tag z = direction into the chamber
    axis_h = np.array([axis[0], 0.0, axis[2]])
    norm = np.linalg.norm(axis_h)
    axis_h = axis_h / norm if norm > 1e-6 else np.array([0.0, 0.0, 1.0])
    right_of_axis = np.array([axis_h[2], 0.0, -axis_h[0]])

    distance = float(p_e @ axis_h)
    lateral = float(-p_e @ right_of_axis)
    vertical = float(p_e[1])
    yaw = math.degrees(math.atan2(axis_h[0], axis_h[2]))
    bearing = math.degrees(math.atan2(p_e[0], p_e[2]))
    tag_bearing = math.degrees(math.atan2(p_t[0], p_t[2]))

    cmds = []
    if abs(vertical) > tol.vertical:
        cmds.append(f"{'DOWN' if vertical > 0 else 'UP'} {abs(vertical) * 100:.0f} cm")

    def steer(desired: float, forward_cmd: str, threshold: float = turn_threshold_deg) -> str:
        # after turning by d degrees the tag appears at tag_bearing - d: keep that inside the view limit
        d = float(np.clip(desired, tag_bearing - view_limit_deg, tag_bearing + view_limit_deg))
        if abs(d) <= threshold:
            return forward_cmd
        return f"TURN {'RIGHT' if d > 0 else 'LEFT'} {abs(d):.0f} deg"

    lateral_ok = abs(lateral) <= tol.lateral
    yaw_ok = abs(yaw) <= tol.yaw_deg
    need, limit = inside_window(rov)

    def back_up(to: float) -> str:
        # reverse along the chamber axis: first turn parallel to it, otherwise reversing makes it worse
        return steer(yaw, f"BACK UP to {to:.1f} m", threshold=tol.yaw_deg)
    if distance <= 0:
        # camera (at the ROV nose) is past the entrance: the whole ROV must get in, but stop before the back bars
        inside = -distance
        if inside < need:
            cmds.append(f"FORWARD SLOWLY - {(need - inside) * 100:.0f} cm to fully inside")
        elif inside > limit:
            cmds.append(f"STOP - BACK {(inside - limit) * 100:.0f} cm")
        else:
            cmds.append("STOP - DOCKED")
    elif distance <= stage_dist:
        if abs(lateral) > tol.lateral_hard or abs(yaw) > 25:
            # sideways error cannot be fixed this close without a sideways thruster. Only give up beyond the
            # physical gap (hysteresis, so measurement noise does not cause back-and-forth)
            cmds.append(back_up(stage_dist + 0.3 + 2.0 * abs(lateral)))
        else:
            # final approach, maybe blind soon: point the nose at the final docking spot (cell centre for the
            # camera), so a small remaining offset is removed on the way. Heading precision needed shrinks
            # with the distance still to travel: 8 deg over 2 m would already drift ~30 cm
            dock_depth = (need + limit) / 2
            p_d = p_e + axis_h * dock_depth
            travel = distance + dock_depth
            precision = max(math.degrees(math.atan(max(tol.lateral, 0.02) / travel)), 0.7)
            cmds.append(steer(math.degrees(math.atan2(p_d[0], p_d[2])), "FORWARD SLOWLY", threshold=precision))
    elif not lateral_ok and distance - stage_dist < 2.0 * abs(lateral):
        # not enough room left to get onto the axis before the staging distance: make room first
        cmds.append(back_up(stage_dist + 0.3 + 2.0 * abs(lateral)))
    else:
        # pure pursuit with a "carrot" moving along the chamber axis 0.8 m ahead of us: the ROV merges
        # smoothly onto the axis instead of crossing it at an angle
        aim = p_e - axis_h * (distance - 0.8)
        cmds.append(steer(math.degrees(math.atan2(aim[0], aim[2])), "FORWARD"))

    aligned = lateral_ok and yaw_ok and abs(vertical) <= tol.vertical and distance > 0
    return Guidance(distance, lateral, vertical, yaw, bearing, aligned, cmds, tag_bearing)


def lost_advice(g: Guidance, rov: RovConfig, seconds_since_seen: float, stage_dist: float) -> str:
    """What to do when the target tag is not in the image any more."""
    if g.distance <= stage_dist + 0.3:
        # final approach: the tag left the image because we are close (normal) - finish by time
        left = blind_countdown(g, rov, seconds_since_seen)
        return f"BLIND: SLOW FORWARD ~{left:.0f} s more, then STOP" if left > 0.5 else "STOP - should be docked now"
    return f"TARGET LOST - TURN BACK {'RIGHT' if g.tag_bearing_deg > 0 else 'LEFT'}"


class RowLayout:
    """Learns where each chamber tag sits along the row, so a hidden target (e.g. behind a pipe) can be
    estimated from a visible neighbour: the cells are exactly CELL apart."""

    def __init__(self):
        self.slot: dict[int, int] = {}  # tag id -> position along the row in cells (relative, + = right)

    def update(self, poses: dict[int, tuple[np.ndarray, np.ndarray]]) -> None:
        if len(poses) < 2:
            return
        ids = list(poses)
        anchor = next((i for i in ids if i in self.slot), None)
        if anchor is None:
            anchor = min(ids, key=lambda i: poses[i][1][0])  # leftmost in the image
            self.slot[anchor] = 0
        R_a, t_a = poses[anchor]
        right = -R_a[:, 0]  # tag x points left as seen from the front
        for i in ids:
            if i not in self.slot:
                self.slot[i] = self.slot[anchor] + int(round(float((poses[i][1] - t_a) @ right) / CELL))

    def estimate(self, target: int, poses: dict[int, tuple[np.ndarray, np.ndarray]]):
        """(R, t) of the target from any visible tag with a known slot, else None."""
        if target not in self.slot:
            return None
        ref = next((i for i in poses if i != target and i in self.slot), None)
        if ref is None:
            return None
        R, t = poses[ref]
        return R, t + (self.slot[target] - self.slot[ref]) * CELL * -R[:, 0]

    def reset(self) -> None:
        self.slot.clear()


class GuidanceFilter:
    """Exponential smoothing of the target pose. A single tag seen almost head-on gives a noisy angle
    (median ~3 deg, often 6-10 deg at 720p) but a precise position (~1 cm), so the angle is smoothed much
    more strongly than the position."""

    def __init__(self, alpha_rot: float = 0.12, alpha_pos: float = 0.5):
        self.alpha_rot = alpha_rot
        self.alpha_pos = alpha_pos
        self.state: np.ndarray | None = None

    def __call__(self, R: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        z = np.concatenate([R[:, 0], R[:, 2], t])
        if self.state is None:
            self.state = z
        else:
            a = np.array([self.alpha_rot] * 6 + [self.alpha_pos] * 3)
            self.state = a * z + (1 - a) * self.state
        x_axis, z_axis = self.state[:3], self.state[3:6]
        z_axis = z_axis / np.linalg.norm(z_axis)
        x_axis = x_axis - (x_axis @ z_axis) * z_axis  # re-orthogonalise after averaging
        x_axis = x_axis / np.linalg.norm(x_axis)
        return np.stack([x_axis, np.cross(z_axis, x_axis), z_axis], axis=1), self.state[6:].copy()

    def reset(self) -> None:
        self.state = None


@dataclass
class DockingView:
    guidance: Guidance | None = None
    pose: tuple[np.ndarray, np.ndarray] | None = None  # smoothed (R, t) of the target, camera frame
    source: str = "none"  # "tag", "estimated from ID n", "lost", "none"
    advice: str | None = None  # what to do while the target is not visible
    seconds_lost: float = 0.0


class DockingAssistant:
    """Everything between tag detections and the advice shown to the pilot (used by the app, tests and bots)."""

    def __init__(self, rov: RovConfig, mount: str, camera, use_row: bool = True):
        self.rov = rov
        self.tol = Tolerances.for_rov(rov)
        self.entrance = entrance_in_tag(mount)
        self.stage = staging_distance(TAG_MOUNTS[mount], camera.vfov_deg, rov.cam_tilt_deg)
        self.view_limit = max(camera.hfov_deg / 2 - 10, 5.0)
        self.use_row = use_row
        self.layout = RowLayout()
        self.filter = GuidanceFilter()
        self.target: int | None = None
        self.last: Guidance | None = None
        self.last_seen: float | None = None

    def reset(self) -> None:
        self.layout.reset()
        self.filter.reset()
        self.target, self.last, self.last_seen = None, None, None

    def update(self, detections, now: float, target: int | None, trusted_ids) -> DockingView:
        poses = {d.id: (d.R, d.t) for d in detections if d.id in trusted_ids and d.R is not None}
        self.layout.update(poses)
        if target != self.target:
            self.filter.reset()
            self.target, self.last, self.last_seen = target, None, None
        if target is None:
            return DockingView()

        source = "tag"
        if target in poses:
            R, t = poses[target]
        else:
            est = self.layout.estimate(target, poses)
            if est is None:
                return self._lost(now)
            R, t = est
            source = f"estimated from ID {next(i for i in poses if i in self.layout.slot)}"
        if self.use_row and len(poses) >= 2:
            R_row = row_rotation([p[1] for p in poses.values()], t, self.rov.cam_tilt_deg)
            if R_row is not None:
                R = R_row
        pose = self.filter(R, t)
        self.last = compute_guidance(*pose, self.entrance, self.rov, self.tol, self.stage, self.view_limit)
        self.last_seen = now
        return DockingView(self.last, pose, source)

    def _lost(self, now: float) -> DockingView:
        if self.last is None:
            return DockingView(source="lost", advice="SEARCH: target not seen yet - turn slowly; if hidden by a pipe, move up/down or sideways")
        lost_for = now - self.last_seen
        return DockingView(self.last, None, "lost", lost_advice(self.last, self.rov, lost_for, self.stage), lost_for)
