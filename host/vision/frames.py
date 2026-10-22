"""Browser -> vision service frame messages, JPEG decoding and helpers shared by the detectors.

Binary message layout (docs/PROTOCOL.md, "Vision WebSocket"):

    bytes 0..3    uint32 big-endian N = header length, 1 <= N <= 4096
    bytes 4..4+N  UTF-8 JSON object {"id": int 0..2^31-1, "mode": str, "params": {...}}
    rest          JPEG image, 1 .. 4 000 000 bytes
"""

from __future__ import annotations

import base64
import json
import math

import cv2
import numpy as np

MAX_HEADER_BYTES = 4096
MAX_JPEG_BYTES = 4_000_000
MAX_ID = 2**31 - 1
# a 4 MB JPEG can claim a huge size and decode into gigabytes: refuse before decoding (browser sends <= 1280 wide)
MAX_IMAGE_PIXELS = 4096 * 4096


class FrameError(Exception):
    """A message or image we cannot process. frame_id is the header id when it was readable."""

    def __init__(self, text: str, frame_id: int | None = None) -> None:
        super().__init__(text)
        self.frame_id = frame_id


def valid_id(value: object) -> bool:
    return type(value) is int and 0 <= value <= MAX_ID  # bool is an int subclass: not an id


def parse_frame_message(data: bytes) -> tuple[dict, bytes]:
    """Split a binary message into (header, jpeg). Raises FrameError with a short reason."""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise FrameError("binary message expected")
    data = bytes(data)
    if len(data) < 4:
        raise FrameError("message shorter than the 4-byte header length")
    n = int.from_bytes(data[:4], "big")
    if not 1 <= n <= MAX_HEADER_BYTES:
        raise FrameError(f"header length {n} not in 1..{MAX_HEADER_BYTES}")
    if len(data) < 4 + n:
        raise FrameError(f"message ends inside the {n}-byte header")
    try:
        header = json.loads(data[4:4 + n].decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as e:  # RecursionError: absurdly deep nesting
        raise FrameError(f"header is not valid JSON: {e}") from None
    if not isinstance(header, dict):
        raise FrameError("header must be a JSON object")
    frame_id = header.get("id")
    if not valid_id(frame_id):
        raise FrameError("header id must be an integer 0..2147483647")
    if not isinstance(header.get("mode"), str):
        raise FrameError("header mode must be a string", frame_id)
    if "params" not in header:
        header["params"] = {}
    elif not isinstance(header["params"], dict):
        raise FrameError("header params must be an object", frame_id)
    jpeg = data[4 + n:]
    if not jpeg:
        raise FrameError("no JPEG after the header", frame_id)
    if len(jpeg) > MAX_JPEG_BYTES:
        raise FrameError(f"JPEG larger than {MAX_JPEG_BYTES} bytes", frame_id)
    return header, jpeg


def jpeg_size(jpeg: bytes) -> tuple[int, int] | None:
    """(width, height) from the JPEG's SOF marker without decoding, None if not found."""
    if len(jpeg) < 4 or jpeg[0] != 0xFF or jpeg[1] != 0xD8:
        return None
    i, n = 2, len(jpeg)
    while i + 4 <= n:
        if jpeg[i] != 0xFF:
            return None
        marker = jpeg[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # markers without a length field
            i += 2
            continue
        if marker in (0xD9, 0xDA):  # end of image / start of scan before any frame header
            return None
        seg_len = int.from_bytes(jpeg[i + 2:i + 4], "big")
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):  # SOFn (not DHT, JPG, DAC)
            if i + 9 > n:
                return None
            return int.from_bytes(jpeg[i + 7:i + 9], "big"), int.from_bytes(jpeg[i + 5:i + 7], "big")
        if seg_len < 2:
            return None
        i += 2 + seg_len
    return None


def decode_jpeg(jpeg: bytes) -> np.ndarray:
    """JPEG bytes -> BGR uint8 image. Raises FrameError."""
    jpeg = bytes(jpeg)
    size = jpeg_size(jpeg)
    if size is None:
        raise FrameError("not a JPEG image")
    w, h = size
    if w < 1 or h < 1 or w * h > MAX_IMAGE_PIXELS:
        raise FrameError(f"JPEG size {w}x{h} not accepted (max {MAX_IMAGE_PIXELS} pixels)")
    # ignore EXIF rotation: result coordinates must be pixels of the JPEG exactly as the browser drew it
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
    if img is None or img.size == 0:
        raise FrameError("could not decode the JPEG")
    return img


def mask_data_url(mask: np.ndarray) -> str:
    """Binary mask (anything > 0 = white) -> 'data:image/png;base64,...' (1-bit PNG: small)."""
    m = np.where(np.asarray(mask) > 0, 255, 0).astype(np.uint8)
    ok, buf = cv2.imencode(".png", m, [cv2.IMWRITE_PNG_BILEVEL, 1])
    if not ok:
        raise ValueError("PNG encoding failed")
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


# ---------- rounding (results are JSON: plain Python floats, no -0.0) ----------

def round1(x: float) -> float:
    return round(float(x), 1) + 0.0


def round3(x: float) -> float:
    return round(float(x), 3) + 0.0


def round_point(p) -> list[float]:
    return [round1(p[0]), round1(p[1])]


def round_points(pts) -> list[list[float]]:
    return [round_point(p) for p in pts]


# ---------- parameters: unknown keys ignored, out of range clamped, wrong type -> default ----------

def param_number(params: dict, key: str, default: float, lo: float, hi: float) -> float:
    v = params.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    if isinstance(v, int):  # a huge JSON int would overflow float(): clamp it as an int first
        v = min(max(v, math.floor(lo)), math.ceil(hi))
    if math.isnan(v):
        return default
    return min(max(float(v), lo), hi)


def param_int(params: dict, key: str, default: int, lo: int, hi: int) -> int:
    v = param_number(params, key, default, lo, hi)
    return int(round(v))


def param_bool(params: dict, key: str, default: bool) -> bool:
    v = params.get(key, default)
    return v if isinstance(v, bool) else default
