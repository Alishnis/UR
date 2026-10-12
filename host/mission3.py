"""Mission 3 - line following assistant (the pilot flies manually, this only shows what to do). Run from host/:
    python mission3.py                                   # pool-floor simulator
    python mission3.py --source 0 --cam-tilt 30          # real camera (better: --calib camera.json)

Keys: N new attempt | + / - correct the tape counter | Tab follow another dark line | [ / ] darkness threshold
      M mask view | Space pause | P screenshot | V underwater effects | 1 2 3 effects preset | G fullscreen | Q quit
Simulator driving (throttle steps like the real ESCs): W/S forward/back, A/D turn, R/F up/down, X all stop
"""
import argparse
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from sim.line_sim import LineSim
from sim.pool_sim import THROTTLE_STEPS
from ui import (CYAN, GREEN, GREY, MAGENTA, ORANGE, RED, WHITE, YELLOW, FrameSource, fit_height, put_text,
                save_capture, shade_rect)
from vision.camera_model import CameraModel, Undistorter
from vision.docking import RovConfig
from vision.line_detector import LineConfig, LineDetector, LineDetection
from vision.line_follow import MILESTONES, LineAssistant, LineFollowConfig, LineView, milestone_name
from vision.underwater_sim import PRESETS, SimControls, degrade, preset_name

WINDOW = "Mission 3 - Line following"
TAB_KEY = 9


@dataclass
class AppState:
    paused: bool = False
    fps: float = 0.0
    effects: str | None = None
    show_mask: bool = False
    view: LineView = field(default_factory=LineView)
    detection: LineDetection | None = None


def to_px(assistant: LineAssistant, pts_m) -> np.ndarray:
    """Floor points in metres (ROV-centre frame: x right, y forward) -> image pixels."""
    pts = np.asarray(pts_m, np.float64).reshape(-1, 2) + [0.0, -assistant.rov.length / 2]  # camera at the nose
    return assistant.proj.to_image(pts / assistant.view_height)


def draw_floor_guides(out, assistant: LineAssistant, view: LineView) -> None:
    """Where the ROV will go if it keeps straight (its width), with 50 cm ticks, and the carrot to steer at."""
    half = assistant.rov.width / 2
    ys = np.linspace(0.0, 2.5, 26)
    for x in (-half, half):
        px = to_px(assistant, np.c_[np.full_like(ys, x), ys])
        px = px[np.isfinite(px[:, 0])].astype(np.int32)
        if len(px) > 1:
            cv2.polylines(out, [px.reshape(-1, 1, 2)], False, WHITE, 1, cv2.LINE_AA)
    for y in (0.5, 1.0, 1.5, 2.0):
        a, b = to_px(assistant, [[-half, y], [half, y]])
        if np.isfinite(a).all() and np.isfinite(b).all():
            cv2.line(out, tuple(a.astype(int)), tuple(b.astype(int)), GREY, 1, cv2.LINE_AA)
            put_text(out, f"{y:.1f} m", (int(b[0]) + 6, int(b[1]) + 5), 0.45, GREY, 1)
    g = view.guidance
    if g is not None:
        c, d = g.floor_line
        carrot = c - d * float(c @ d) + d * assistant.cfg.look_ahead_m
        p = to_px(assistant, carrot)[0]
        if np.isfinite(p).all():
            cv2.drawMarker(out, tuple(p.astype(int)), CYAN, cv2.MARKER_CROSS, 34, 3)
            put_text(out, "aim here", (int(p[0]) + 18, int(p[1]) - 10), 0.55, CYAN, 2)


def draw_line(out, view: LineView) -> None:
    for other in view.others:
        cv2.line(out, tuple(other.p0.astype(int)), tuple(other.p1.astype(int)), GREY, 1, cv2.LINE_AA)
    cand = view.candidate
    if cand is None:
        return
    g = view.guidance
    color = GREEN if g is not None and g.aligned else MAGENTA
    pts = cand.centers.astype(np.int32)
    cv2.polylines(out, [pts.reshape(-1, 1, 2)], False, color, 3, cv2.LINE_AA)
    if cand.near_end_inside:
        cv2.circle(out, tuple(cand.p0.astype(int)), 10, CYAN, 3)
        put_text(out, "LINE BEGINS", (int(cand.p0[0]) + 14, int(cand.p0[1])), 0.6, CYAN, 2)
    if cand.far_end_inside:
        cv2.circle(out, tuple(cand.p1.astype(int)), 10, RED, 3)
        put_text(out, "END", (int(cand.p1[0]) + 14, int(cand.p1[1])), 0.6, RED, 2)
    if g is None:
        return
    # label the visible tapes with the milestone they will be, nearest first
    ahead = sorted(((s, px) for s, px in zip(g.tapes_m, cand.tapes) if np.isfinite(s)), key=lambda it: it[0])
    for k, (s, px) in enumerate(ahead):
        idx = view.passed + k
        name = MILESTONES[idx] if idx < len(MILESTONES) else "extra?"
        cv2.circle(out, tuple(px.astype(int)), 16, YELLOW, 3)
        put_text(out, f"{name} {s * 100:.0f} cm", (int(px[0]) + 22, int(px[1]) + 6), 0.6, YELLOW, 2)


