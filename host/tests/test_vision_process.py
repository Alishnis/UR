"""process_frame / process_message: dispatch, reply shape, errors, and "never raises"."""

from __future__ import annotations

import json
import random
import struct
import threading

import numpy as np
import pytest

import vision.process as process
from vision.process import MODES, VISION_VERSION, process_frame, process_message
from vision_synth import FloorCamera, frame_message, jpeg_bytes, line_scene, poles_scene, tag_scene

TAGS_JPEG = jpeg_bytes(tag_scene(seed=2), 85)
LINE_SCENE = line_scene(FloorCamera(x=-0.1, yaw_deg=-10))
LINE_JPEG = jpeg_bytes(LINE_SCENE.img, 80)
POLES_JPEG = jpeg_bytes(poles_scene()[0], 80)


def message(mode: str, jpeg: bytes, frame_id: int = 1, **params) -> bytes:
    return frame_message({"id": frame_id, "mode": mode, "params": params}, jpeg)


def assert_json_safe(reply: dict) -> None:
    json.dumps(reply, allow_nan=False)  # what the service sends; JSON.parse in the browser rejects NaN


def assert_error(reply: dict, frame_id, match: str) -> None:
    assert reply["type"] == "error" and reply["id"] == frame_id
    assert match.lower() in reply["text"].lower(), reply["text"]
    assert set(reply) == {"type", "id", "text"}
    assert_json_safe(reply)


def test_constants():
    assert VISION_VERSION == 1
    assert MODES == ("tags", "line", "colors")


@pytest.mark.parametrize("mode, jpeg, size, fields", [
    ("tags", TAGS_JPEG, (1280, 720), {"tags", "weak"}),
    ("line", LINE_JPEG, (640, 360), {"refY", "line"}),
    ("colors", POLES_JPEG, (640, 360), {"blobs"}),
])
def test_dispatch_and_reply_shape(mode, jpeg, size, fields):
    reply = process_message(message(mode, jpeg, frame_id=77))
    assert set(reply) == {"type", "id", "mode", "w", "h", "ms"} | fields
    assert reply["type"] == "result" and reply["id"] == 77 and reply["mode"] == mode
    assert (reply["w"], reply["h"]) == size
    assert isinstance(reply["ms"], float) and 0 <= reply["ms"] < 5000
    assert_json_safe(reply)


def test_each_mode_finds_its_target():
    assert [t["id"] for t in process_message(message("tags", TAGS_JPEG))["tags"]] == [17, 245, 503]
    assert process_message(message("line", LINE_JPEG))["line"]["angleDeg"] == pytest.approx(LINE_SCENE.angle_deg(),
                                                                                             abs=2)
    colors = sorted(b["color"] for b in process_message(message("colors", POLES_JPEG))["blobs"])
    assert colors == ["blue", "red", "yellow"]
    # and nothing where there is nothing
    assert process_message(message("tags", POLES_JPEG))["tags"] == []
    assert process_message(message("line", TAGS_JPEG))["line"] is None


def test_optional_outputs():
    reply = process_message(message("tags", TAGS_JPEG, hfovDeg=70))
    assert all(t["pose"] is not None for t in reply["tags"])
    assert process_message(message("line", LINE_JPEG, mask=True))["mask"].startswith("data:image/png;base64,")
    assert process_message(message("colors", POLES_JPEG, mask="red"))["mask"].startswith("data:image/png;base64,")
    assert_json_safe(process_message(message("colors", POLES_JPEG, mask="red")))


def test_bad_params_never_fail():
    junk = {"clahe": "x", "minMargin": None, "decimate": [2], "tagSizeM": {}, "hfovDeg": -5, "darkThresh": "dark",
            "refRow": float("inf"), "mask": 7, "colors": {"red": None, "Q": 1}, "minAreaFrac": True, "maxBlobs": 1e9,
            "unknown": {"deep": [1, 2, 3]}}
    for mode, jpeg in (("tags", TAGS_JPEG), ("line", LINE_JPEG), ("colors", POLES_JPEG)):
        reply = process_message(frame_message({"id": 3, "mode": mode, "params": junk}, jpeg))
        assert reply["type"] == "result", reply
        assert_json_safe(reply)


def test_bad_header_cases():
    assert_error(process_message(b"\x00\x00"), None, "header length")
    assert_error(process_message(struct.pack(">I", 0) + TAGS_JPEG), None, "header length 0")
    assert_error(process_message(struct.pack(">I", 5000) + b"{}"), None, "header length 5000")
    assert_error(process_message(struct.pack(">I", 40) + b"{}"), None, "ends inside")
    assert_error(process_message(struct.pack(">I", 2) + b"{]" + TAGS_JPEG), None, "JSON")
    assert_error(process_message(frame_message({"mode": "tags"}, TAGS_JPEG)), None, "id")
    assert_error(process_message(frame_message({"id": -4, "mode": "tags"}, TAGS_JPEG)), None, "id")
    assert_error(process_message(frame_message({"id": 8, "mode": None}, TAGS_JPEG)), 8, "mode")
    assert_error(process_message(frame_message({"id": 8, "mode": "tags", "params": 5}, TAGS_JPEG)), 8, "params")
    assert_error(process_message(frame_message({"id": 8, "mode": "tags"}, b"")), 8, "no JPEG")
    assert_error(process_message("text frame"), None, "binary")


def test_unknown_mode():
    assert_error(process_message(message("faces", TAGS_JPEG, frame_id=11)), 11, "unknown mode 'faces'")
    assert_error(process_message(message("TAGS", TAGS_JPEG, frame_id=12)), 12, "unknown mode")


