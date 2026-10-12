"""Mission 2.1 for the browser GUI: JPEG frames in, tag detections and the selection state out.

Uses the same detector and tracker as mission21.py (zero bit errors, margin filter, CLAHE, a tag counts only
after CONFIRM_FRAMES sightings and is remembered for the whole attempt). The state lives here in the bridge,
so reloading the browser page does not lose the tags already found.
"""
import threading
import time

import cv2
import numpy as np

from ui import fit_height
from vision.apriltag_detector import DetectorConfig, TagDetector
from vision.tag_tracker import Rule, TagTracker, select_target


class TagSession:
    def __init__(self, expected: int = 3, confirm_frames: int = 5, cfg: DetectorConfig | None = None):
        self.detector = TagDetector(cfg or DetectorConfig())
        self.tracker = TagTracker(confirm_frames=confirm_frames)
        self.expected = expected
        self.rule: Rule | None = None
        self._lock = threading.Lock()  # frames are processed in a worker thread, commands on the event loop

    def handle_frame(self, jpeg: bytes, now: float | None = None) -> dict:
        now = time.monotonic() if now is None else now
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return {"type": "error", "text": "could not decode frame"}
        h0, w0 = img.shape[:2]
        frame = fit_height(img)  # detector settings are tuned for 720p
        scale = w0 / frame.shape[1]
        t0 = time.perf_counter()
        dets = self.detector.detect(frame)
        ms = (time.perf_counter() - t0) * 1000
        with self._lock:
            newly = self.tracker.update([d.id for d in dets], now)
            state = self._state()
        for tag_id in newly:
            print(f"confirmed tag {tag_id} -> {state['confirmed']}", flush=True)
        return {
            "type": "tags", "width": w0, "height": h0, "ms": round(ms, 1), "newly": newly,
            "detections": [{"id": d.id, "corners": np.round(d.corners * scale, 1).tolist(),
                            "center": np.round(d.center * scale, 1).tolist(), "margin": round(d.margin, 1)}
                           for d in dets],
            **state,
        }

    def command(self, msg: dict) -> dict:
        cmd = msg.get("cmd")
        with self._lock:
            if cmd == "rule":
                self.rule = Rule(msg["rule"]) if msg.get("rule") else None
            elif cmd == "reset":
                self.tracker.reset()
            elif cmd == "undo":
                dropped = self.tracker.undo_last()
                if dropped is not None:
                    print(f"dropped tag {dropped} (ignored until reset)", flush=True)
            elif cmd == "clahe":
                self.detector.cfg.use_clahe = bool(msg.get("on"))
            elif cmd == "expected":
                self.expected = max(1, int(msg.get("n", self.expected)))
            return {"type": "state", **self._state()}

    def _state(self) -> dict:
        confirmed = self.tracker.confirmed_ids()
        best = select_target(confirmed, self.rule)
        return {
            "confirmed": confirmed,
            "rule": self.rule.value if self.rule else None,
            "expected": self.expected,
            # only a final answer once exactly the expected number of tags is known (never show it early)
            "selected": best if len(confirmed) == self.expected else None,
            "best_so_far": best,
            "clahe": self.detector.cfg.use_clahe,
        }
