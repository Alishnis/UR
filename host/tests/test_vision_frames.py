"""Vision frame messages: binary layout, JPEG decoding, masks, rounding and parameter helpers."""

from __future__ import annotations

import base64
import json
import math
import struct

import cv2
import numpy as np
import pytest

from vision.frames import (MAX_HEADER_BYTES, MAX_JPEG_BYTES, FrameError, decode_jpeg, jpeg_size, mask_data_url,
                           param_bool, param_int, param_number, parse_frame_message, round1, round3, round_point)
from vision_synth import frame_message, jpeg_bytes

JPEG = jpeg_bytes(np.full((24, 32, 3), 128, np.uint8))


def raw_message(header_bytes: bytes, jpeg: bytes = JPEG) -> bytes:
    return struct.pack(">I", len(header_bytes)) + header_bytes + jpeg


# ---------- parse_frame_message ----------

def test_round_trip():
    header = {"id": 42, "mode": "tags", "params": {"clahe": False}}
    got, jpeg = parse_frame_message(frame_message(header, JPEG))
    assert got == header and jpeg == JPEG


def test_missing_params_become_empty_and_other_buffers_work():
    msg = frame_message({"id": 1, "mode": "line"}, JPEG)
    for data in (msg, bytearray(msg), memoryview(msg)):
        header, jpeg = parse_frame_message(data)
        assert header["params"] == {} and jpeg == JPEG


def test_header_length_limits():
    body = {"id": 1, "mode": "tags", "params": {}, "pad": ""}
    base = len(json.dumps(body).encode())
    body["pad"] = "x" * (MAX_HEADER_BYTES - base)
    exact = json.dumps(body).encode()
    assert len(exact) == MAX_HEADER_BYTES
    parse_frame_message(raw_message(exact))
    body["pad"] += "x"
    with pytest.raises(FrameError, match="header length"):
        parse_frame_message(raw_message(json.dumps(body).encode()))
    with pytest.raises(FrameError, match="header length 0"):
        parse_frame_message(struct.pack(">I", 0) + JPEG)


@pytest.mark.parametrize("data, match", [
    (b"", "shorter than the 4-byte"),
    (b"\x00\x00\x01", "shorter than the 4-byte"),
    (struct.pack(">I", 50) + b'{"id": 1}', "ends inside"),
    (raw_message(b"\xff\xfe{}"), "not valid JSON"),
    (raw_message(b'{"id": 1, "mode": '), "not valid JSON"),
    (raw_message(b"[1, 2]"), "JSON object"),
    (raw_message(b'"text"'), "JSON object"),
])
def test_malformed_layout(data, match):
    with pytest.raises(FrameError, match=match) as e:
        parse_frame_message(data)
    assert e.value.frame_id is None


@pytest.mark.parametrize("frame_id", [None, -1, 2**31, 1.5, 3.0, True, "7", [1]])
def test_bad_ids(frame_id):
    header = {"mode": "tags"} if frame_id is None else {"id": frame_id, "mode": "tags"}
    with pytest.raises(FrameError, match="id") as e:
        parse_frame_message(frame_message(header, JPEG))
    assert e.value.frame_id is None


def test_id_range_ends_are_valid():
    for frame_id in (0, 2**31 - 1):
        header, _ = parse_frame_message(frame_message({"id": frame_id, "mode": "tags"}, JPEG))
        assert header["id"] == frame_id


@pytest.mark.parametrize("header, match", [
    ({"id": 5, "mode": 3}, "mode"),
    ({"id": 5}, "mode"),
    ({"id": 5, "mode": "tags", "params": [1]}, "params"),
    ({"id": 5, "mode": "tags", "params": None}, "params"),
])
def test_bad_fields_keep_the_id(header, match):
    with pytest.raises(FrameError, match=match) as e:
        parse_frame_message(frame_message(header, JPEG))
    assert e.value.frame_id == 5


def test_jpeg_part_size():
    with pytest.raises(FrameError, match="no JPEG") as e:
        parse_frame_message(frame_message({"id": 9, "mode": "tags"}, b""))
    assert e.value.frame_id == 9
    parse_frame_message(frame_message({"id": 9, "mode": "tags"}, b"\xff" * MAX_JPEG_BYTES))
    with pytest.raises(FrameError, match="larger than"):
        parse_frame_message(frame_message({"id": 9, "mode": "tags"}, b"\xff" * (MAX_JPEG_BYTES + 1)))


def test_text_is_not_a_frame():
    with pytest.raises(FrameError, match="binary"):
        parse_frame_message('{"type": "ping"}')


# ---------- JPEG ----------

