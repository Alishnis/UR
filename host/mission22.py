"""Mission 2.2 - chamber docking guidance. Run from host/:
    python mission22.py                       # 3D pool simulator
    python mission22.py --source 0 --hfov 70  # real camera (better: --calib camera.json)

Keys: T rule largest/smallest | N new attempt (reset) | U undo last tag | Space pause | P screenshot
      C CLAHE | V underwater effects on/off | 1 2 3 effects preset | G fullscreen | Q / Esc quit
Simulator driving (throttle steps like the real ESCs): W/S forward/back, A/D turn, R/F up/down, X all stop
"""
import argparse
import random
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from sim.pool_sim import THROTTLE_STEPS, PoolSim
from ui import (CYAN, GREEN, GREY, MAGENTA, ORANGE, RED, WHITE, YELLOW, FrameSource, fit_height, put_text,
                save_capture, shade_rect)
from vision.apriltag_detector import TAG_OBJECT_POINTS, DetectorConfig, TagDetector
from vision.camera_model import CameraModel, Undistorter
from vision.chamber import TAG_MOUNTS, entrance_corners_in_tag, entrance_in_tag
from vision.docking import DockingAssistant, DockingView, RovConfig
from vision.tag_image import MAX_TAG_ID
from vision.tag_tracker import Rule, TagTracker, select_target
from vision.underwater_sim import PRESETS, SimControls, degrade, preset_name

WINDOW = "Mission 2.2 - Docking"


@dataclass
class AppState:
    rule: Rule | None
    expected: int
    paused: bool = False
    fps: float = 0.0
    clahe: bool = False
    effects: str | None = None
    target: int | None = None
    view: DockingView = field(default_factory=DockingView)


def project_tag_frame(cam: CameraModel, R, t, pts_tag) -> np.ndarray | None:
    pts = (R @ np.asarray(pts_tag).T).T + t
    if (pts[:, 2] < 0.05).any():
        return None
    return cam.project(pts).astype(np.int32)


def draw_target_geometry(out, cam: CameraModel, view: DockingView, mount: str) -> None:
    R, t = view.pose
    aligned = view.guidance is not None and view.guidance.aligned
    color = GREEN if aligned else CYAN
    entrance = project_tag_frame(cam, R, t, entrance_corners_in_tag(mount))
    if entrance is not None:
        cv2.polylines(out, [entrance.reshape(-1, 1, 2)], True, color, 3, cv2.LINE_AA)
        centre = project_tag_frame(cam, R, t, entrance_in_tag(mount)[None])[0]
        cv2.drawMarker(out, tuple(int(v) for v in centre), color, cv2.MARKER_CROSS, 30, 3)
        put_text(out, "ENTRANCE", (entrance[:, 0].min(), entrance[:, 1].max() + 28), 0.7, color, 2)
    if view.source.startswith("estimated"):
        square = project_tag_frame(cam, R, t, TAG_OBJECT_POINTS)
        if square is not None:
            cv2.polylines(out, [square.reshape(-1, 1, 2)], True, MAGENTA, 2, cv2.LINE_AA)
            put_text(out, "TARGET (hidden, estimated)", (square[:, 0].min(), square[:, 1].min() - 10), 0.6,
                     MAGENTA, 2)


def tolerance_line(name, value, tol, unit, scale=1.0):
    ok = abs(value) <= tol
    return f"{name} {value * scale:+.0f}{unit} (tol {tol * scale:.0f})", GREEN if ok else ORANGE