def draw_overlay(frame, state: AppState, assistant: LineAssistant, detector: LineDetector,
                 sim: LineSim | None) -> np.ndarray:
    out = frame.copy()
    h, w = out.shape[:2]
    view = state.view
    draw_floor_guides(out, assistant, view)
    draw_line(out, view)

    shade_rect(out, (0, 0), (620, 330))
    put_text(out, "MISSION 3  LINE FOLLOW  (pilot flies manually)", (15, 30), 0.65, WHITE, 2)
    n = view.passed
    put_text(out, f"TAPES PASSED {n}/{len(MILESTONES)}: {milestone_name(n)}", (15, 68), 0.9,
             GREEN if n == len(MILESTONES) else WHITE, 2)
    g = view.guidance
    stale = view.seconds_lost > 0
    if g is not None:
        tol_ok = abs(g.heading_deg) < 5, abs(g.offset_m) < 0.05
        put_text(out, f"HEADING {g.heading_deg:+.0f} deg", (15, 105), 0.7,
                 GREY if stale else (GREEN if tol_ok[0] else ORANGE), 2)
        put_text(out, f"OFFSET {g.offset_m * 100:+.0f} cm", (250, 105), 0.7,
                 GREY if stale else (GREEN if tol_ok[1] else ORANGE), 2)
        put_text(out, "(+ = line is to the right)", (430, 105), 0.45, GREY, 1)
    put_text(out, f"HEIGHT ~{view.height * 100:.0f} cm ({view.height_source})", (15, 138), 0.6,
             WHITE if view.height_source == "line width" else GREY, 1)
    if view.advice is not None:
        color = GREEN if view.advice.startswith("STOP") else YELLOW
        put_text(out, view.advice, (15, 185), 0.6 if len(view.advice) < 52 else 0.5, color, 2)
    elif g is not None:
        main = "  |  ".join(g.commands)
        put_text(out, main, (15, 185), 0.9 if len(main) < 30 else 0.7, GREEN if g.aligned else YELLOW, 2)
    if g is not None:  # suggested yaw, as a bar (for the future assisted mode)
        cx, y = 230, 220
        put_text(out, "STEER", (15, y + 5), 0.6, WHITE, 1)
        cv2.rectangle(out, (cx - 120, y - 10), (cx + 120, y + 10), GREY, 1)
        bar = int(120 * g.yaw_cmd)
        cv2.rectangle(out, (cx, y - 10), (cx + bar, y + 10), CYAN, -1)
        cv2.line(out, (cx, y - 14), (cx, y + 14), WHITE, 2)
    if view.info:
        put_text(out, view.info, (15, 262), 0.55, CYAN, 2)
    det = state.detection
    if det is not None:
        put_text(out, f"darkness thr {detector.cfg.dark_thresh} (used {det.threshold:.0f})  lines {len(det.candidates)}",
                 (15, 300), 0.5, GREY, 1)

    if state.show_mask and det is not None:
        inset = cv2.cvtColor(det.mask, cv2.COLOR_GRAY2BGR)
        iw = w // 4
        inset = cv2.resize(inset, (iw, iw * inset.shape[0] // inset.shape[1]), interpolation=cv2.INTER_NEAREST)
        y0 = h - 70 - inset.shape[0]
        out[y0:y0 + inset.shape[0], w - iw - 10:w - 10] = inset
        put_text(out, "detector mask", (w - iw - 5, y0 + 20), 0.5, YELLOW, 1)

    if sim is not None:
        draw_sim_panel(out, sim)
    shade_rect(out, (0, h - 62), (w, h))
    status = f"{state.fps:4.1f} FPS  cam tilt {assistant.rov.cam_tilt_deg:.0f} deg"
    if state.effects:
        status += f"  EFFECTS {state.effects}"
    if state.paused:
        status += "  PAUSED"
    put_text(out, status, (15, h - 40), 0.6, WHITE, 1)
    keys = "N new  +/- tapes  Tab other line  [ ] threshold  M mask  Space pause  P shot  V fx 1/2/3  G full  Q quit"
    if sim is not None:
        keys = "W/S A/D R/F X  |  " + keys
    put_text(out, keys, (15, h - 15), 0.5, GREY, 1)
    return out


def draw_sim_panel(out, sim: LineSim) -> None:
    w = out.shape[1]
    x0 = w - 330
    shade_rect(out, (x0 - 10, 0), (w, 245))
    put_text(out, "SIMULATOR (truth)", (x0, 30), 0.7, WHITE, 2)
    for row, (name, level) in enumerate(zip(("surge", "yaw", "heave"), sim.levels)):
        y = 60 + row * 30
        put_text(out, f"{name:5}", (x0, y), 0.6, WHITE, 1)
        cx = x0 + 160
        cv2.rectangle(out, (cx - 90, y - 14), (cx + 90, y), GREY, 1)
        bar = int(90 * level / THROTTLE_STEPS)
        cv2.rectangle(out, (cx, y - 14), (cx + bar, y), YELLOW if level else GREY, -1)
        put_text(out, f"{level:+d}", (cx + 100, y), 0.6, WHITE, 1)
    along, offset, heading = sim.truth()
    put_text(out, f"heading {heading:+.0f} deg  offset {offset * 100:+.0f} cm", (x0, 160), 0.55, WHITE, 1)
    put_text(out, f"height {sim.camera_height() * 100:.0f} cm", (x0, 185), 0.55, WHITE, 1)
    st = sim.status
    put_text(out, f"REFEREE: furthest {milestone_name(st.furthest)}", (x0, 212), 0.6,
             GREEN if st.furthest == len(MILESTONES) else WHITE, 2)
    put_text(out, f"max off-line {st.max_offset * 100:.0f} cm  floor hits {st.floor_contacts}", (x0, 237), 0.5,
             RED if st.floor_contact else GREY, 1)


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="sim", help="'sim' (default), camera index, URL, video or image file")
    ap.add_argument("--cam-tilt", type=float, default=30.0,
                    help="deg the camera is pitched DOWN - MEASURE on the ROV (phone level app on the camera)")
    ap.add_argument("--rov-width", type=float, default=0.40, help="m")
    ap.add_argument("--rov-height", type=float, default=0.30, help="m")
    ap.add_argument("--rov-length", type=float, default=0.45, help="m (the camera is assumed at the front)")
    ap.add_argument("--slow-speed", type=float, default=0.10, help="m/s at slow forward throttle, MEASURE in pool")
    ap.add_argument("--calib", help="camera calibration json from tools.calibrate_camera")
    ap.add_argument("--hfov", type=float, default=70.0, help="horizontal field of view if no --calib")
    ap.add_argument("--water", action="store_true", help="camera calibrated in air but used underwater")
    ap.add_argument("--line-width", type=float, default=LineFollowConfig.line_width_m,
                    help="m, diameter of the black pipe - MEASURE at the venue (sets the height estimate)")
    ap.add_argument("--height-guess", type=float, default=LineFollowConfig.height_guess_m,
                    help="m, camera height above the floor until it can be estimated")
    ap.add_argument("--look-ahead", type=float, default=LineFollowConfig.look_ahead_m, help="m, carrot distance")
    ap.add_argument("--dark-thresh", type=int, default=LineConfig.dark_thresh, help="lower in murky water ([ ])")
    ap.add_argument("--smooth", type=float, default=LineConfig.smooth, help="noise blur, raise in noisy water")
    ap.add_argument("--flip", action="store_true")
    ap.add_argument("--effects", choices=list(PRESETS), help="start with underwater image effects")
    sim = ap.add_argument_group("simulator")
    sim.add_argument("--visibility", type=float, default=7.0, help="m, water clarity in the render")
    sim.add_argument("--drift", type=float, default=0.0, help="m/s of random sideways current, e.g. 0.03")
    sim.add_argument("--caustics", type=float, default=0.3, help="0..1 moving light ripples on the floor")
    sim.add_argument("--line-yaw", type=float, default=0.0, help="deg, line direction vs the floor tiles")
    sim.add_argument("--seed", type=int, help="random seed for the start pose")
    return ap.parse_args()


def make_camera(args, frame) -> CameraModel:
    h, w = frame.shape[:2]
    cam = (CameraModel.load(args.calib) if args.calib else CameraModel.from_hfov(w, h, args.hfov)).scaled_to(w, h)
    if args.water:
        cam = cam.in_water()
    print(f"Camera model: fx={cam.fx:.0f} fy={cam.fy:.0f} HFOV={cam.hfov_deg:.0f} deg")
    return cam


def main():
    args = parse_args()
    rov = RovConfig(width=args.rov_width, height=args.rov_height, length=args.rov_length,
                    cam_tilt_deg=args.cam_tilt, slow_speed=args.slow_speed)
    follow_cfg = LineFollowConfig(line_width_m=args.line_width, height_guess_m=args.height_guess,
                                  look_ahead_m=args.look_ahead)
    detector = LineDetector(LineConfig(dark_thresh=args.dark_thresh, smooth=args.smooth))
    state = AppState()
    if args.cam_tilt < 15:
        print(f"WARNING: camera tilt {args.cam_tilt:.0f} deg - the floor near the ROV is not visible, "
              "line following works badly (simulator: 20-45 deg is fine)")

    sim, source, cam, undistort, assistant = None, None, None, None, None
    if args.source == "sim":
        sim = LineSim(rov=rov, visibility=args.visibility, drift=args.drift, caustics=args.caustics,
                      line_yaw=args.line_yaw, seed=args.seed)
        cam = sim.camera
        assistant = LineAssistant(rov, cam, follow_cfg)
    else:
        source = FrameSource(args.source)

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WINDOW, 1280, 720)
    fx_controls = SimControls(PRESETS[args.effects]) if args.effects else None
    effects_on = args.effects is not None
    rng = np.random.default_rng()
    fullscreen = False
    last = time.monotonic()
    frame = None

    try:
        while True:
            now = time.monotonic()
            dt, last = now - last, now
            if not state.paused:
                if sim is not None:
                    sim.step(dt)
                    frame = sim.render()
                else:
                    ok, raw = source.read()
                    if not ok:
                        cv2.waitKey(20)
                        continue
                    frame = fit_height(raw)
                    if cam is None:
                        cam = make_camera(args, frame)
                        undistort = Undistorter(cam)
                        assistant = LineAssistant(rov, cam, follow_cfg)
                    frame = undistort(frame)
                if args.flip:
                    frame = cv2.flip(frame, 1)
                state.effects = None
                if effects_on:
                    params = fx_controls.read()
                    frame = degrade(frame, params, rng)
                    state.effects = preset_name(params)

                state.detection = detector.detect(frame)
                state.view = assistant.update(state.detection, now)
                if dt > 0:
                    state.fps = 0.9 * state.fps + 0.1 / dt if state.fps else 1 / dt

            shown = draw_overlay(frame, state, assistant, detector, sim)
            cv2.imshow(WINDOW, shown)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27) or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break
            if sim is not None and not state.paused and sim.handle_key(key):
                continue
            if key == ord("n"):
                assistant.reset()
                state.view = LineView()
                if sim is not None:
                    sim.reset()
                print("New attempt: tape counter reset" + (", simulator reset" if sim else ""))
            elif key in (ord("+"), ord("=")):
                assistant.adjust_count(+1)
                print(f"Tape counter: {assistant.counter.passed}")
            elif key in (ord("-"), ord("_")):
                assistant.adjust_count(-1)
                print(f"Tape counter: {assistant.counter.passed}")
            elif key == TAB_KEY:
                assistant.next_candidate()
            elif key == ord("["):
                detector.cfg.dark_thresh = max(3, detector.cfg.dark_thresh - 3)
                print(f"darkness threshold {detector.cfg.dark_thresh}")
            elif key == ord("]"):
                detector.cfg.dark_thresh = min(150, detector.cfg.dark_thresh + 3)
                print(f"darkness threshold {detector.cfg.dark_thresh}")
            elif key == ord("m"):
                state.show_mask = not state.show_mask
            elif key == ord(" "):
                state.paused = not state.paused
            elif key == ord("v"):
                if fx_controls is None:
                    fx_controls = SimControls(PRESETS["murky"])
                effects_on = not effects_on
            elif key in (ord("1"), ord("2"), ord("3")):
                name = list(PRESETS)[key - ord("1")]
                if fx_controls is None:
                    fx_controls = SimControls(PRESETS[name])
                fx_controls.set(PRESETS[name])
                effects_on = True
            elif key == ord("g"):
                fullscreen = not fullscreen
                cv2.setWindowProperty(WINDOW, cv2.WND_PROP_FULLSCREEN,
                                      cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL)
            elif key == ord("p"):
                print(f"Saved {save_capture(shown, 'm3')}")
    finally:
        if source is not None:
            source.release()
        cv2.destroyAllWindows()

    if sim is not None:
        print(f"Final: furthest {milestone_name(sim.status.furthest)}, counter {assistant.counter.passed}, "
              f"max off-line {sim.status.max_offset * 100:.0f} cm")


if __name__ == "__main__":
    main()