@pytest.mark.parametrize("w, h", [(1, 1), (32, 24), (640, 360), (1280, 720)])
def test_jpeg_size_and_decode(w, h):
    data = jpeg_bytes(np.random.default_rng(0).integers(0, 255, (h, w, 3), np.uint8))
    assert jpeg_size(data) == (w, h)
    img = decode_jpeg(data)
    assert img.shape == (h, w, 3) and img.dtype == np.uint8


def test_grey_jpeg_decodes_to_three_channels():
    ok, buf = cv2.imencode(".jpg", np.full((10, 20), 77, np.uint8))
    assert decode_jpeg(buf.tobytes()).shape == (10, 20, 3)


def test_not_a_jpeg():
    ok, png = cv2.imencode(".png", np.zeros((8, 8, 3), np.uint8))
    for data in (png.tobytes(), b"hello world", b"\xff\xd8", b"\xff\xd8\xff\xd9", b"\xff\xd8" + b"\x00" * 50):
        with pytest.raises(FrameError):
            decode_jpeg(data)
        assert jpeg_size(data) is None


def test_truncated_jpeg_is_refused_or_decoded_but_never_crashes():
    for cut in (3, 20, 200, len(JPEG) // 2, len(JPEG) - 2):
        try:
            img = decode_jpeg(JPEG[:cut])
        except FrameError:
            continue
        assert img.ndim == 3


def test_huge_declared_size_is_refused_before_decoding():
    data = bytearray(JPEG)
    i = 2
    while not (data[i] == 0xFF and 0xC0 <= data[i + 1] <= 0xC2):  # find SOF0..2
        i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    data[i + 5:i + 9] = struct.pack(">HH", 60000, 60000)  # height, width
    assert jpeg_size(bytes(data)) == (60000, 60000)
    with pytest.raises(FrameError, match="60000x60000"):
        decode_jpeg(bytes(data))


# ---------- masks and rounding ----------

def test_mask_data_url_round_trip():
    mask = np.zeros((30, 40), np.uint8)
    mask[5:20, 10:25] = 1  # any non-zero value is white
    url = mask_data_url(mask)
    assert url.startswith("data:image/png;base64,")
    png = base64.b64decode(url.split(",", 1)[1])
    back = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
    assert back.shape == (30, 40)
    assert np.array_equal(back > 0, mask > 0)
    assert mask_data_url(mask.astype(bool)) == url


def test_rounding_gives_plain_floats():
    assert round1(np.float32(1.26)) == 1.3 and type(round1(np.float32(1.26))) is float
    assert round3(1.23456) == 1.235
    assert json.dumps([round1(-0.04), round3(-0.0001)]) == "[0.0, 0.0]"  # no "-0.0"
    p = round_point(np.array([10.04, 20.06]))
    assert p == [10.0, 20.1] and all(type(v) is float for v in p)


# ---------- parameters ----------

def test_param_number_rules():
    assert param_number({}, "k", 5.0, 0, 10) == 5.0
    assert param_number({"k": 7}, "k", 5.0, 0, 10) == 7.0
    assert param_number({"k": 70}, "k", 5.0, 0, 10) == 10.0  # out of range: clamped
    assert param_number({"k": -3.5}, "k", 5.0, 0, 10) == 0.0
    assert param_number({"k": math.inf}, "k", 5.0, 0, 10) == 10.0
    for wrong in ("7", None, True, [7], {"v": 7}, math.nan):
        assert param_number({"k": wrong}, "k", 5.0, 0, 10) == 5.0  # wrong type: default
    assert param_number({"k": None}, "k", None, 0, 10) is None


def test_param_int_and_bool():
    assert param_int({"n": 2.6}, "n", 3, 1, 10) == 3
    assert param_int({"n": 99}, "n", 3, 1, 10) == 10
    assert param_int({"n": "4"}, "n", 3, 1, 10) == 3
    assert param_bool({"b": False}, "b", True) is False
    for wrong in (0, 1, "true", None):
        assert param_bool({"b": wrong}, "b", True) is True


def test_huge_json_numbers_are_clamped_not_crashing():
    from vision.colors import colors_params
    from vision.frames import param_int, param_number
    assert param_number({"x": 10**400}, "x", 1.0, 1.0, 4.0) == 4.0
    assert param_number({"x": -(10**400)}, "x", 1.0, 1.0, 4.0) == 1.0
    assert param_int({"x": 10**400}, "x", 3, 0, 20) == 20
    p = colors_params({"colors": {"red": {"h": [10**400, 1], "s": [0, 10**400], "v": [-(10**400), 255]}}})
    assert p["colors"]["red"]["h"] == [179, 1]
