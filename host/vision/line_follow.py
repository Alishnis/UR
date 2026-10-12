"""Mission 3 guidance: where the line is relative to the ROV, which way to steer, and which tapes were passed.

We have no sideways thruster, so a sideways offset is fixed like steering a car: aim at a point on the line
`look_ahead_m` ahead ("carrot"). The operator still flies the ROV (manual operation is mandatory); this only
tells them what to do and offers a suggested yaw command for a future assisted mode.
"""
import math
from dataclasses import dataclass, field

import numpy as np

from vision.camera_model import CameraModel
from vision.docking import RovConfig
from vision.floor_geometry import FloorProjector
from vision.line_detector import LineCandidate, LineDetection, fit_line

MILESTONES = ("START", "CP1", "CP2", "FINAL")  # tapes along the line (props manual: the first tape is the start)
TAPE_SPACING = 0.5  # m between tapes
END_CLOSE_M = 0.4  # line lost with its far end this close to the blind zone = we reached the end
NEW_LINE_MIN_FRAC = 0.1  # a line we were not following yet must be this long (fraction of the image diagonal)
END_MARGIN_M = 0.3  # drive this much further than computed at the end (speed and height are uncertain)
STANDOUT = 1.8  # a new line must be this many times darker than the other dark lines in view
DARKNESS_KEEP = 0.5  # ignore dark lines less than half as dark as the line we follow


def milestone_name(n_passed: int) -> str:
    return MILESTONES[n_passed - 1] if n_passed > 0 else "none"


@dataclass
class LineFollowConfig:
    line_width_m: float = 0.025  # UNCONFIRMED: diameter of the black pipe - measure it at the venue
    height_guess_m: float = 0.5  # camera height above the floor, used until it can be estimated
    look_ahead_m: float = 0.5  # carrot distance; shorter = sharper corrections, longer = calmer
    turn_threshold_deg: float = 4.0  # below this just go forward
    min_clearance_m: float = 0.15  # keep this gap between the ROV bottom and the floor
    max_height_m: float = 1.0  # above this the line gets thin and the tapes are hard to see
    min_width_px: float = 8.0  # line must be at least this wide (full-frame px) to estimate the height from it


@dataclass
class LineGuidance:
    heading_deg: float  # line direction relative to our heading, + = the line goes to the right
    offset_m: float  # the line is this far to the right (+) / left (-) of the ROV centre
    steer_deg: float  # turn needed to aim at the carrot, + = right
    yaw_cmd: float  # -1..1 suggestion for an assisted yaw controller
    height_m: float | None  # camera height above the floor estimated from the line width (None = unknown)
    commands: list[str]
    aligned: bool
    floor_line: tuple[np.ndarray, np.ndarray]  # point, unit direction on the floor (m, ROV-centre frame)
    tapes_m: list[float] = field(default_factory=list)  # per cand.tapes: m ahead of the ROV centre along the line
    line_start_m: float | None = None  # the near end of the line is visible this far ahead
    line_end_m: float | None = None  # the far end of the line is visible this far ahead