def test_bad_jpeg():
    assert_error(process_message(message("tags", b"not a jpeg", frame_id=21)), 21, "not a JPEG")
    assert_error(process_message(message("line", b"\xff\xd8\xff\xe0" + b"\x00" * 30, frame_id=22)), 22, "JPEG")
    big = jpeg_bytes(np.zeros((8, 8, 3), np.uint8))
    assert process_message(message("colors", big, frame_id=23))["type"] == "result"  # tiny frames are fine


@pytest.mark.parametrize("shape", [(1, 1), (2, 700), (700, 2), (9, 16)])
def test_tiny_jpegs_in_every_mode(shape):
    jpeg = jpeg_bytes(np.full(shape + (3,), 100, np.uint8))
    for mode in MODES:
        params = {"mask": True} if mode == "line" else {"mask": "red", "hfovDeg": 60, "decimate": 4}
        reply = process_message(message(mode, jpeg, **params))
        assert reply["type"] == "result" and (reply["h"], reply["w"]) == shape
        assert_json_safe(reply)


def test_process_frame_with_garbage_arguments():
    assert_error(process_frame(None, TAGS_JPEG), None, "header")
    assert_error(process_frame(["tags"], TAGS_JPEG), None, "header")
    assert_error(process_frame({"id": 1, "mode": "tags"}, None), 1, "")
    assert_error(process_frame({"id": 1, "mode": "tags"}, 12345), 1, "")
    assert_error(process_frame({"id": 1, "mode": {"a": 1}}, TAGS_JPEG), 1, "unknown mode")
    reply = process_frame({"id": 2, "mode": "colors", "params": "x"}, POLES_JPEG)  # bad params -> defaults
    assert reply["type"] == "result" and len(reply["blobs"]) == 3
    assert process_frame({"mode": "colors"}, POLES_JPEG)["id"] is None


def test_detector_crash_becomes_an_error_reply(monkeypatch):
    def boom(img, params):
        raise RuntimeError("detector exploded")

    monkeypatch.setitem(process._DETECTORS, "line", boom)
    assert_error(process_message(message("line", LINE_JPEG, frame_id=5)), 5, "internal error: RuntimeError")
    assert process_message(message("tags", TAGS_JPEG, frame_id=6))["type"] == "result"  # still works


def test_repeated_failures_are_logged_once(monkeypatch, caplog):
    def boom(img, params):
        raise ValueError("same problem every frame " + "x" * 400)

    monkeypatch.setitem(process._DETECTORS, "colors", boom)
    monkeypatch.setattr(process, "_last_logged", {})
    for i in range(5):
        reply = process_message(message("colors", POLES_JPEG, frame_id=i))
        assert reply["type"] == "error" and len(reply["text"]) <= 300
    assert len([r for r in caplog.records if r.name == "vision"]) == 1


def test_non_finite_result_becomes_an_error(monkeypatch):
    monkeypatch.setitem(process._DETECTORS, "line", lambda img, params: {"refY": float("nan"), "line": None})
    assert_error(process_message(message("line", LINE_JPEG, frame_id=9)), 9, "internal error")


def test_fuzz_never_raises():
    rng = random.Random(1234)
    good = [message(m, j) for m, j in (("tags", TAGS_JPEG), ("line", LINE_JPEG), ("colors", POLES_JPEG))]
    small_jpeg = jpeg_bytes(np.full((16, 24, 3), 90, np.uint8))
    for i in range(300):
        kind = i % 5
        if kind == 0:  # random bytes
            data = bytes(rng.getrandbits(8) for _ in range(rng.randint(0, 64)))
        elif kind == 1:  # a good message cut short
            g = good[i % 3]
            data = g[:rng.randint(0, min(len(g), 600))]
        elif kind == 2:  # a good header, corrupted JPEG
            data = bytearray(message(MODES[i % 3], small_jpeg))
            for _ in range(rng.randint(1, 8)):
                k = rng.randrange(4 + 40, len(data))
                data[k] = rng.getrandbits(8)
            data = bytes(data)
        elif kind == 3:  # random JSON-ish headers
            header = {"id": rng.choice([0, 1, -1, 2**40, "x", None]), "mode": rng.choice(list(MODES) + ["", 3]),
                      "params": rng.choice([{}, {"mask": True}, [], None, {"colors": {"a": {"h": [1]}}}])}
            data = frame_message(header, small_jpeg)
        else:  # random length prefix
            data = struct.pack(">I", rng.randint(0, 2**32 - 1)) + bytes(rng.getrandbits(8) for _ in range(20))
        reply = process_message(data)
        assert reply["type"] in ("result", "error")
        assert_json_safe(reply)


def test_two_threads_at_once_give_the_same_replies():
    msgs = [message("tags", TAGS_JPEG, hfovDeg=70), message("line", LINE_JPEG), message("colors", POLES_JPEG),
            message("tags", jpeg_bytes(tag_scene(seed=5), 70))]

    def strip_ms(r: dict) -> dict:
        return {k: v for k, v in r.items() if k != "ms"}

    expected = [strip_ms(process_message(m)) for m in msgs]
    errors, got = [], []

    def worker(offset: int) -> None:
        try:
            for i in range(12):
                j = (i + offset) % len(msgs)
                got.append((j, strip_ms(process_message(msgs[j]))))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(k,), name=f"vision-{k}") for k in range(2)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert not errors and len(got) == 24
    for j, reply in got:
        assert reply == expected[j]
