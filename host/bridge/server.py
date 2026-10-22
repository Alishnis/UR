"""The bridge: GUI files over HTTP + text lines between browser and ESP32.

    browser <--WebSocket :8765--> bridge <--USB serial--> ESP32
    browser <--WebSocket :8766--> bridge vision service (camera frames, display-only)

Lines are forwarded unchanged in both directions, with three safety rules:
- only commands the GUI is allowed to send (D S P M U G R L) reach the ESP32,
  and only as single clean lines (no embedded newlines, printable ASCII, <=160);
- when the last browser disconnects, S is sent at once;
- WebSocket connections from other web pages are refused (Origin check), so
  no website can drive the motors through localhost.

The bridge adds its own status lines for browsers, prefixed `B ` (never sent to
the ESP32). See docs/PROTOCOL.md.

The vision service (bridge/vision_service.py) has its own WebSocket with the same
Origin rule. It never talks to the ESP32; if OpenCV is missing or its port is
taken, the bridge still drives the ROV and the GUI shows vision as unavailable.
"""

from __future__ import annotations

import asyncio
import functools
import http.server
import logging
import threading
from pathlib import Path
from websockets.asyncio.server import ServerConnection, broadcast, serve
from websockets.exceptions import ConnectionClosed

from bridge.links import MockLink, RealSerialLink
from bridge.vision_service import VisionService

log = logging.getLogger("bridge")

MAX_LINE = 160
BROWSER_COMMANDS = "DSPMUGRL"
WEBGUI_DIR = Path(__file__).resolve().parents[1] / "webgui"


def validate_browser_line(msg: object) -> str | None:
    """Return None if the browser's message may go to the ESP32, else the reason."""
    if not isinstance(msg, str):
        return "binary frames are not accepted"
    if "\n" in msg or "\r" in msg:
        return "one line per message"
    if len(msg) > MAX_LINE:
        return f"line longer than {MAX_LINE} characters"
    if any(not (0x20 <= ord(c) <= 0x7E or c == "\t") for c in msg):
        return "non-printable characters"
    s = msg.strip(" \t")
    if not s:
        return "empty line"
    if s[0] not in BROWSER_COMMANDS:
        return f"command {s[0]!r} is not allowed from the browser"
    return None


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Static files, never cached (we edit config.js at the pool and reload)."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # keep the console readable
        pass


class Bridge:
    def __init__(
        self,
        *,
        mock: bool = False,
        serial_port: str | None = None,
        host: str = "127.0.0.1",
        http_port: int = 8000,
        ws_port: int = 8765,
        mock_arm_ms: int = 4000,
        mock_dry_run: bool = False,
        webgui_dir: Path = WEBGUI_DIR,
        vision: bool = True,
        vision_port: int = 8766,
    ) -> None:
        self.host = host
        self.http_port = http_port
        self.ws_port = ws_port
        self.webgui_dir = webgui_dir
        self.clients: set[ServerConnection] = set()
        self.status = ""
        self._http: http.server.ThreadingHTTPServer | None = None
        self._ws_server = None
        self.vision_enabled = vision
        self.vision_port = vision_port
        self.vision: VisionService | None = None  # created in start(), once the HTTP port is known
        if mock:
            self.link: MockLink | RealSerialLink = MockLink(
                self._on_line, self._on_status, arm_ms=mock_arm_ms, dry_run=mock_dry_run
            )
        else:
            self.link = RealSerialLink(self._on_line, self._on_status, port=serial_port)

    # -- from the ESP32 -------------------------------------------------
    def _on_line(self, line: str) -> None:
        broadcast(self.clients, line)

    def _on_status(self, text: str) -> None:
        self.status = text
        log.info(text)
        broadcast(self.clients, f"B {text}")

    # -- from browsers --------------------------------------------------
    async def _handler(self, ws: ServerConnection) -> None:
        self.clients.add(ws)
        log.info("browser connected (%d)", len(self.clients))
        try:
            await ws.send(f"B bridge {self.link.kind}")
            if self.status:
                await ws.send(f"B {self.status}")
            async for msg in ws:
                reason = validate_browser_line(msg)
                if reason:
                    log.warning("dropped browser line: %s", reason)
                    await ws.send(f"B rejected: {reason}")
                    continue
                self.link.write_line(msg.strip(" \t"))
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)
            log.info("browser disconnected (%d left)", len(self.clients))
            if not self.clients:
                self.link.write_line("S")  # do not wait for the firmware watchdog

    # -- lifecycle ------------------------------------------------------
    def allowed_origins(self) -> list[str | None]:
        origins: list[str | None] = [None]  # non-browser clients (tests, scripts) send no Origin
        for h in ("localhost", "127.0.0.1", "[::1]"):
            origins.append(f"http://{h}:{self.http_port}")
        return origins

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        handler = functools.partial(QuietHandler, directory=str(self.webgui_dir))
        self._http = http.server.ThreadingHTTPServer((self.host, self.http_port), handler)
        self.http_port = self._http.server_address[1]
        threading.Thread(target=self._http.serve_forever, name="http", daemon=True).start()

        self._ws_server = await serve(
            self._handler,
            self.host,
            self.ws_port,
            origins=self.allowed_origins(),
            max_size=1024,
            compression=None,
        )
        self.ws_port = self._ws_server.sockets[0].getsockname()[1]
        self.link.start(loop)

        if self.vision_enabled:
            self.vision = VisionService(self.host, self.vision_port, self.allowed_origins())
            await self.vision.start()  # never raises for a busy port: see vision_status()
            if self.vision.listening:
                self.vision_port = self.vision.port

    def vision_status(self) -> str:
        """One line for the console: the vision URL, `off`, or `UNAVAILABLE: <reason>`."""
        if not self.vision_enabled:
            return "off"
        if self.vision is None:
            return "not started"
        return self.vision.describe()

    async def stop(self) -> None:
        self.link.stop()  # sends S first
        if self.vision:
            await self.vision.stop()
        if self._ws_server:
            self._ws_server.close()
            await self._ws_server.wait_closed()
        if self._http:
            self._http.shutdown()
            self._http.server_close()
