"""Mission 2.1 - AprilTag scanning. Run from host/: python mission21.py --source 0

Keys: L largest | S smallest | R reset | U undo last tag | Space freeze | P screenshot
      C CLAHE contrast | W underwater sim on/off | 1 2 3 sim preset clear/murky/bad
      F fullscreen | Q / Esc quit
"""
import argparse
import time
from dataclasses import dataclass

import cv2
import numpy as np

from vision.apriltag_detector import TAG_FAMILY, Detection, DetectorConfig, TagDetector
from vision.tag_tracker import Rule, TagTracker, select_target
from vision.underwater_sim import PRESETS, SimControls, degrade, preset_name
from ui import GREEN, GREY, MAGENTA, ORANGE, RED, WHITE, YELLOW, FrameSource, fit_height, put_text, save_capture

WINDOW = "Mission 2.1 - AprilTag"


@dataclass
class AppState:
    rule: Rule | None
    expected: int
    frozen: bool = False
    fps: float = 0.0
    clahe: bool = False
    sim: str | None = None  # preset name when the underwater simulation is on


def draw_overlay(frame: np.ndarray, detections: list[Detection], tracker: TagTracker, state: AppState) -> np.ndarray:
    h, w = frame.shape[:2]
    shade = frame.copy()
    cv2.rectangle(shade, (0, 0), (620, 205), (0, 0, 0), -1)
    cv2.rectangle(shade, (0, h - 62), (w, h), (0, 0, 0), -1)
    out = cv2.addWeighted(shade, 0.55, frame, 0.45, 0)
    confirmed = tracker.confirmed_ids()
    selected = select_target(confirmed, state.rule)
    # only highlight once all tags are known, otherwise the referee could see a premature answer
    highlight = selected if len(confirmed) == state.expected else None

    for d in detections:
        is_confirmed = d.id in confirmed
        if d.id == highlight:
            color, thick = MAGENTA, 6
        else:
            color, thick = (GREEN, 3) if is_confirmed else (ORANGE, 2)
        cv2.polylines(out, [d.corners.astype(np.int32).reshape(-1, 1, 2)], True, color, thick, cv2.LINE_AA)
        cx = int(d.center[0])
        top, bottom = int(d.corners[:, 1].min()), int(d.corners[:, 1].max())
        label = f"ID {d.id}"
        (tw, _), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 1.2, 3)
        put_text(out, label, (cx - tw // 2, max(top - 12, 30)), 1.2, color, 3)
        put_text(out, f"margin {d.margin:.0f}", (int(d.corners[:, 0].min()), bottom + 22), 0.5, GREY, 1)

    put_text(out, f"MISSION 2.1  AprilTag {TAG_FAMILY}", (15, 32), 0.75, WHITE, 2)
    if state.rule is None:
        put_text(out, "RULE: NOT SET - press L or S", (15, 70), 0.9, RED, 2)
    else:
        put_text(out, f"RULE: {state.rule.value.upper()}", (15, 70), 0.9, WHITE, 2)

    n = len(confirmed)
    count_color = GREEN if n == state.expected else (RED if n > state.expected else ORANGE)
    ids_text = ", ".join(map(str, confirmed)) if confirmed else "-"
    put_text(out, f"TAGS ({n}/{state.expected}): {ids_text}", (15, 110), 0.9, count_color, 2)

    if state.rule is None or not confirmed:
        put_text(out, "SELECTED: ---", (15, 165), 1.3, GREY, 3)
    elif n < state.expected:
        put_text(out, f"SELECTED: --- (best so far {selected}, need {state.expected})", (15, 165), 0.8, ORANGE, 2)
    elif n == state.expected:
        put_text(out, f"SELECTED: ID {selected}", (15, 165), 1.5, YELLOW, 4)
    else:
        put_text(out, "SELECTED: ???", (15, 165), 1.3, RED, 3)
        put_text(out, f"{n} tags but expected {state.expected}! Press U to drop a false one", (15, 198), 0.6, RED, 2)

    status = f"{state.fps:4.1f} FPS  CLAHE {'ON' if state.clahe else 'off'}"
    if state.sim:
        status += f"  SIM {state.sim}"
        put_text(out, f"SIM: {state.sim}", (w - 300, 95), 1.0, ORANGE, 2)
    if state.frozen:
        status += "  FROZEN"
        put_text(out, "FROZEN", (w - 190, 45), 1.2, RED, 3)
    put_text(out, status, (15, h - 40), 0.6, WHITE, 1)
    put_text(out, "L/S rule  R reset  U undo  Space freeze  P shot  C clahe  W sim  1/2/3 preset  F full  Q quit", (15, h - 15), 0.55, GREY, 1)
    return out


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="0", help="camera index, stream URL, video or image file (default 0)")
    ap.add_argument("--rule", choices=[r.value for r in Rule], help="assigned rule; can also be set with L / S keys")
    ap.add_argument("--expected", type=int, default=3, help="number of tags in the mission (default 3)")
    ap.add_argument("--confirm-frames", type=int, default=5, help="frames a tag must be seen before it counts")
    ap.add_argument("--min-margin", type=float, default=DetectorConfig.min_margin,
                    help="reject detections with lower decision margin (raise if false IDs flicker)")
    ap.add_argument("--decimate", type=float, default=1.0, help="quad_decimate: 1.0 = best range, 2.0 = faster")
    ap.add_argument("--clahe", action=argparse.BooleanOptionalAction, default=DetectorConfig.use_clahe,
                    help="CLAHE contrast boost (default on; --no-clahe to start with it off)")
    ap.add_argument("--flip", action="store_true", help="mirror the image horizontally (if the camera is mirrored)")
    ap.add_argument("--sim", choices=list(PRESETS), help="start with simulated underwater degradation (tune live)")
    return ap.parse_args()


def main():
    args = parse_args()
    detector = TagDetector(DetectorConfig(quad_decimate=args.decimate, min_margin=args.min_margin, use_clahe=args.clahe))
    tracker = TagTracker(confirm_frames=args.confirm_frames)
    state = AppState(rule=Rule(args.rule) if args.rule else None, expected=args.expected, clahe=args.clahe)
    source = FrameSource(args.source)

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WINDOW, 1280, 720)
    fullscreen = False
    t0 = last = time.monotonic()
    frame, detections, shown = None, [], None
    failed_reads = 0
    sim_controls = SimControls(PRESETS[args.sim]) if args.sim else None
    sim_on = args.sim is not None
    rng = np.random.default_rng()

    try:
        while True:
            if not state.frozen:
                ok, raw = source.read()
                if not ok:
                    failed_reads += 1
                    if failed_reads > 50:
                        print("Source stopped giving frames.")
                        break
                    cv2.waitKey(20)
                    continue
                failed_reads = 0
                frame = fit_height(raw)
                if args.flip:
                    frame = cv2.flip(frame, 1)
                state.sim = None
                if sim_on:
                    params = sim_controls.read()
                    frame = degrade(frame, params, rng)
                    state.sim = preset_name(params)
                detections = detector.detect(frame)
                now = time.monotonic()
                for tag_id in tracker.update([d.id for d in detections], now):
                    margin = next(d.margin for d in detections if d.id == tag_id)
                    print(f"[{now - t0:6.1f}s] confirmed tag {tag_id} (margin {margin:.0f}) -> {tracker.confirmed_ids()}")
                dt = now - last
                last = now
                if dt > 0:
                    state.fps = 0.9 * state.fps + 0.1 / dt if state.fps else 1 / dt

            shown = draw_overlay(frame, detections, tracker, state)
            cv2.imshow(WINDOW, shown)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27) or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break
            elif key == ord("l"):
                state.rule = Rule.LARGEST
                print("Rule: LARGEST")
            elif key == ord("s"):
                state.rule = Rule.SMALLEST
                print("Rule: SMALLEST")
            elif key == ord("r"):
                tracker.reset()
                print("Reset: all tags forgotten")
            elif key == ord("u"):
                dropped = tracker.undo_last()
                print(f"Dropped tag {dropped}, ignored until reset" if dropped is not None else "Nothing to undo")
            elif key == ord(" "):
                state.frozen = not state.frozen
            elif key == ord("c"):
                state.clahe = detector.cfg.use_clahe = not detector.cfg.use_clahe
            elif key == ord("w"):
                if sim_controls is None:
                    sim_controls = SimControls(PRESETS["murky"])
                sim_on = not sim_on
                print(f"Underwater sim {'ON' if sim_on else 'off'}")
            elif key in (ord("1"), ord("2"), ord("3")):
                name = list(PRESETS)[key - ord("1")]
                if sim_controls is None:
                    sim_controls = SimControls(PRESETS[name])
                sim_controls.set(PRESETS[name])
                sim_on = True
                print(f"Underwater sim preset: {name}")
            elif key == ord("f"):
                fullscreen = not fullscreen
                cv2.setWindowProperty(WINDOW, cv2.WND_PROP_FULLSCREEN,
                                      cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL)
            elif key == ord("p"):
                print(f"Saved {save_capture(shown, 'm21')}")
    finally:
        source.release()
        cv2.destroyAllWindows()

    confirmed = tracker.confirmed_ids()
    print(f"Final: tags {confirmed}, rule {state.rule.value if state.rule else 'NOT SET'}, "
          f"selected {select_target(confirmed, state.rule)}")


if __name__ == "__main__":
    main()
