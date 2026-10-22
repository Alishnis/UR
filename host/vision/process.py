"""One frame in, one JSON-ready reply out: the entry point of the vision service.

process_frame and process_message never raise: anything that goes wrong becomes
{"type": "error", "id": <id or null>, "text": "..."} so the connection carries on with the next frame.
Safe to call from several threads at once (the bridge runs them in a small thread pool).
"""

from __future__ import annotations

import json
import logging
import time

from vision.colors import detect_colors
from vision.frames import FrameError, decode_jpeg, parse_frame_message, valid_id
from vision.line import detect_line
from vision.tags import detect_tags

log = logging.getLogger("vision")

VISION_VERSION = 1
MODES = ("tags", "line", "colors")
_DETECTORS = {"tags": detect_tags, "line": detect_line, "colors": detect_colors}
_LOG_EVERY_S = 10.0  # the same failure on every frame (10/s) must not flood the bridge console
_last_logged: dict[str, float] = {}


def _log_failure(what: str, e: Exception) -> None:
    """log.exception (call inside the except block), at most once per _LOG_EVERY_S for the same error."""
    key = f"{type(e).__name__}: {e}"[:200]
    now = time.monotonic()
    if now - _last_logged.get(key, -_LOG_EVERY_S) >= _LOG_EVERY_S:
        if len(_last_logged) > 100:
            _last_logged.clear()
        _last_logged[key] = now
        log.exception("vision: %s failed", what)


def error_reply(frame_id: object, text: str) -> dict:
    return {"type": "error", "id": frame_id if valid_id(frame_id) else None, "text": str(text)[:300]}


def process_frame(header: dict, jpeg: bytes) -> dict:
    """Run the detector named by header["mode"] on one JPEG. Coordinates are pixels of that JPEG."""
    t0 = time.perf_counter()
    frame_id = header.get("id") if isinstance(header, dict) else None
    try:
        if not isinstance(header, dict):
            return error_reply(None, "header must be a JSON object")
        mode = header.get("mode")
        if mode not in MODES:
            return error_reply(frame_id, f"unknown mode {repr(mode)[:40]}, expected one of {', '.join(MODES)}")
        params = header.get("params")
        if not isinstance(params, dict):
            params = {}
        img = decode_jpeg(jpeg)
        fields = _DETECTORS[mode](img, params)
        h, w = img.shape[:2]
        reply = {"type": "result", "id": frame_id if valid_id(frame_id) else None, "mode": mode, "w": w, "h": h,
                 "ms": round((time.perf_counter() - t0) * 1000, 1), **fields}
        json.dumps(reply, allow_nan=False)  # the browser's JSON.parse rejects NaN: fail here, not there
        return reply
    except FrameError as e:
        return error_reply(frame_id, str(e))
    except Exception as e:  # noqa: BLE001 - one bad frame must never stop the service
        _log_failure(f"frame {frame_id}", e)
        return error_reply(frame_id, f"internal error: {type(e).__name__}: {e}")


def process_message(data: bytes) -> dict:
    """Parse one binary WebSocket message (header + JPEG) and process it."""
    try:
        header, jpeg = parse_frame_message(data)
    except FrameError as e:
        return error_reply(e.frame_id, str(e))
    except Exception as e:  # noqa: BLE001
        _log_failure("message parsing", e)
        return error_reply(None, f"internal error: {type(e).__name__}: {e}")
    return process_frame(header, jpeg)