def estimate_height(cand: LineCandidate, proj: FloorProjector, cfg: LineFollowConfig) -> float | None:
    """Camera height from how wide the line looks near the bottom of the image (needs the true line width)."""
    near = np.argsort(-cand.centers[:, 1])[:max(3, len(cand.centers) // 3)]
    if np.median(cand.widths[near]) < cfg.min_width_px:
        return None
    d_img = cand.direction
    n_img = np.array([-d_img[1], d_img[0]])
    half = (cand.widths[near] / 2)[:, None] * n_img
    a, b = proj.to_floor(cand.centers[near] - half), proj.to_floor(cand.centers[near] + half)
    fit = floor_fit(cand, proj)
    if fit is None:
        return None
    d = fit[1]
    across = np.abs((b - a) @ np.array([d[1], -d[0]]))  # width perpendicular to the line on the floor
    across = across[np.isfinite(across) & (across > 1e-6)]
    if len(across) < 3:
        return None
    return cfg.line_width_m / float(np.median(across))


def floor_fit(cand: LineCandidate, proj: FloorProjector):
    """Line on the floor in height units: (point, direction pointing away from the ROV)."""
    f = proj.to_floor(cand.centers)
    f = f[np.isfinite(f[:, 0])]
    if len(f) < 3:
        return None
    c, d, _, _ = fit_line(f)
    return c, (d if d[1] >= 0 else -d)


def compute_guidance(cand: LineCandidate, proj: FloorProjector, rov: RovConfig, cfg: LineFollowConfig,
                     height: float, height_known: bool) -> LineGuidance | None:
    fit = floor_fit(cand, proj)
    if fit is None:
        return None
    c, d = fit
    rov_c = np.array([0.0, -rov.length / 2])  # camera is at the nose, the ROV centre is behind it
    c = c * height - rov_c  # metres, origin at the ROV centre
    offset = float(d[1] * c[0] - d[0] * c[1])
    foot = c - d * float(c @ d)
    carrot = foot + d * cfg.look_ahead_m
    steer = math.degrees(math.atan2(carrot[0], carrot[1]))
    heading = math.degrees(math.atan2(d[0], d[1]))

    def along(px) -> float:
        p = proj.to_floor(np.asarray(px)[None])[0]
        return float((p * height - rov_c) @ d) if np.isfinite(p[0]) else float("nan")

    commands = []
    if height_known:
        clearance = height - rov.height / 2
        if clearance < cfg.min_clearance_m:
            commands.append(f"UP {(cfg.min_clearance_m - clearance) * 100:.0f} cm")
        elif height > cfg.max_height_m:
            commands.append(f"DOWN {(height - cfg.max_height_m) * 100:.0f} cm")
    side = "RIGHT" if steer > 0 else "LEFT"
    if abs(steer) <= cfg.turn_threshold_deg:
        commands.append("FORWARD")
    elif abs(steer) <= 20:
        commands += [f"TURN {side} {abs(steer):.0f} deg", "FORWARD SLOWLY"]
    else:
        commands.append(f"TURN {side} {abs(steer):.0f} deg")
    tapes = [along(t) for t in cand.tapes]  # same order as cand.tapes (NaN if above the horizon)
    return LineGuidance(
        heading_deg=heading, offset_m=offset, steer_deg=steer, yaw_cmd=float(np.clip(steer / 30, -1, 1)),
        height_m=height if height_known else None, commands=commands,
        aligned=abs(heading) < 5 and abs(offset) < 0.05, floor_line=(c, d), tapes_m=tapes,
        line_start_m=along(cand.p0) if cand.near_end_inside else None,
        line_end_m=along(cand.p1) if cand.far_end_inside else None)


@dataclass
class _Track:
    s: float  # m along the line from the ROV centre
    s0: float  # where it was first seen
    seen: int = 1
    miss: int = 0
    born_near: bool = False
    backed: bool = False


class TapeCounter:
    """Counts tapes that slide out of the bottom of the image while the ROV moves towards them.

    A tape only counts if it was getting closer while tracked, so rising (the view moves forward) or turning
    does not count. A tape that appears at the bottom and moves away means we are reversing: count back.
    """

    def __init__(self, n_tapes: int = len(MILESTONES), match_m: float = 0.15, near_margin_m: float = 0.12,
                 min_travel_m: float = 0.08, confirm: int = 3, max_miss: int = 3):
        self.n_tapes, self.match_m, self.near_margin_m = n_tapes, match_m, near_margin_m
        self.min_travel_m, self.confirm, self.max_miss = min_travel_m, confirm, max_miss
        self.reset()

    def reset(self) -> None:
        self.passed = 0
        self.tracks: list[_Track] = []
        self.dropped: list[_Track] = []  # approaching tapes lost before reaching the bottom (line got too short)

    def adjust(self, step: int) -> None:
        self.passed = int(np.clip(self.passed + step, 0, self.n_tapes))

    def update(self, tapes_m: list[float], near_m: float) -> list[tuple[str, float]]:
        """Returns events ("passed", s at exit) / ("back", s)."""
        free = list(tapes_m)
        for tr in sorted(self.tracks, key=lambda t: t.s):
            if free:
                j = int(np.argmin([abs(s - tr.s) for s in free]))
                if abs(free[j] - tr.s) < self.match_m:
                    tr.s, tr.seen, tr.miss = free.pop(j), tr.seen + 1, 0
                    continue
            tr.miss += 1
        self.tracks += [_Track(s, s, born_near=s - near_m < self.near_margin_m) for s in free]

        events, keep = [], []
        for tr in self.tracks:
            if (tr.born_near and not tr.backed and tr.seen >= self.confirm and tr.s - tr.s0 > self.min_travel_m
                    and self.passed > 0):
                tr.backed = True
                self.passed -= 1
                events.append(("back", tr.s))
            if tr.miss > self.max_miss:
                approaching = tr.seen >= self.confirm and tr.s - tr.s0 < -self.min_travel_m
                if approaching and tr.s - near_m < self.near_margin_m:
                    self.passed = min(self.passed + 1, self.n_tapes)
                    self.dropped = []
                    events.append(("passed", tr.s))
                elif approaching:
                    self.dropped.append(tr)
                continue
            keep.append(tr)
        self.tracks = keep
        return events

    def flush(self) -> int:
        """End of the line reached blind: tapes that were coming towards us are now behind. Returns how many."""
        n = len(self.dropped) + sum(1 for tr in self.tracks
                                    if tr.seen >= self.confirm and tr.s - tr.s0 < -self.min_travel_m)
        self.passed = min(self.passed + n, self.n_tapes)
        self.tracks, self.dropped = [], []
        return n


@dataclass
class LineView:
    guidance: LineGuidance | None = None
    candidate: LineCandidate | None = None
    others: list[LineCandidate] = field(default_factory=list)
    advice: str | None = None  # replaces the commands when the line is not usable (search / lost / stop)
    info: str | None = None  # extra line: tape events
    seconds_lost: float = 0.0
    height: float = 0.5
    height_source: str = "guess"
    passed: int = 0


class LineAssistant:
    """Keeps state between frames: chosen line, height estimate, tape counter, final countdown."""

    def __init__(self, rov: RovConfig, cam: CameraModel, cfg: LineFollowConfig | None = None):
        self.rov, self.cfg = rov, cfg or LineFollowConfig()
        self.proj = FloorProjector(cam, rov.cam_tilt_deg)
        self._new_min = NEW_LINE_MIN_FRAC * float(np.hypot(cam.width, cam.height))
        self.counter = TapeCounter()
        self.reset()

    def reset(self) -> None:
        self.counter.reset()
        self.height: float | None = None
        self._hint: LineCandidate | None = None
        self._line_dark: float | None = None  # how dark the followed line usually is
        self._skip = False
        self._last_seen: float | None = None
        self._last: LineGuidance | None = None
        self._info: tuple[str, float] | None = None  # text, until
        self._blind: tuple[float, float, str] | None = None  # start time, seconds to drive, "final" / "end"

    @property
    def view_height(self) -> float:
        """Camera height above the floor in use right now (estimate, or the guess before the first estimate)."""
        return self.height if self.height is not None else self.cfg.height_guess_m

    def next_candidate(self) -> None:
        """Operator says: you are following the wrong dark line (lane marking, shadow) - take another one."""
        self._skip = True
        self._line_dark = None  # the other line may be less dark

    def adjust_count(self, step: int) -> None:
        self.counter.adjust(step)
        if self.counter.passed < self.counter.n_tapes:
            self._blind = None

    def _choose(self, cands: list[LineCandidate]) -> LineCandidate | None:
        if self._line_dark is not None:
            # tile grout, shadows and lane marks are much less dark than the pipe we have been following
            cands = [c for c in cands if c.darkness >= DARKNESS_KEEP * self._line_dark]
        if not cands:
            return None
        if self._hint is not None:
            scores = [_mismatch(self._hint, c) for c in cands]
            best = int(np.argmin(scores))
            if self._skip:
                self._skip = False
                return cands[(best + 1) % len(cands)] if len(cands) > 1 else cands[best]
            if scores[best] < 80:
                return cands[best]
        return self._new_line(cands)

    def _new_line(self, cands: list[LineCandidate]) -> LineCandidate | None:
        """Lock on to a line only if it is long and clearly darker than everything else (tile grout is a grid
        of many equally faint lines - none of them stands out)."""
        long = [c for c in cands if c.length >= self._new_min]
        if not long:
            return None
        best = max(long, key=lambda c: c.darkness)
        others = [c.darkness for c in cands if c is not best]
        if others and best.darkness < STANDOUT * float(np.median(others)):
            return None
        return best

    def update(self, det: LineDetection, now: float) -> LineView:
        cand = self._choose(det.candidates)
        view = LineView(candidate=cand, others=[c for c in det.candidates if c is not cand])
        g = None
        if cand is not None:
            h_raw = estimate_height(cand, self.proj, self.cfg)
            if h_raw is not None and 0.05 < h_raw < 3.0:
                self.height = h_raw if self.height is None else 0.85 * self.height + 0.15 * h_raw
            h = self.height if self.height is not None else self.cfg.height_guess_m
            g = compute_guidance(cand, self.proj, self.rov, self.cfg, h, self.height is not None)
        h = self.view_height
        view.height = h
        view.height_source = "line width" if self.height is not None else "guess"

        near_m = self.proj.nearest_visible() * h + self.rov.length / 2
        # only count while the line is visible; when it is lost the tracks wait (the ROV may come back to it)
        tapes = [s for s in g.tapes_m if math.isfinite(s)] if g else []
        for kind, s in (self.counter.update(tapes, near_m) if g else []):
            n = self.counter.passed
            if kind == "passed":
                rest = s + self.rov.length / 2  # the tail is still this far before the tape
                self._info = (f"{MILESTONES[n - 1]} tape under the ROV - keep going ~{rest * 100:.0f} cm to pass it",
                              now + 5)
                if n == self.counter.n_tapes:
                    self._blind = (now, (rest + END_MARGIN_M) / self.rov.slow_speed, "final")
            else:
                self._info = (f"reversing: back before {MILESTONES[n]} tape", now + 3)
                self._blind = None

        if g is not None:
            self._hint, self._last, self._last_seen = cand, g, now
            self._line_dark = cand.darkness if self._line_dark is None else 0.9 * self._line_dark + 0.1 * cand.darkness
            view.guidance = g
            if self._blind is not None and self._blind[2] == "end":
                self._blind = None  # the line is back in view
        elif self._last_seen is not None:
            view.seconds_lost = now - self._last_seen
            if view.seconds_lost < 0.3:
                view.guidance = self._last  # one bad frame: keep the last numbers
            elif self._blind is None and self._last.line_end_m is not None and \
                    self._last.line_end_m < near_m + END_CLOSE_M:
                # the far end of the line slid into the blind zone in front of the ROV: we are at the end,
                # not lost. Drive on until the tail is past the end.
                rest = self._last.line_end_m + self.rov.length / 2 + END_MARGIN_M
                self._blind = (self._last_seen, rest / self.rov.slow_speed, "end")

        if self._blind is not None:
            t0, seconds, kind = self._blind
            left = seconds - (now - t0)
            what = "FINAL" if kind == "final" else "END OF LINE"
            if left > 0.5:
                view.advice = f"{what}: FORWARD SLOWLY ~{left:.0f} s more, then STOP"
            else:
                if kind == "end":
                    self.counter.flush()
                view.advice = f"STOP - {what} PASSED"
        elif view.guidance is None:
            if self._last is None:
                view.advice = "SEARCH: no line in view - turn slowly (or Tab if it is on screen but not marked)"
            else:
                side = "RIGHT" if self._last.steer_deg > 0 else "LEFT"
                view.advice = f"LINE LOST - STOP, TURN {side} slowly (last seen {side.lower()})"
        view.passed = self.counter.passed
        if self._info and now < self._info[1]:
            view.info = self._info[0]
        return view


def _mismatch(a: LineCandidate, b: LineCandidate) -> float:
    """How different two image lines are (px): distance of b's middle from line a + angle penalty."""
    mid = (b.p0 + b.p1) / 2
    v = mid - a.p0
    d = a.direction
    return abs(v[0] * d[1] - v[1] * d[0]) + 200 * abs(d[0] * b.direction[1] - d[1] * b.direction[0])
