"""Mission 5 - pole colour recognition and hitting assistant (the pilot flies manually). Run from host/:
    python mission5.py                                   # pool simulator
    python mission5.py --source 0 --order R-B-Y          # real camera

Keys: O enter the order (then R / Y / B) | H the target's ball dropped -> next | U undo | N new attempt
      C colour calibration window | click a pole = set its colour | Tab colour to calibrate | K save colours
      M masks | Space pause | P screenshot | V underwater effects | 1 2 3 effects preset | G fullscreen | Q quit
Simulator driving (throttle steps like the real ESCs): W/S forward/back, A/D turn, R/F up/down, X all stop
"""
import argparse
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from sim.pole_sim import POLE_D, POLE_H, PoleSim
from sim.pool_sim import THROTTLE_STEPS
from ui import (CYAN, GREEN, GREY, ORANGE, RED, WHITE, YELLOW, FrameSource, fit_height, put_text, save_capture,
                shade_rect)
from vision.camera_model import CameraModel, Undistorter
from vision.docking import RovConfig
from vision.pole_detector import (COLORS, DEFAULT_FILE, DRAW_BGR, LETTER, ColorRange, PoleConfig, PoleDetection,
                                  PoleDetector, load_ranges, range_from_click, sample_hsv,
                                  save_ranges)
from vision.pole_guidance import PoleAssistant, PoleGuideConfig, PoleView, order_text, parse_order
from vision.underwater_sim import PRESETS, SimControls, degrade, preset_name

WINDOW = "Mission 5 - Poles"
CAL_WINDOW = "Pole colours"
TAB_KEY, ESC_KEY = 9, 27


@dataclass
class AppState:
    paused: bool = False
    fps: float = 0.0
    effects: str | None = None
    show_masks: bool = False
    typing_order: str | None = None  # letters typed so far after O
    cal_color: str = "red"  # colour edited by clicks and trackbars
    message: str = ""
    view: PoleView = field(default_factory=PoleView)
    detection: PoleDetection | None = None
    click: tuple[int, int] | None = None


