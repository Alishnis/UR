"""Bridge tests: real WebSocket + HTTP servers on free ports, with the mock ESP32."""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from bridge.server import Bridge, validate_browser_line

HOST_DIR = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@asynccontextmanager
async def running_bridge(**kw):
    kw.setdefault("mock", True)
    kw.setdefault("mock_arm_ms", 50)
    bridge = Bridge(http_port=free_port(), ws_port=free_port(), **kw)
    await bridge.start()
    try:
        yield bridge
    finally:
        await bridge.stop()


def ws_url(b: Bridge) -> str:
    return f"ws://127.0.0.1:{b.ws_port}"


async def recv_until(ws, pred, timeout=2.0):
    end = time.monotonic() + timeout
    seen = []
    while time.monotonic() < end:
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=max(0.01, end - time.monotonic()))
        except asyncio.TimeoutError:
            break
        seen.append(msg)
        if pred(msg):
            return msg, seen
    raise AssertionError(f"expected line not received, saw: {seen[-8:]}")


def run(coro):
    return asyncio.run(coro)


# ---- validation (pure) ------------------------------------------------------

@pytest.mark.parametrize("line", ["D 0.1 0.1 0.1", "S", "P", "G", "R", "R 1", "M net pw", "U http://x/", "  S  "])
def test_validate_accepts_gui_commands(line):
    assert validate_browser_line(line) is None


@pytest.mark.parametrize("line,why", [
    ("S\nD 1 1 1", "one line"),
    ("S\r", "one line"),
    ("D 1 1 1\n", "one line"),
    ("X 1", "not allowed"),
    ("T 1500 1500 1500", "not allowed"),
    ("B serial connected", "not allowed"),
    ("", "empty"),
    ("   ", "empty"),
    ("D " + "0" * 200, "longer"),
    ("D 0.1 0.1 0.1\x00", "non-printable"),
    ("D 0.1 0.1 0.é", "non-printable"),
    (b"D 0 0 0", "binary"),
    (None, "binary"),
])
def test_validate_rejects(line, why):
    reason = validate_browser_line(line)
    assert reason is not None and why in reason


def test_validate_line_length_boundary():
    assert validate_browser_line("D 0.1 0.1 0.1" + " " * 147) is None  # exactly 160
    assert validate_browser_line("D 0.1 0.1 0.1" + " " * 148) is not None  # 161


# ---- routing through the mock ESP32 ----------------------------------------

def test_ping_pong_and_telemetry_reach_the_browser():
    async def go():
        async with running_bridge() as b, connect(ws_url(b)) as ws:
            first = await ws.recv()
            assert first == "B bridge mock"
            await recv_until(ws, lambda m: m.startswith("B mock"))
            await asyncio.sleep(0.15)  # mock arming (50 ms)
            await ws.send("P")
            await recv_until(ws, lambda m: m == "PONG")
            await recv_until(ws, lambda m: m.startswith("T "))
    run(go())


def test_drive_command_is_clamped_by_the_esp32_and_reported():
    async def go():
        async with running_bridge() as b, connect(ws_url(b)) as ws:
            await asyncio.sleep(0.15)
            await ws.send("D 1 -1 0")
            await recv_until(ws, lambda m: m == "T 1650 1350 1500")
    run(go())


def test_telemetry_reaches_every_browser():
    async def go():
        async with running_bridge() as b:
            async with connect(ws_url(b)) as a, connect(ws_url(b)) as c:
                await asyncio.sleep(0.15)
                await a.send("D 0.1 0.1 0.1")
                await recv_until(a, lambda m: m == "T 1550 1550 1550")
                await recv_until(c, lambda m: m == "T 1550 1550 1550")
    run(go())


def test_bad_lines_never_reach_the_esp32_and_the_sender_is_told():
    async def go():
        async with running_bridge() as b, connect(ws_url(b)) as ws:
            await asyncio.sleep(0.15)
            await ws.send("D 0.2 0.2 0.2")
            await recv_until(ws, lambda m: m == "T 1600 1600 1600")
            for bad in ["X 1", "S\nD 1 1 1", "T 1 2 3", "D 0.9 0.9 0.9\x00", "D " + "0" * 300]:
                await ws.send(bad)
                msg, _ = await recv_until(ws, lambda m: m.startswith("B rejected"))
            await ws.send(b"S")  # binary frame
            await recv_until(ws, lambda m: m.startswith("B rejected: binary"))
            # the earlier D 0.2 is still in force: nothing in the junk reached the mock
            assert b.link.mock.us == [1600, 1600, 1600]
    run(go())


def test_last_browser_disconnect_sends_S_immediately():
    async def go():
        async with running_bridge() as b:
            async with connect(ws_url(b)) as ws:
                await asyncio.sleep(0.15)
                await ws.send("D 0.2 0.2 0.2")
                await recv_until(ws, lambda m: m == "T 1600 1600 1600")
            # The mock watchdog is 500 ms: neutral well before that proves the bridge sent S.
            await asyncio.sleep(0.15)
            assert b.link.mock.us == [1500, 1500, 1500]
            assert b.link.mock.wd_tripped is False  # S refreshed it: not the watchdog's doing
    run(go())


