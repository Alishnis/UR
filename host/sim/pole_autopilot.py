"""A bot pilot that only follows the on-screen Mission 5 advice, to check the detector, the guidance and the
"ball gone?" hint end to end. Run from host/:  python -m sim.pole_autopilot [--tilt 30] [--effects murky]
"""
import argparse
import math
from dataclasses import dataclass

import numpy as np

from sim.pole_sim import PoleSim
from sim.pool_sim import camera_pose
from vision.docking import RovConfig
from vision.pole_detector import COLORS, PoleDetector, range_from_click
from vision.pole_guidance import PoleAssistant, PoleView, order_text
from vision.underwater_sim import PRESETS, degrade


class Bot:
    def __init__(self):
        self.search_dir = 1

    def decide(self, view: PoleView):
        """Throttle levels [surge, yaw, heave], "hit" (press H), or "done"."""
        a = view.advice or ""
        if a.startswith("ALL DONE"):
            return "done"
        if a.startswith("BALL GONE"):
            return "hit"
        g = view.guidance
        if g is None:
            if a.startswith("BLIND"):
                return [1, 0, 0]
            if a.startswith("BACK UP"):
                return [-1, 0, 0]
            if "LEFT" in a or "RIGHT" in a:
                self.search_dir = 1 if "RIGHT" in a else -1
            return [0, self.search_dir, 1 if "go UP" in a else 0]  # search: turn on the spot
        surge, yaw, heave = 0, 0, 0
        for c in g.commands:
            w = c.split()
            if w[0] == "UP":
                heave = 1
            elif w[0] == "DOWN":
                heave = -1
            elif w[0] == "TURN":
                yaw = (1 if w[1] == "RIGHT" else -1) * (2 if float(w[2]) > 15 else 1)
            elif c == "FORWARD" or c.startswith("FORWARD towards"):
                surge = 2
            elif "FORWARD SLOWLY" in c:
                surge = 1
        return [surge, yaw, heave]


def calibrate(sim: PoleSim, detector: PoleDetector, effects: str | None, rng) -> None:
    """What the pilot does first at the pool: look at each pole from ~1.2 m and click on it."""
    saved = sim.state
    for color in COLORS:
        p = sim.pole(color)
        z = 0.4 + 1.2 * math.tan(math.radians(sim.rov.cam_tilt_deg))  # the sampled spot lands mid-image
        sim.set_pose((p.xy[0], p.xy[1] - 1.2 - sim.rov.length / 2, z), 0.0)
        frame = sim.render()
        if effects:
            frame = degrade(frame, PRESETS[effects], rng)
        c, Rwc = camera_pose(sim.state, sim.rov)
        (u, v), = sim.camera.project((Rwc @ (np.r_[p.xy, 0.4] - c))[None])
        detector.ranges[color] = range_from_click(frame, int(u), int(v))
    sim.set_pose(saved.pos, saved.yaw)


@dataclass
class RunResult:
    points: int
    text: str
    order: str
    confirmed: str  # what the pilot (bot) confirmed with H
    touches: int  # contacts with any pole
    seconds: float

    def __str__(self):
        return (f"{self.points:2} pts  order {self.order}: {self.text}; confirmed {self.confirmed or '-'}, "
                f"touches {self.touches}, {self.seconds:.0f} s")


def run(seed: int = 0, tilt: float = 30.0, effects: str | None = None, drift: float = 0.0, dt: float = 1 / 15,
        max_t: float = 240.0, size=(640, 360), calib: bool = True, visibility: float = 7.0,
        verbose: bool = False) -> RunResult:
    rov = RovConfig(cam_tilt_deg=tilt)
    sim = PoleSim(rov=rov, width=size[0], height=size[1], drift=drift, visibility=visibility, seed=seed)
    detector = PoleDetector()
    assistant = PoleAssistant(rov, sim.camera, order=sim.order)
    bot = Bot()
    rng = np.random.default_rng(seed)
    if calib:
        calibrate(sim, detector, effects, rng)
    t = 0.0
    while t < max_t:
        frame = sim.render()
        if effects:
            frame = degrade(frame, PRESETS[effects], rng)
        view = assistant.update(detector.detect(frame), t)
        action = bot.decide(view)
        if action == "done":
            break
        if action == "hit":  # the pilot looked and confirmed
            assistant.mark_hit()
            action = [0, 0, 0]
        sim.levels[:] = action
        if verbose and round(t / dt) % round(1 / dt) == 0:
            tgt = view.target
            truth = sim.truth(tgt) if tgt else (0, 0, 0)
            m = view.measures.get(tgt) if tgt else None
            est = f"est b {m.bearing_deg:+.0f} d {m.dist_m:.2f}" if m else "not seen"
            print(f"t={t:5.1f} target {tgt} truth b {truth[0]:+.0f} d {truth[1]:.2f} dz {truth[2]:+.2f} | {est} "
                  f"| {view.advice or view.guidance.commands} levels {action} ball {view.ball} "
                  f"act {sim.status.activated}")
        sim.step(dt)
        t += dt
    for _ in range(int(2 / dt)):  # let a falling ball land, so the score is final
        sim.levels[:] = 0
        sim.step(dt)
    pts, text = sim.score()
    return RunResult(pts, text, order_text(sim.order), order_text(assistant.done), len(sim.status.touches), t)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tilt", type=float, default=30.0, help="camera pitched down, deg")
    ap.add_argument("--effects", choices=list(PRESETS))
    ap.add_argument("--drift", type=float, default=0.0, help="m/s random sideways current")
    ap.add_argument("--runs", type=int, default=6, help="number of random layouts")
    ap.add_argument("--no-calib", action="store_true", help="skip the click calibration, use the default colours")
    ap.add_argument("--visibility", type=float, default=7.0, help="m, water clarity (turbid pool: 3)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    total = 0
    for seed in range(args.runs):
        res = run(seed, args.tilt, args.effects, args.drift, calib=not args.no_calib, visibility=args.visibility,
                  verbose=args.verbose)
        total += res.points
        print(f"layout {seed}: {res}")
    print(f"average {total / args.runs:.1f} / 50 pts")


if __name__ == "__main__":
    main()
