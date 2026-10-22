"""Vision WebSocket service: a real Bridge on free ports with the mock ESP32, synthetic JPEG frames."""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import sys
import threading
import time
from contextlib import asynccontextmanager

import cv2
import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

import vision.process
from bridge import vision_service
from bridge.server import Bridge
from vision_synth import TAG_IDS, frame_message, jpeg_bytes, poles_scene, tag_scene

TAGS_JPEG = jpeg_bytes(tag_scene(seed=3), 85)
POLES_JPEG = jpeg_bytes(poles_scene()[0], 80)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@asynccontextmanager
async def running_bridge(**kw):
    kw.setdefault("mock", True)
    kw.setdefault("mock_arm_ms", 50)
    kw.setdefault("vision_port", 0)  # never the real 8766: tests may run next to a real bridge
    bridge = Bridge(http_port=free_port(), ws_port=free_port(), **kw)
    await bridge.start()
    try:
        yield bridge
    finally:
        await bridge.stop()


def vision_url(b: Bridge) -> str:
    return f"ws://127.0.0.1:{b.vision_port}"


def line_url(b: Bridge) -> str:
    return f"ws://127.0.0.1:{b.ws_port}"


async def recv_json(ws, timeout: float = 5.0) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def recv_line_until(ws, want: str, timeout: float = 2.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        msg = await asyncio.wait_for(ws.recv(), timeout=max(0.01, end - time.monotonic()))
        if msg == want:
            return
    raise AssertionError(f"{want!r} not received")


def run(coro):
    return asyncio.run(coro)


def msg(mode: str, jpeg: bytes, frame_id: int = 1, **params) -> bytes:
    return frame_message({"id": frame_id, "mode": mode, "params": params}, jpeg)


# ---- hello, results, errors -------------------------------------------------------

def test_hello_then_tags_result_for_a_jpeg():
    async def go():
        async with running_bridge() as b, connect(vision_url(b)) as ws:
            assert b.vision_port not in (0, 8766)
            assert "ws://localhost:" in b.vision_status()
            hello = await recv_json(ws)
            assert hello == {"type": "hello", "version": 1, "available": True,
                             "modes": ["tags", "line", "colors"]}
            await ws.send(msg("tags", TAGS_JPEG, frame_id=42))
            r = await recv_json(ws)
            assert r["type"] == "result" and r["id"] == 42 and r["mode"] == "tags"
            assert (r["w"], r["h"]) == (1280, 720)
            assert isinstance(r["ms"], (int, float))
            assert sorted(t["id"] for t in r["tags"]) == sorted(TAG_IDS)
    run(go())


def test_colors_result_and_frames_are_answered_in_order():
    async def go():
        async with running_bridge() as b, connect(vision_url(b)) as ws:
            await recv_json(ws)
            for i in range(3):
                await ws.send(msg("colors", POLES_JPEG, frame_id=100 + i))
            ids = [(await recv_json(ws))["id"] for _ in range(3)]
            assert ids == [100, 101, 102]
    run(go())


def test_errors_keep_the_connection_open():
    async def go():
        async with running_bridge() as b, connect(vision_url(b)) as ws:
            await recv_json(ws)
            await ws.send(msg("tags", b"not a jpeg", frame_id=7))
            r = await recv_json(ws)
            assert r["type"] == "error" and r["id"] == 7 and r["text"]
            await ws.send(msg("faces", TAGS_JPEG, frame_id=8))
            r = await recv_json(ws)
            assert r["type"] == "error" and r["id"] == 8 and "mode" in r["text"]
            await ws.send(b"\x00\x00")  # truncated header
            r = await recv_json(ws)
            assert r["type"] == "error" and r["id"] is None
            await ws.send("hello?")
            r = await recv_json(ws)
            assert r["type"] == "error" and r["id"] is None
            await ws.send('{"type": "nope"}')
            assert (await recv_json(ws))["type"] == "error"
            # still works after all that
            await ws.send(msg("colors", POLES_JPEG, frame_id=9))
            r = await recv_json(ws)
            assert r["type"] == "result" and r["id"] == 9
    run(go())


def test_ping_pong():
    async def go():
        async with running_bridge() as b, connect(vision_url(b)) as ws:
            await recv_json(ws)
            await ws.send('{"type":"ping"}')
            assert await recv_json(ws) == {"type": "pong"}
    run(go())


def test_internal_exception_becomes_an_error_and_the_session_continues(monkeypatch):
    def boom(data):
        raise RuntimeError("detector exploded")

    async def go():
        async with running_bridge() as b, connect(vision_url(b)) as ws:
            await recv_json(ws)
            monkeypatch.setattr(vision.process, "process_message", boom)
            await ws.send(msg("tags", TAGS_JPEG))
            r = await recv_json(ws)
            assert r["type"] == "error" and "detector exploded" in r["text"]
            monkeypatch.undo()
            await ws.send(msg("colors", POLES_JPEG, frame_id=5))
            assert (await recv_json(ws))["type"] == "result"
    run(go())


def test_oversized_message_closes_only_that_connection():
    async def go():
        async with running_bridge() as b:
            # No `async with`: the service drops the TCP connection while this client is still writing,
            # and the websockets client can trip over its own broken transport while closing. Only the
            # service's behaviour is under test here.
            ws = await connect(vision_url(b), max_size=None)
            try:
                await recv_json(ws)
                with contextlib.suppress(Exception):
                    await ws.send(b"\x00" * (vision_service.MAX_MESSAGE + 1))
                with pytest.raises(ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), 5)
            finally:
                with contextlib.suppress(Exception):
                    await ws.close()
            async with connect(vision_url(b)) as ws:  # the service is still there
                assert (await recv_json(ws))["available"] is True
    run(go())


# ---- origin check -------------------------------------------------------------