class Calibration:
    """Trackbars for the edited colour (hue low/high, minimum saturation and value)."""

    def __init__(self, ranges: dict[str, ColorRange]):
        self.ranges = ranges
        self.open = False
        self.shown: str | None = None

    def toggle(self, color: str) -> None:
        if self.open:
            cv2.destroyWindow(CAL_WINDOW)
            self.open = False
            return
        cv2.namedWindow(CAL_WINDOW, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(CAL_WINDOW, 420, 200)
        for name, top in (("h_lo", 179), ("h_hi", 179), ("s_lo", 255), ("v_lo", 255)):
            cv2.createTrackbar(name, CAL_WINDOW, 0, top, lambda _v: None)
        self.open = True
        self.shown = None
        self.sync(color)

    def sync(self, color: str) -> None:
        """Trackbars -> range of the edited colour; show another colour's values when it changes."""
        if not self.open:
            return
        try:
            if self.shown != color:
                for name, value in vars(self.ranges[color]).items():
                    cv2.setTrackbarPos(name, CAL_WINDOW, value)
                cv2.setWindowTitle(CAL_WINDOW, f"{CAL_WINDOW}: editing {color.upper()} (Tab = next)")
                self.shown = color
            self.ranges[color] = ColorRange(*(cv2.getTrackbarPos(n, CAL_WINDOW) for n in ("h_lo", "h_hi", "s_lo",
                                                                                           "v_lo")))
        except cv2.error:
            self.open = False  # closed with the mouse


def pole_box(p) -> tuple[tuple[int, int], tuple[int, int]]:
    half = p.width_px / 2 + 4
    x0, x1 = min(p.top[0], p.bottom[0]) - half, max(p.top[0], p.bottom[0]) + half
    return (int(x0), int(p.top[1]) - 4), (int(x1), int(p.bottom[1]) + 4)


def draw_poles(out, view: PoleView) -> None:
    for color, m in view.measures.items():
        p = m.pole
        is_target = color == view.target
        col = DRAW_BGR[color]
        a, b = pole_box(p)
        cv2.rectangle(out, a, b, col, 4 if is_target else 2)
        label = f"{color.upper()} {m.dist_m:.1f} m"
        if color in view.done:
            label += " DONE"
        elif is_target:
            label = "TARGET " + label
        put_text(out, label, (a[0], max(22, a[1] - 10)), 0.7 if is_target else 0.55, col, 2)
        if p.ball is not None:
            cv2.circle(out, tuple(p.ball.astype(int)), max(6, int(p.ball_px)), WHITE, 2)
        elif p.ball_checked:
            put_text(out, "no ball?", (int(p.top[0]) + 10, int(p.top[1]) - 8), 0.5, ORANGE, 1)
        if is_target and not p.top_cut:  # the ball = the aim point
            c = (int(p.top[0]), int(p.top[1] - max(p.ball_px, 6) / 2))
            cv2.drawMarker(out, c, CYAN, cv2.MARKER_CROSS, 40, 2)


def draw_overlay(frame, state: AppState, assistant: PoleAssistant, detector: PoleDetector,
                 sim: PoleSim | None) -> np.ndarray:
    out = frame.copy()
    h, w = out.shape[:2]
    view = state.view
    draw_poles(out, view)
    cv2.drawMarker(out, (w // 2, h // 2), GREY, cv2.MARKER_CROSS, 24, 1)

    shade_rect(out, (0, 0), (640, 300))
    put_text(out, "MISSION 5  POLES  (pilot flies manually)", (15, 30), 0.65, WHITE, 2)
    if state.typing_order is not None:
        typed = "-".join(state.typing_order) + "-_" * (3 - len(state.typing_order))
        put_text(out, f"TYPE THE ORDER: {typed.strip('-')}   (R / Y / B, Esc cancels)", (15, 70), 0.75, YELLOW, 2)
    elif view.order:
        x = 15
        put_text(out, "ORDER", (x, 70), 0.75, WHITE, 2)
        x += 100
        for c in view.order:
            done, cur = c in view.done, c == view.target
            text = c[0].upper() + (" ok" if done else "")
            put_text(out, text, (x, 70), 0.9 if cur else 0.75, GREEN if done else DRAW_BGR[c], 3 if cur else 2)
            x += 95
        if view.target:
            put_text(out, f"NEXT: {view.target.upper()}", (x + 10, 70), 0.9, DRAW_BGR[view.target], 3)
    else:
        put_text(out, "NO ORDER - press O and type it (e.g. R B Y)", (15, 70), 0.7, ORANGE, 2)

    m = view.measures.get(view.target) if view.target else None
    if m is not None:
        ball = "?" if m.top_dz_m is None else f"{(m.top_dz_m + assistant.cfg.ball_d_m / 2) * 100:+.0f} cm"
        put_text(out, f"DIST {m.dist_m:.2f} m   BEARING {m.bearing_deg:+.0f} deg   BALL {ball} vs camera",
                 (15, 108), 0.6, WHITE, 1)
        put_text(out, f"ball: {view.ball}", (15, 135), 0.6, ORANGE if view.ball == "GONE?" else GREY, 1)
    g = view.guidance
    if g is not None and g.warning:
        put_text(out, g.warning, (15, 165), 0.65, RED, 2)
    if view.advice is not None:
        color = GREEN if view.advice.startswith(("ALL DONE", "BALL GONE")) else YELLOW
        put_text(out, view.advice, (15, 205), 0.62 if len(view.advice) < 52 else 0.45, color, 2)
    if g is not None and g.commands:
        main = "  |  ".join(g.commands)
        y = 240 if view.advice is not None else 205
        put_text(out, main, (15, y), 0.9 if len(main) < 30 else 0.65, GREEN if g.aligned else YELLOW, 2)
    if state.message:
        put_text(out, state.message, (15, 262), 0.5, CYAN, 1)
    r = detector.ranges[state.cal_color]
    put_text(out, f"calibrating {state.cal_color.upper()}: hue {r.h_lo}-{r.h_hi} S>={r.s_lo} V>={r.v_lo}"
                  "  (click a pole / Tab / C / K save)", (15, 280), 0.5, GREY, 1)

    det = state.detection
    if state.show_masks and det is not None:
        mk = next(iter(det.masks.values()))
        inset = np.zeros((*mk.shape, 3), np.uint8)
        for c, mask in det.masks.items():
            inset[mask > 0] = DRAW_BGR[c]
        iw = w // 4
        inset = cv2.resize(inset, (iw, iw * inset.shape[0] // inset.shape[1]), interpolation=cv2.INTER_NEAREST)
        y0 = h - 70 - inset.shape[0]
        out[y0:y0 + inset.shape[0], w - iw - 10:w - 10] = inset
        put_text(out, "colour masks", (w - iw - 5, y0 + 20), 0.5, YELLOW, 1)

    if sim is not None:
        draw_sim_panel(out, sim)
    shade_rect(out, (0, h - 62), (w, h))
    status = f"{state.fps:4.1f} FPS  cam tilt {assistant.rov.cam_tilt_deg:.0f} deg  pole {assistant.cfg.pole_d_m * 100:.1f} cm"
    if state.effects:
        status += f"  EFFECTS {state.effects}"
    if state.paused:
        status += "  PAUSED"
    put_text(out, status, (15, h - 40), 0.6, WHITE, 1)
    keys = "O order  H hit ok  U undo  N new  C calib  Tab colour  K save  M masks  Space  P shot  V 1/2/3  G  Q"
    if sim is not None:
        keys = "W/S A/D R/F X | " + keys
    put_text(out, keys, (15, h - 15), 0.5, GREY, 1)
    return out


def draw_sim_panel(out, sim: PoleSim) -> None:
    w = out.shape[1]
    x0 = w - 330
    shade_rect(out, (x0 - 10, 0), (w, 220))
    put_text(out, "SIMULATOR (truth)", (x0, 30), 0.7, WHITE, 2)
    for row, (name, level) in enumerate(zip(("surge", "yaw", "heave"), sim.levels)):
        y = 60 + row * 30
        put_text(out, f"{name:5}", (x0, y), 0.6, WHITE, 1)
        cx = x0 + 160
        cv2.rectangle(out, (cx - 90, y - 14), (cx + 90, y), GREY, 1)
        bar = int(90 * level / THROTTLE_STEPS)
        cv2.rectangle(out, (cx, y - 14), (cx + bar, y), YELLOW if level else GREY, -1)
        put_text(out, f"{level:+d}", (cx + 100, y), 0.6, WHITE, 1)
    put_text(out, f"referee order {order_text(sim.order)}", (x0, 160), 0.55, WHITE, 1)
    pts, text = sim.score()
    put_text(out, f"REFEREE: {pts} pts  {text}", (x0, 187), 0.5, GREEN if pts == 50 else WHITE, 1)
    put_text(out, f"pole touches {len(sim.status.touches)}", (x0, 210), 0.5,
             RED if any(p.touching for p in sim.poles) else GREY, 1)


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="sim", help="'sim' (default), camera index, URL, video or image file")
    ap.add_argument("--order", help="announced order, e.g. R-B-Y (can also be typed with O)")
    ap.add_argument("--colors", default=str(DEFAULT_FILE), help="colour calibration file (K saves to it)")
    ap.add_argument("--cam-tilt", type=float, default=30.0,
                    help="deg the camera is pitched DOWN - MEASURE on the ROV (phone level app on the camera)")
    ap.add_argument("--rov-width", type=float, default=0.40, help="m")
    ap.add_argument("--rov-height", type=float, default=0.30, help="m")
    ap.add_argument("--rov-length", type=float, default=0.45, help="m (the camera is assumed at the front)")
    ap.add_argument("--slow-speed", type=float, default=0.10, help="m/s at slow forward throttle, MEASURE in pool")
    ap.add_argument("--calib", help="camera calibration json from tools.calibrate_camera")
    ap.add_argument("--hfov", type=float, default=70.0, help="horizontal field of view if no --calib")
    ap.add_argument("--water", action="store_true", help="camera calibrated in air but used underwater")
    ap.add_argument("--pole-diameter", type=float, default=PoleGuideConfig.pole_d_m,
                    help="m - MEASURE at the venue: every distance is scaled by it")
    ap.add_argument("--aim-above", type=float, default=PoleGuideConfig.aim_above_m,
                    help="m, camera above the ball centre at the hit (depends on where the ROV should touch it)")
    ap.add_argument("--flip", action="store_true")
    ap.add_argument("--effects", choices=list(PRESETS), help="start with underwater image effects")
    sim = ap.add_argument_group("simulator")
    sim.add_argument("--visibility", type=float, default=7.0, help="m, water clarity in the render")
    sim.add_argument("--drift", type=float, default=0.0, help="m/s of random sideways current, e.g. 0.03")
    sim.add_argument("--caustics", type=float, default=0.3, help="0..1 moving light ripples on the floor")
    sim.add_argument("--pole-height", type=float, default=POLE_H, help="m (props drawing 0.6, contest text ~1)")
    sim.add_argument("--seed", type=int, help="random seed for the layout, order and start pose")
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
    guide_cfg = PoleGuideConfig(pole_d_m=args.pole_diameter, aim_above_m=args.aim_above)
    detector = PoleDetector(load_ranges(args.colors), PoleConfig(ball_ratio=guide_cfg.ball_d_m / guide_cfg.pole_d_m))
    calib = Calibration(detector.ranges)
    state = AppState()
    order = parse_order(args.order) if args.order else None

    sim, source, cam, undistort, assistant = None, None, None, None, None
    if args.source == "sim":
        sim = PoleSim(rov=rov, visibility=args.visibility, drift=args.drift, caustics=args.caustics,
                      pole_h=args.pole_height, pole_d=POLE_D, order=order, seed=args.seed)
        cam = sim.camera
        assistant = PoleAssistant(rov, cam, guide_cfg, order or sim.order)
        state.message = f"simulator: referee order {order_text(sim.order)} (O to type another)"
    else:
        source = FrameSource(args.source)

    def on_mouse(event, x, y, _flags, _param):
        if event == cv2.EVENT_LBUTTONDOWN:
            state.click = (x, y)

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WINDOW, 1280, 720)
    cv2.setMouseCallback(WINDOW, on_mouse)
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
            calib.sync(state.cal_color)
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
                        assistant = PoleAssistant(rov, cam, guide_cfg, order)
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

            if state.click is not None and frame is not None:
                x, y = state.click
                state.click = None
                if 0 <= x < frame.shape[1] and 0 <= y < frame.shape[0]:
                    hsv = sample_hsv(frame, x, y)
                    detector.ranges[state.cal_color] = r = range_from_click(frame, x, y)
                    calib.shown = None  # reload the trackbars
                    state.message = (f"{state.cal_color.upper()} set from click: HSV {hsv.astype(int).tolist()}, "
                                     f"min saturation {r.s_lo} - check with M, K to save")
                    print(state.message)

            shown = draw_overlay(frame, state, assistant, detector, sim)
            cv2.imshow(WINDOW, shown)
            key = cv2.waitKey(1) & 0xFF
            if key == 255:
                continue
            if state.typing_order is not None:  # order entry swallows the keys
                ch = chr(key).upper() if key < 128 else ""
                if key == ESC_KEY:
                    state.typing_order = None
                elif ch in LETTER and ch not in state.typing_order:
                    state.typing_order += ch
                    if len(state.typing_order) == 3:
                        assistant.set_order(parse_order(state.typing_order))
                        state.message = f"order set: {order_text(assistant.order)}"
                        print(state.message)
                        state.typing_order = None
                continue
            if key in (ord("q"), ESC_KEY) or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break
            if sim is not None and not state.paused and sim.handle_key(key):
                continue
            if key == ord("o"):
                state.typing_order = ""
            elif key == ord("h"):
                hit = assistant.target
                nxt = assistant.mark_hit()
                state.message = f"{hit.upper() if hit else '-'} done -> next {nxt.upper() if nxt else 'nothing'}"
                print(state.message)
            elif key == ord("u"):
                assistant.undo()
                state.message = f"undo: target {assistant.target}"
            elif key == ord("n"):
                if sim is not None:
                    sim.reset()
                    if not args.order:
                        assistant.set_order(sim.order)
                    state.message = f"new attempt: referee order {order_text(sim.order)}"
                assistant.reset()
                print("New attempt")
            elif key == ord("c"):
                calib.toggle(state.cal_color)
            elif key == TAB_KEY:
                state.cal_color = COLORS[(COLORS.index(state.cal_color) + 1) % len(COLORS)]
            elif key == ord("k"):
                state.message = f"colours saved to {save_ranges(detector.ranges, args.colors)}"
                print(state.message)
            elif key == ord("m"):
                state.show_masks = not state.show_masks
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
                print(f"Saved {save_capture(shown, 'm5')}")
    finally:
        if source is not None:
            source.release()
        cv2.destroyAllWindows()

    if sim is not None:
        pts, text = sim.score()
        print(f"Final: {pts} pts, {text}, order {order_text(sim.order)}, confirmed {order_text(assistant.done)}")


if __name__ == "__main__":
    main()
