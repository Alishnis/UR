"""The vision WebSocket (:8766): camera frames in, detections out. Display-only.

    browser --binary frame (header + JPEG)--> VisionService --thread--> vision.process_message()
            <--------------- JSON text: result | error ---------------

This service never talks to the ESP32 and never touches motor commands: the
results only draw boxes and hints in the GUI. CPU work runs in a small thread
pool so the line WebSocket (motors, E-STOP) stays responsive while a frame is
being processed. If OpenCV or pupil-apriltags cannot be imported, the service
still listens and says "available": false in its hello, and the rest of the
bridge works as before. Protocol: docs/PROTOCOL.md, "Vision WebSocket".
"""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
from concurrent.futures import ThreadPoolExecutor

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

log = logging.getLogger("bridge.vision")

VISION_VERSION = 1  # same as vision.process.VISION_VERSION; repeated so the hello works without OpenCV
MAX_MESSAGE = 4_000_000 + 4 + 4096  # JPEG + length prefix + header
MAX_TEXT_MESSAGE = 1024  # text is only {"type": "ping"}


def _error(frame_id: int | None, text: str) -> dict:
    return {"type": "error", "id": frame_id, "text": str(text)[:300]}


class VisionService:
    def __init__(self, host: str, port: int, origins: list[str | None]) -> None:
        self.host = host
        self.port = port  # 0 = pick a free port; the real one is set by start()
        self.origins = origins
        self.listening = False
        self._server = None
        self._pool: ThreadPoolExecutor | None = None
        # Imported here, not at module level: a missing OpenCV must not stop the bridge.
        try:
            self._vp = importlib.import_module("vision.process")
            self.available = True
            self.reason = ""
        except Exception as e:  # noqa: BLE001 - ImportError, or a broken native library (OSError)
            self._vp = None
            self.available = False
            self.reason = f"{type(e).__name__}: {e}"[:300]
            log.warning("vision unavailable: %s", self.reason)

    def hello(self) -> dict:
        if self.available:
            return {"type": "hello", "version": VISION_VERSION, "available": True,
                    "modes": list(self._vp.MODES)}
        return {"type": "hello", "version": VISION_VERSION, "available": False, "modes": [],
                "reason": self.reason}

    def describe(self) -> str:
        """One line for the console: where the service is, or why it is not working."""
        if not self.listening:
            return f"UNAVAILABLE: {self.reason}" if self.reason else "not started"
        if not self.available:
            return f"UNAVAILABLE: {self.reason}"
        return f"ws://localhost:{self.port}/  (camera missions 2-5)"

    # -- one browser ------------------------------------------------------
    async def _process(self, data: bytes) -> dict:
        if not self.available:
            return _error(None, f"vision unavailable: {self.reason}")
        loop = asyncio.get_running_loop()
        # Looked up on every frame (not bound once) so tests can swap it.
        return await loop.run_in_executor(self._pool, self._vp.process_message, data)

    def _text_reply(self, msg: str) -> dict:
        # runs on the event loop that forwards motor commands: only small messages are parsed
        if len(msg) > MAX_TEXT_MESSAGE:
            return _error(None, f"text message longer than {MAX_TEXT_MESSAGE} characters")
        try:
            obj = json.loads(msg)
        except (ValueError, RecursionError):
            return _error(None, "text messages must be JSON")
        if isinstance(obj, dict) and obj.get("type") == "ping":
            return {"type": "pong"}
        return _error(None, "unknown text message (frames are binary)")

    async def _handler(self, ws: ServerConnection) -> None:
        log.info("vision client connected")
        try:
            await ws.send(json.dumps(self.hello()))
            # One message at a time, reply before reading the next: natural back-pressure.
            async for msg in ws:
                try:
                    if isinstance(msg, str):
                        reply = self._text_reply(msg)
                    else:
                        reply = await self._process(msg)
                    text = json.dumps(reply, allow_nan=False)
                except ConnectionClosed:
                    raise
                except Exception as e:  # noqa: BLE001 - one bad frame must never end the session
                    log.exception("vision: message failed")
                    text = json.dumps(_error(None, f"internal error: {type(e).__name__}: {e}"))
                await ws.send(text)
        except ConnectionClosed:
            pass
        finally:
            log.info("vision client disconnected")

    # -- lifecycle --------------------------------------------------------
    async def start(self) -> None:
        """Listen even when vision is unavailable, so the GUI is told why instead of retrying forever."""
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="vision")
        try:
            self._server = await serve(
                self._handler,
                self.host,
                self.port,
                origins=self.origins,
                max_size=MAX_MESSAGE,
                compression=None,  # JPEG does not compress; deflate would only cost CPU
            )
        except OSError as e:
            # Not fatal: driving matters more than the camera helpers.
            self._pool.shutdown(wait=False)
            self._pool = None
            self.reason = f"cannot listen on port {self.port}: {e.strerror or e}"
            log.warning("vision: %s", self.reason)
            return
        self.port = self._server.sockets[0].getsockname()[1]
        self.listening = True

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()  # waits for a frame in flight (< 0.1 s typically)
            self._server = None
        self.listening = False
        if self._pool:
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._pool = None
