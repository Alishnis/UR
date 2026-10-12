"""A bot pilot that only follows the on-screen docking advice. Used to check the guidance logic end to end:
if a dumb bot can dock cleanly by obeying the advice, a human pilot can too.

Run from host/:  python -m sim.autopilot            (prints results for a set of start poses)
"""
import argparse

import numpy as np

from sim.pool_sim import PoolSim
from vision.apriltag_detector import DetectorConfig, TagDetector
from vision.docking import DockingAssistant, DockingView, RovConfig
from vision.tag_tracker import Rule, select_target
from vision.underwater_sim import PRESETS, degrade

STARTS = [((0.0, 0.4, 0.7), 0), ((-0.6, 0.4, 0.9), 15), ((0.7, 0.8, 0.5), -20), ((-0.3, 1.2, 1.1), 25),
          ((0.9, 0.2, 0.6), -30), ((-0.9, 0.6, 0.4), 10)]


class Bot:
    def __init__(self):
        self.backing_to = None
        self.levels = [0, 0, 0]

    def decide(self, view: DockingView):
        """Throttle levels [surge, yaw, heave], or "stop" when the advice says the ROV is docked."""
        g = view.guidance
        if self.backing_to is not None:
            if view.advice is None and g is not None and g.distance < self.backing_to:
                return [-2, 0, 0]
            self.backing_to = None
        if view.advice is not None:
            a = view.advice
            if a.startswith("SEARCH"):
                return [1, 1, 1]  # turn, creep forward and rise: parallax gets the tag clear of the pipes
            if view.seconds_lost < 0.3:
                return self.levels  # one missed frame: keep going
            if a.startswith("STOP"):
                return "stop"
            if a.startswith("BLIND"):
                return [1, 0, 0]
            return [0, 1 if "RIGHT" in a else -1, 0]
        if g is None:
            return [0, 0, 0]  # target not chosen yet (still confirming tags): hover
        surge, yaw, heave = 0, 0, 0
        for c in g.commands:
            w = c.split()
            if w[0] == "UP":
                heave = 1
            elif w[0] == "DOWN":
                heave = -1
            elif w[0] == "TURN":
                deg = float(w[2])
                yaw = (1 if w[1] == "RIGHT" else -1) * (2 if deg > 20 else 1)
                surge = 0 if deg > 25 else 1
            elif c == "FORWARD":
                surge = 2
            elif c.startswith("FORWARD SLOWLY"):
                surge = 1
            elif c.startswith("STOP - BACK"):
                surge = -1
            elif c.startswith("STOP"):
                return "stop"
            elif w[0] == "BACK":
                self.backing_to = float(w[3])
                surge = -2
        return [surge, yaw, heave]


def run(mount: str, start, yaw0: float, rule: Rule = Rule.LARGEST, ids=(17, 245, 503), dt: float = 1 / 15,
        max_t: float = 90.0, size=(640, 360), effects: str | None = None, clahe: bool = True, seed: int = 0,
        verbose: bool = False):
    """Fly one attempt; returns (points, description, contacts, seconds)."""
    rov = RovConfig()
    sim = PoolSim(list(ids), rov=rov, mount=mount, width=size[0], height=size[1], seed=seed)
    sim.set_pose(start, yaw0)
    detector, bot = TagDetector(DetectorConfig(use_clahe=clahe)), Bot()
    assistant = DockingAssistant(rov, mount, sim.camera)
    target = select_target(ids, rule)
    rng = np.random.default_rng(seed)
    t = 0.0
    while t < max_t:
        frame = sim.render()
        if effects:
            frame = degrade(frame, PRESETS[effects], rng)
        view = assistant.update(detector.detect(frame, sim.camera), t, target, set(ids))
        levels = bot.decide(view)
        if levels == "stop":
            sim.levels[:] = 0
            for _ in range(15):  # let it coast to a halt
                sim.step(dt)
            break
        bot.levels = levels
        sim.levels[:] = levels
        if verbose and round(t / dt) % round(1 / dt) == 0:
            g = view.guidance
            print(f"t={t:5.1f} pos={np.round(sim.state.pos, 2)} yaw={sim.state.yaw:+6.1f} levels={levels} "
                  f"{view.advice or g.commands}")
        sim.step(dt)
        t += dt
    points, text = sim.score(rule)
    return points, text, sim.status.contacts, round(t, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mount", choices=["above", "back"], nargs="+", default=["above", "back"])
    ap.add_argument("--effects", choices=list(PRESETS), help="underwater image effects for the detector")
    ap.add_argument("--clahe", action=argparse.BooleanOptionalAction, default=True, help="contrast boost")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    for mount in args.mount:
        for start, yaw in STARTS:
            points, text, contacts, t = run(mount, start, yaw, effects=args.effects, clahe=args.clahe,
                                            verbose=args.verbose)
            print(f"{mount:5} start {start} yaw {yaw:+4}: {points if points is not None else '-':>2} pts  "
                  f"{text}, contacts {contacts}, {t} s")


if __name__ == "__main__":
    main()