def test_disconnect_of_one_of_two_browsers_does_not_stop_the_motors():
    async def go():
        async with running_bridge() as b:
            async with connect(ws_url(b)) as a:
                async with connect(ws_url(b)) as c:
                    await asyncio.sleep(0.15)
                    await a.send("D 0.2 0.2 0.2")
                    await recv_until(a, lambda m: m == "T 1600 1600 1600")
                await asyncio.sleep(0.1)
                assert b.link.mock.us == [1600, 1600, 1600]
    run(go())


def test_bridge_shutdown_sends_S_before_closing():
    async def go():
        b = Bridge(mock=True, mock_arm_ms=50, http_port=free_port(), ws_port=free_port())
        await b.start()
        async with connect(ws_url(b)) as ws:
            await asyncio.sleep(0.15)
            await ws.send("D 0.2 0.2 0.2")
            await recv_until(ws, lambda m: m == "T 1600 1600 1600")
            mock = b.link.mock
            await b.stop()  # a browser is still connected
            assert mock.us == [1500, 1500, 1500]
    run(go())


# ---- origin check -------------------------------------------------------------

def test_foreign_web_pages_cannot_connect():
    async def go():
        async with running_bridge() as b:
            with pytest.raises(InvalidStatus) as e:
                async with connect(ws_url(b), origin="http://evil.example") as ws:
                    await ws.recv()
            assert e.value.response.status_code == 403
            # The GUI's own origins are fine.
            for host in ("localhost", "127.0.0.1"):
                async with connect(ws_url(b), origin=f"http://{host}:{b.http_port}") as ws:
                    assert await ws.recv() == "B bridge mock"
            # Same host, wrong port (another local web app) is refused too.
            with pytest.raises(InvalidStatus):
                async with connect(ws_url(b), origin="http://localhost:3000") as ws:
                    await ws.recv()
    run(go())


# ---- HTTP -----------------------------------------------------------------------

def test_http_serves_gui_without_caching_and_no_traversal():
    async def go():
        async with running_bridge() as b:
            base = f"http://127.0.0.1:{b.http_port}"

            def get(path):
                try:
                    with urllib.request.urlopen(base + path, timeout=3) as r:
                        return r.status, r.headers, r.read()
                except urllib.error.HTTPError as e:
                    return e.code, e.headers, b""

            loop = asyncio.get_running_loop()
            status, headers, body = await loop.run_in_executor(None, get, "/")
            assert status == 200 and b"ROV control" in body
            assert headers["Cache-Control"] == "no-store"
            status, headers, _ = await loop.run_in_executor(None, get, "/js/config.js")
            assert status == 200 and "javascript" in headers["Content-Type"]
            for evil in ("/../bridge/server.py", "/..%2fbridge/server.py", "/%2e%2e/bridge/server.py"):
                status, _, body = await loop.run_in_executor(None, get, evil)
                assert status in (301, 400, 403, 404) and b"class Bridge" not in body, evil
    run(go())


# ---- the real serial path, through a pseudo-terminal --------------------------

def test_real_serial_link_through_a_pty(tmp_path):
    log = tmp_path / "mock.log"
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "bridge.mock_esp32", "--pty", "--arm-ms", "50"],
        cwd=HOST_DIR, stdout=open(log, "w"), stderr=subprocess.STDOUT,
    )
    try:
        pty = None
        for _ in range(100):
            text = log.read_text()
            if "mock ESP32 on " in text:
                pty = text.split("mock ESP32 on ")[1].split()[0]
                break
            time.sleep(0.05)
        assert pty, "mock pty did not start"

        async def go():
            async with running_bridge(mock=False, serial_port=pty) as b, connect(ws_url(b)) as ws:
                await recv_until(ws, lambda m: m.startswith("B serial") and "connected" in m, timeout=3)
                await asyncio.sleep(0.2)
                await ws.send("P")
                await recv_until(ws, lambda m: m == "PONG", timeout=3)
                await ws.send("D 1 -1 0")
                await recv_until(ws, lambda m: m == "T 1650 1350 1500", timeout=3)
                await ws.send("S")
                await recv_until(ws, lambda m: m == "T 1500 1500 1500", timeout=3)

        run(go())
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def test_missing_serial_port_keeps_the_bridge_alive_and_says_why():
    async def go():
        async with running_bridge(mock=False, serial_port="/dev/does-not-exist") as b:
            async with connect(ws_url(b)) as ws:
                msg, _ = await recv_until(ws, lambda m: m.startswith("B serial waiting"), timeout=3)
                assert "does-not-exist" in msg
                await ws.send("D 0.1 0.1 0.1")  # nothing to send to: must not crash or queue
                await ws.send("P")
                await asyncio.sleep(0.2)
                assert b.link.connected is False
    run(go())


# ---- Mission 1 through the bridge ------------------------------------------------

def test_mission1_flow_through_the_bridge():
    async def go():
        async with running_bridge() as b, connect(ws_url(b)) as ws:
            await asyncio.sleep(0.15)
            await ws.send("U http://192.168.4.1/")
            await recv_until(ws, lambda m: m == "N url set: http://192.168.4.1/")
            await ws.send("M UR_Field 12345678")
            await recv_until(ws, lambda m: m == "N wifi: connecting to UR_Field")
            await recv_until(ws, lambda m: m.startswith("N wifi: connected, ip "), timeout=3)
            await ws.send("G")
            await recv_until(ws, lambda m: m.startswith("N got: Congratulations"))
    run(go())