def test_foreign_web_pages_cannot_connect():
    async def go():
        async with running_bridge() as b:
            for bad in ("http://evil.example", "http://localhost:3000"):
                with pytest.raises(InvalidStatus) as e:
                    async with connect(vision_url(b), origin=bad) as ws:
                        await ws.recv()
                assert e.value.response.status_code == 403
            for host in ("localhost", "127.0.0.1"):
                async with connect(vision_url(b), origin=f"http://{host}:{b.http_port}") as ws:
                    assert (await recv_json(ws))["type"] == "hello"
    run(go())


# ---- switched off / unavailable ------------------------------------------------

def test_no_vision_means_no_listener():
    async def go():
        port = free_port()
        async with running_bridge(vision=False, vision_port=port) as b:
            assert b.vision is None and b.vision_status() == "off"
            with pytest.raises(OSError):
                async with connect(f"ws://127.0.0.1:{port}", open_timeout=2):
                    pass
            async with connect(line_url(b)) as ws:  # the line WebSocket is unaffected
                assert await ws.recv() == "B bridge mock"
    run(go())


def test_import_failure_gives_hello_unavailable_and_the_bridge_still_drives(monkeypatch):
    monkeypatch.setitem(sys.modules, "vision.process", None)  # makes the import raise ImportError

    async def go():
        async with running_bridge() as b:
            assert b.vision_status().startswith("UNAVAILABLE: ")
            async with connect(vision_url(b)) as ws:
                hello = await recv_json(ws)
                assert hello["type"] == "hello" and hello["version"] == 1
                assert hello["available"] is False and hello["modes"] == []
                assert "vision.process" in hello["reason"]
                await ws.send(msg("tags", TAGS_JPEG, frame_id=3))
                r = await recv_json(ws)
                assert r["type"] == "error" and "unavailable" in r["text"]
                await ws.send('{"type":"ping"}')
                assert await recv_json(ws) == {"type": "pong"}
            async with connect(line_url(b)) as ws:
                await asyncio.sleep(0.15)
                await ws.send("D 0.1 0.1 0.1")
                await recv_line_until(ws, "T 1550 1550 1550")
    run(go())


def test_busy_vision_port_is_not_fatal():
    async def go():
        with socket.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen()
            port = taken.getsockname()[1]
            async with running_bridge(vision_port=port) as b:
                assert b.vision is not None and not b.vision.listening
                assert b.vision_status().startswith("UNAVAILABLE: cannot listen on port")
                async with connect(line_url(b)) as ws:
                    await asyncio.sleep(0.15)
                    await ws.send("P")
                    await recv_line_until(ws, "PONG")
    run(go())


# ---- the bridge stays responsive -------------------------------------------------

async def pong_time(line) -> float:
    t0 = time.monotonic()
    await line.send("P")
    await recv_line_until(line, "PONG", timeout=2.0)
    return time.monotonic() - t0


def test_line_websocket_answers_while_a_slow_frame_is_processed(monkeypatch):
    real = vision.process.process_message
    started = threading.Event()

    def slow(data):
        started.set()
        time.sleep(1.0)  # holds a pool thread, never the event loop
        return real(data)

    async def go():
        async with running_bridge() as b, connect(vision_url(b)) as ws, connect(line_url(b)) as line:
            await recv_json(ws)
            await asyncio.sleep(0.15)  # mock arming
            monkeypatch.setattr(vision.process, "process_message", slow)
            await ws.send(msg("colors", POLES_JPEG, frame_id=11))
            for _ in range(100):
                if started.is_set():
                    break
                await asyncio.sleep(0.01)
            assert started.is_set()
            for _ in range(3):
                dt = await pong_time(line)
                assert dt < 0.3, f"PONG took {dt * 1000:.0f} ms"
            r = await recv_json(ws)
            assert r["type"] == "result" and r["id"] == 11
    run(go())


def test_line_websocket_answers_while_a_large_real_frame_is_processed():
    big = cv2.resize(tag_scene(seed=4), (3840, 2160), interpolation=cv2.INTER_LINEAR)
    jpeg = jpeg_bytes(big, 90)

    async def go():
        async with running_bridge() as b, connect(vision_url(b)) as ws, connect(line_url(b)) as line:
            await recv_json(ws)
            await asyncio.sleep(0.15)  # mock arming
            result = asyncio.ensure_future(recv_json(ws, timeout=20))
            await ws.send(msg("tags", jpeg, frame_id=12, decimate=1))
            dt = await pong_time(line)
            assert dt < 0.3, f"PONG took {dt * 1000:.0f} ms"
            # The PONG came back before the frame was done: the two really overlapped.
            assert not result.done()
            r = await result
            assert r["type"] == "result" and r["id"] == 12 and (r["w"], r["h"]) == (3840, 2160)
    run(go())


def test_stop_with_a_vision_client_connected():
    async def go():
        b = Bridge(mock=True, mock_arm_ms=50, http_port=free_port(), ws_port=free_port(), vision_port=0)
        await b.start()
        ws = await connect(vision_url(b))
        await recv_json(ws)
        await asyncio.wait_for(b.stop(), 5)
        with pytest.raises(ConnectionClosed):
            await asyncio.wait_for(ws.recv(), 2)
    run(go())


def test_text_messages_are_small_json_only():
    from bridge.vision_service import MAX_TEXT_MESSAGE, VisionService
    svc = VisionService("127.0.0.1", 0, [None])
    assert svc._text_reply('{"type": "ping"}') == {"type": "pong"}
    assert "longer than" in svc._text_reply("[" * (MAX_TEXT_MESSAGE + 1))["text"]
    assert svc._text_reply("[" * 1000 + "]" * 1000)["type"] == "error"  # deep nesting: an error, no crash
