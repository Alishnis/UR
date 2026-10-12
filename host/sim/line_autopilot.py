"""A bot pilot that only follows the on-screen Mission 3 advice, to check the guidance and the tape counter
end to end. Run from host/:  python -m sim.line_autopilot [--tilt 30] [--effects murky] [--drift 0.03]
"""
import argparse
from dataclasses import dataclass

import numpy as np

from sim.line_sim import LineSim, pose_along
from vision.docking import RovConfig
from vision.line_detector import LineConfig, LineDetector
from vision.line_follow import LineAssistant, LineView, milestone_name
from vision.underwater_sim import PRESETS, degrade

# (along the line from the pipe start, sideways offset, ROV centre height, heading relative to the line)
# Start far enough back that the beginning of the line (the short piece before the START tape) is in view:
# closer than ~0.8 m the camera cannot see it and the START tape is not recognised as a tape.
STARTS = [(-1.0, 0.0, 0.6, 0), (-1.0, 0.25, 0.5, 15), (-1.1, -0.25, 0.7, -15), (-0.9, 0.3, 0.6, -10),
          (-1.0, -0.2, 0.45, 20)]


class Bot:
    def decide(self, view: LineView):
        """Throttle levels [surge, yaw, heave], or "stop"."""
        a = view.advice or ""
        if a.startswith("STOP"):
            return "stop"
        g = view.guidance
        if g is None:
            if a.startswith(("FINAL", "END")):
                return [1, 0, 0]
            if a.startswith("SEARCH"):
                return [0, 1, 0]
            return [0, 1 if "RIGHT" in a else -1, 0]  # LINE LOST
        surge, yaw, heave = 0, 0, 0
        for c in g.commands:
            w = c.split()
            if w[0] == "UP":
                heave = 1
            elif w[0] == "DOWN":
                heave = -1
            elif w[0] == "TURN":
                yaw = (1 if w[1] == "RIGHT" else -1) * (2 if float(w[2]) > 15 else 1)
            elif c == "FORWARD":
                surge = 2
            elif c == "FORWARD SLOWLY":
                surge = 1
        if a.startswith(("FINAL", "END")):
            surge = min(surge, 1) or 1
        return [surge, yaw, heave]


@dataclass
class RunResult:
    passed: int  # tapes the ROV really passed (whole body), furthest during the run
    counted: int  # what the on-screen counter says
    max_offset: float  # m, worst distance from the line inside the course
    floor_contacts: int
    seconds: float
    stopped: bool  # the advice said STOP by itself

    def __str__(self):
        return (f"passed {milestone_name(self.passed):5} ({self.passed}/4), counter {self.counted}/4, "
                f"max off-line {self.max_offset * 100:4.1f} cm, floor contacts {self.floor_contacts}, "
                f"{self.seconds:.1f} s{'' if self.stopped else ' (timeout)'}")


def run(start=STARTS[0], tilt: float = 30.0, line_yaw: float = 0.0, effects: str | None = None,
        smooth: float = LineConfig.smooth, dark_thresh: int = LineConfig.dark_thresh, drift: float = 0.0, dt: float = 1 / 15, max_t: float = 60.0, size=(640, 360),
        seed: int = 0, verbose: bool = False) -> RunResult:
    rov = RovConfig(cam_tilt_deg=tilt)
    sim = LineSim(rov=rov, width=size[0], height=size[1], drift=drift, line_yaw=line_yaw, seed=seed)
    sim.set_pose(*pose_along(*start, line_yaw=line_yaw))
    detector = LineDetector(LineConfig(smooth=smooth, dark_thresh=dark_thresh))
    assistant = LineAssistant(rov, sim.camera)
    bot = Bot()
    rng = np.random.default_rng(seed)
    t, stopped = 0.0, False
    while t < max_t:
        frame = sim.render()
        if effects:
            frame = degrade(frame, PRESETS[effects], rng)
        view = assistant.update(detector.detect(frame), t)
        levels = bot.decide(view)
        if levels == "stop":
            sim.levels[:] = 0
            for _ in range(15):
                sim.step(dt)
            stopped = True
            break
        sim.levels[:] = levels
        if verbose and round(t / dt) % round(1 / dt) == 0:
            along, off, head = sim.truth()
            g = view.guidance
            est = f"est off {g.offset_m:+.2f} head {g.heading_deg:+.0f}" if g else "no line"
            print(f"t={t:5.1f} along={along:+.2f} off={off:+.2f} head={head:+.0f} z={sim.state.pos[2]:.2f} "
                  f"{est} levels={levels} passed {sim.passed()} counter {view.passed} "
                  f"{view.advice or ''} {view.info or ''}")
        sim.step(dt)
        t += dt
    return RunResult(sim.status.furthest, assistant.counter.passed, sim.status.max_offset, sim.status.floor_contacts,
                     round(t, 1), stopped)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tilt", type=float, default=30.0, help="camera pitched down, deg")
    ap.add_argument("--effects", choices=list(PRESETS))
    ap.add_argument("--smooth", type=float, default=LineConfig.smooth, help="detector noise blur, px")
    ap.add_argument("--dark-thresh", type=int, default=LineConfig.dark_thresh, help="lower it in bad water")
    ap.add_argument("--drift", type=float, default=0.0, help="m/s random sideways current")
    ap.add_argument("--line-yaw", type=float, default=0.0, help="line direction vs the floor tiles, deg")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    for i, start in enumerate(STARTS):
        res = run(start, args.tilt, args.line_yaw, args.effects, args.smooth, args.dark_thresh, args.drift, seed=i,
                  verbose=args.verbose)
        print(f"start {start}: {res}")


if __name__ == "__main__":
    main()