def draw_overlay(frame, detections, tracker, state: AppState, cam: CameraModel, mount: str,
                 assistant: DockingAssistant | None, sim: PoolSim | None) -> np.ndarray:
    out = frame.copy()
    h, w = out.shape[:2]
    confirmed = tracker.confirmed_ids()
    view = state.view

    for d in detections:
        if state.target is not None:
            label, color = (f"TARGET {d.id}", MAGENTA) if d.id == state.target else (f"WRONG {d.id}", RED)
        else:
            label, color = f"ID {d.id}", GREEN if d.id in confirmed else ORANGE
        cv2.polylines(out, [d.corners.astype(np.int32).reshape(-1, 1, 2)], True, color, 3, cv2.LINE_AA)
        (tw, _), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.9, 2)
        put_text(out, label, (int(d.center[0]) - tw // 2, max(int(d.corners[:, 1].min()) - 10, 25)), 0.9, color, 2)
    if view.pose is not None:
        draw_target_geometry(out, cam, view, mount)
    cv2.drawMarker(out, (w // 2, h // 2), WHITE, cv2.MARKER_TILTED_CROSS, 22, 2)  # where the camera points

    shade_rect(out, (0, 0), (600, 345))
    put_text(out, f"MISSION 2.2  DOCKING  (tag mount: {mount})", (15, 30), 0.7, WHITE, 2)
    if state.rule is None:
        put_text(out, "RULE: NOT SET - press T", (15, 65), 0.85, RED, 2)
    else:
        put_text(out, f"RULE: {state.rule.value.upper()}", (15, 65), 0.85, WHITE, 2)
    n = len(confirmed)
    put_text(out, f"TAGS ({n}/{state.expected}): {', '.join(map(str, confirmed)) or '-'}", (15, 100), 0.8,
             GREEN if n == state.expected else (RED if n > state.expected else ORANGE), 2)
    if state.target is None:
        hint = ("scan all tags first" if n < state.expected else
                "press U: too many tags" if n > state.expected else "set the rule")
        put_text(out, f"TARGET: --- ({hint})", (15, 140), 0.8, GREY, 2)
    else:
        put_text(out, f"TARGET: ID {state.target}", (15, 140), 1.1, MAGENTA, 3)

    g = view.guidance
    if assistant is not None and not assistant.tol.fits:
        put_text(out, "ROV TOO BIG for the 70 cm opening (check --rov-width/--rov-height)", (15, 175), 0.55, RED, 2)
    elif assistant is not None and g is not None:
        tol = assistant.tol
        stale = view.source == "lost"  # numbers are from the last frame the target was seen
        y = 175
        for text, color in (tolerance_line("LAT", g.lateral, tol.lateral, " cm", 100),
                            tolerance_line("VERT", g.vertical, tol.vertical, " cm", 100),
                            tolerance_line("YAW", g.yaw_deg, tol.yaw_deg, " deg")):
            put_text(out, text, (15, y), 0.7, GREY if stale else color, 2)
            y += 30
        put_text(out, f"DIST {g.distance:.2f} m" + (" (last seen)" if stale else ""), (360, 175), 0.7,
                 GREY if stale else WHITE, 2)
        stage_color = YELLOW if g.distance > assistant.stage else ORANGE
        put_text(out, f"line up before {assistant.stage:.1f} m", (360, 205), 0.55, stage_color, 1)
        if view.source.startswith("estimated"):
            put_text(out, view.source, (360, 235), 0.5, MAGENTA, 1)
    if view.advice is not None and (view.source != "lost" or view.seconds_lost > 0.3):
        put_text(out, view.advice, (15, 290), 0.6 if len(view.advice) < 50 else 0.5, GREY if g else YELLOW, 2)
        if view.advice.startswith("BLIND"):
            put_text(out, "the tag left the image because we are close - this is expected", (15, 320), 0.5, GREY, 1)
    elif g is not None:
        main = ("ALIGNED - " if g.aligned else "") + "  |  ".join(g.commands)
        put_text(out, main, (15, 300), 0.85 if len(main) < 34 else 0.6, GREEN if g.aligned else YELLOW, 2)

    if sim is not None:
        draw_sim_panel(out, sim, state)

    shade_rect(out, (0, h - 62), (w, h))
    status = f"{state.fps:4.1f} FPS  CLAHE {'ON' if state.clahe else 'off'}  HFOV {cam.hfov_deg:.0f} deg"
    if state.effects:
        status += f"  EFFECTS {state.effects}"
    if state.paused:
        status += "  PAUSED"
    put_text(out, status, (15, h - 40), 0.6, WHITE, 1)
    keys = "T rule  N new attempt  U undo  Space pause  P shot  C clahe  V effects 1/2/3  G full  Q quit"
    if sim is not None:
        keys = "W/S fwd/back  A/D turn  R/F up/down  X stop  |  " + keys
    put_text(out, keys, (15, h - 15), 0.5, GREY, 1)
    return out


def draw_sim_panel(out, sim: PoolSim, state: AppState) -> None:
    w = out.shape[1]
    x0 = w - 330
    shade_rect(out, (x0 - 10, 0), (w, 235))
    put_text(out, "SIMULATOR", (x0, 30), 0.7, WHITE, 2)
    for row, (name, level) in enumerate(zip(("surge", "yaw", "heave"), sim.levels)):
        y = 60 + row * 30
        put_text(out, f"{name:5}", (x0, y), 0.6, WHITE, 1)
        cx = x0 + 160
        cv2.rectangle(out, (cx - 90, y - 14), (cx + 90, y), GREY, 1)
        bar = int(90 * level / THROTTLE_STEPS)
        cv2.rectangle(out, (cx, y - 14), (cx + bar, y), YELLOW if level else GREY, -1)
        put_text(out, f"{level:+d}", (cx + 100, y), 0.6, WHITE, 1)
    st = sim.status
    put_text(out, f"CONTACTS: {st.contacts}" + ("  TOUCHING!" if st.contact_now else ""), (x0, 160), 0.65,
             RED if st.contacts else GREEN, 2)
    points, text = sim.score(state.rule)
    color = GREY if points is None else (GREEN if points == 20 else (ORANGE if points == 10 else RED))
    put_text(out, f"SCORE: {'-' if points is None else points}  {text}", (x0, 190), 0.55, color, 2)
    if state.target is not None and state.view.pose is not None:
        _, t_true = sim.true_tag_pose(sim.tag_ids.index(state.target))
        err = np.linalg.norm(state.view.pose[1] - t_true) * 100
        put_text(out, f"pose error vs truth: {err:.1f} cm", (x0, 220), 0.5, GREY, 1)


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="sim", help="'sim' (default), camera index, URL, video or image file")
    ap.add_argument("--rule", choices=[r.value for r in Rule], help="same rule as Mission 2.1; T toggles it")
    ap.add_argument("--mount", choices=list(TAG_MOUNTS), default="above", help="where tags sit on the chambers")
    ap.add_argument("--rov-width", type=float, default=0.40, help="m, MEASURE: widest point incl. guards")
    ap.add_argument("--rov-height", type=float, default=0.30, help="m")
    ap.add_argument("--rov-length", type=float, default=0.45, help="m")
    ap.add_argument("--slow-speed", type=float, default=0.10, help="m/s at slow forward throttle, MEASURE in pool")
    ap.add_argument("--cam-tilt", type=float, default=0.0, help="deg the camera is pitched down")
    ap.add_argument("--calib", help="camera calibration json from tools.calibrate_camera")
    ap.add_argument("--hfov", type=float, default=70.0, help="horizontal field of view if no --calib")
    ap.add_argument("--water", action="store_true", help="camera calibrated in air but used underwater")
    ap.add_argument("--expected", type=int, default=3)
    ap.add_argument("--confirm-frames", type=int, default=5)
    ap.add_argument("--min-margin", type=float, default=DetectorConfig.min_margin,
                    help="reject detections with lower decision margin (raise if false IDs flicker)")
    ap.add_argument("--decimate", type=float, default=1.0)
    ap.add_argument("--clahe", action=argparse.BooleanOptionalAction, default=DetectorConfig.use_clahe,
                    help="CLAHE contrast boost (default on; --no-clahe to start with it off)")
    ap.add_argument("--flip", action="store_true")
    ap.add_argument("--effects", choices=list(PRESETS), help="start with underwater image effects")
    sim = ap.add_argument_group("simulator")
    sim.add_argument("--sim-ids", type=int, nargs=3, help="tag IDs on the 3 chambers, left to right")
    sim.add_argument("--visibility", type=float, default=7.0, help="m, water clarity in the render")
    sim.add_argument("--drift", type=float, default=0.0, help="m/s of random sideways current, e.g. 0.03")
    sim.add_argument("--seed", type=int, help="random seed for start pose / IDs")
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
    detector = TagDetector(DetectorConfig(quad_decimate=args.decimate, min_margin=args.min_margin,
                                          use_clahe=args.clahe))
    tracker = TagTracker(confirm_frames=args.confirm_frames)
    state = AppState(rule=Rule(args.rule) if args.rule else None, expected=args.expected, clahe=args.clahe)

    sim, source, cam, undistort, assistant = None, None, None, None, None
    if args.source == "sim":
        ids = args.sim_ids or random.Random(args.seed).sample(range(MAX_TAG_ID + 1), 3)
        sim = PoolSim(ids, rov=rov, mount=args.mount, visibility=args.visibility, drift=args.drift, seed=args.seed)
        cam = sim.camera
        assistant = DockingAssistant(rov, args.mount, cam)
        print(f"Simulator chambers left->right: IDs {ids}")
    else:
        source = FrameSource(args.source)

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WINDOW, 1280, 720)
    fx_controls = SimControls(PRESETS[args.effects]) if args.effects else None
    effects_on = args.effects is not None
    rng = np.random.default_rng()
    fullscreen = False
    last = time.monotonic()
    frame, detections = None, []

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
                        assistant = DockingAssistant(rov, args.mount, cam)
                    frame = undistort(frame)
                if args.flip:
                    frame = cv2.flip(frame, 1)
                state.effects = None
                if effects_on:
                    params = fx_controls.read()
                    frame = degrade(frame, params, rng)
                    state.effects = preset_name(params)

                detections = detector.detect(frame, cam)
                for tag_id in tracker.update([d.id for d in detections], now):
                    print(f"confirmed tag {tag_id} -> {tracker.confirmed_ids()}")
                confirmed = tracker.confirmed_ids()
                target = select_target(confirmed, state.rule) if len(confirmed) == state.expected else None
                if target != state.target and target is not None:
                    print(f"TARGET chamber: tag {target}")
                state.target = target
                state.view = assistant.update(detections, now, target, set(confirmed))
                if dt > 0:
                    state.fps = 0.9 * state.fps + 0.1 / dt if state.fps else 1 / dt

            shown = draw_overlay(frame, detections, tracker, state, cam, args.mount, assistant, sim)
            cv2.imshow(WINDOW, shown)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27) or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break
            if sim is not None and not state.paused and sim.handle_key(key):
                continue
            if key == ord("t"):
                state.rule = Rule.SMALLEST if state.rule is Rule.LARGEST else Rule.LARGEST
                print(f"Rule: {state.rule.value.upper()}")
            elif key == ord("n"):
                tracker.reset()
                assistant.reset()
                state.target, state.view = None, DockingView()
                if sim is not None:
                    sim.reset()
                print("New attempt: tags forgotten" + (", simulator reset" if sim else ""))
            elif key == ord("u"):
                dropped = tracker.undo_last()
                print(f"Dropped tag {dropped}" if dropped is not None else "Nothing to undo")
            elif key == ord(" "):
                state.paused = not state.paused
            elif key == ord("c"):
                state.clahe = detector.cfg.use_clahe = not detector.cfg.use_clahe
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
                print(f"Saved {save_capture(shown, 'm22')}")
    finally:
        if source is not None:
            source.release()
        cv2.destroyAllWindows()

    if sim is not None:
        points, text = sim.score(state.rule)
        print(f"Final: {text}, contacts {sim.status.contacts}, score {points}")


if __name__ == "__main__":
    main()
