import shutil
import subprocess
import time
from pathlib import Path

import cv2
import pytest

from bridge.mock_serial import MAX_DELTA_US, MISSION1_TEXT, MockSerial
from bridge.vision_session import TagSession

HOST = Path(__file__).resolve().parent.parent


def read_lines(ser, seconds=0.3):
    out, end = [], time.time() + seconds
    while time.time() < end:
        with ser._lock:
            data = bytes(ser._incoming)
            ser._incoming.clear()
        out += data.decode().splitlines()
        time.sleep(0.02)
    return out


# ---------- fake ESP32 = the protocol the firmware must follow ----------

def test_drive_is_clamped_and_malformed_lines_are_ignored():
    ser = MockSerial()
    ser.write(b"D 0.1 -0.2 1.0\n")
    assert ser.us == [1550, 1400, 1500 + MAX_DELTA_US]  # 1.0 is clamped to the firmware limit
    for bad in (b"D 0.1 0.2\n", b"D 2 0 0\n", b"D a b c\n"):
        ser.write(bad)
        assert ser.us == [1550, 1400, 1500 + MAX_DELTA_US]  # unchanged, never half-applied
    ser.write(b"S\n")
    assert ser.us == [1500, 1500, 1500]
    ser.close()


def test_watchdog_stops_thrusters_when_commands_stop():
    ser = MockSerial()
    ser.write(b"D 0.2 0.2 0\n")
    assert ser.us != [1500, 1500, 1500]
    lines = read_lines(ser, 0.9)
    assert ser.us == [1500, 1500, 1500]
    assert any(line.startswith("W watchdog") for line in lines)
    assert any(line.startswith("T ") for line in lines)  # telemetry keeps coming
    ser.close()


def test_mission1_flow():
    ser = MockSerial()
    ser.write(b"G\n")
    assert any("wifi not connected" in line for line in read_lines(ser, 0.1))
    ser.write(b"M UR_Field 12345678\n")
    assert any("connected" in line for line in read_lines(ser, 1.4))
    ser.write(b"U http://192.168.4.1/\nG\n")
    assert f"N got: {MISSION1_TEXT}" in read_lines(ser, 0.1)
    ser.close()


# ---------- AprilTag service ----------

def jpeg(path):
    ok, buf = cv2.imencode(".jpg", cv2.imread(str(path)), [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok
    return buf.tobytes()


def test_tag_session_confirms_selects_and_undoes():
    session = TagSession(expected=3, confirm_frames=3)
    frame = jpeg(HOST / "tags" / "sheet.png")
    session.command({"cmd": "rule", "rule": "smallest"})
    for k in range(3):
        r = session.handle_frame(frame, now=float(k))
    assert r["type"] == "tags"
    assert sorted(d["id"] for d in r["detections"]) == [17, 245, 503]
    assert r["confirmed"] == [17, 245, 503]
    assert r["selected"] == 17
    # corners come back in the coordinates of the frame that was sent
    img = cv2.imread(str(HOST / "tags" / "sheet.png"))
    assert r["width"] == img.shape[1] and max(c[0] for d in r["detections"] for c in d["corners"]) <= img.shape[1]
    st = session.command({"cmd": "rule", "rule": "largest"})
    assert st["selected"] == 503
    st = session.command({"cmd": "undo"})
    assert st["selected"] is None and st["best_so_far"] == 245  # 2 of 3: no final answer
    assert session.command({"cmd": "reset"})["confirmed"] == []


def test_bad_frame_is_reported_not_crashing():
    assert TagSession().handle_frame(b"not a jpeg")["type"] == "error"


# ---------- browser mixer (JavaScript, needs node) ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_webgui_mixer_js():
    res = subprocess.run(["node", "--test", str(HOST / "tests" / "webgui_mixer.test.mjs")],
                         capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stdout + res.stderr
