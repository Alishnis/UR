"""Browser GUI backend. Run from host/:

    python -m bridge --mock          # no hardware: a fake ESP32 (docs/PROTOCOL.md)
    python -m bridge                 # real ESP32, serial port found automatically
    python -m bridge --port /dev/cu.usbmodem5C834087141

then open http://localhost:8000. Close the bridge before uploading firmware (it holds the serial port).

Three servers on localhost:
  HTTP   :8000  the GUI files (host/webgui) and the test tags (host/tags)
  WS     :8765  control: every text line from the browser goes to the serial port, every serial line to the browser
  WS     :8766  vision: JPEG frames in, Mission 2.1 AprilTag results out (bridge/vision_session.py)
"""
import argparse
import asyncio
import concurrent.futures
import functools
import json
import logging
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import serial
import serial.tools.list_ports
import websockets

from bridge import config
from bridge.mock_serial import MockSerial

HOST_DIR = Path(__file__).resolve().parent.parent
WEBGUI_DIR = HOST_DIR / "webgui"
TAGS_DIR = HOST_DIR / "tags"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("bridge")


def find_port() -> str | None:
    for p in serial.tools.list_ports.comports():
        if any(pattern in p.device for pattern in config.PORT_PATTERNS):
            return p.device
    return None


# ---------------------------------------------------------------- serial side

class SerialLink:
    """Owns the serial port. A thread does blocking reads and hands lines to the event loop, which broadcasts
    them to every browser. Writes go straight to pyserial under a lock so two clients never interleave bytes."""

    def __init__(self, port: str | None, baud: int, mock: bool, verbose: bool):
        self.port, self.baud, self.mock, self.verbose = port, baud, mock, verbose
        self.ser = None
        self.clients: set = set()
        self.queue: asyncio.Queue[bytes] = asyncio.Queue()
        self.write_lock = asyncio.Lock()
        self._running = False

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        if self.mock:
            self.ser = MockSerial(self.baud)
            log.info("serial: MOCK ESP32 (no hardware)")
        else:
            port = self.port if self.port not in (None, "auto") else find_port()
            if port is None:
                log.error("no USB serial port found. Plugged in? Ports seen:")
                for p in serial.tools.list_ports.comports():
                    log.error(f"  {p.device}  ({p.description})")
                raise SystemExit("start with --mock to test without hardware, or --port <name>")
            try:
                # exclusive: a serial monitor opened next to the bridge would silently steal half of the lines
                self.ser = serial.Serial(port, self.baud, timeout=1.0, exclusive=True)
            except serial.SerialException as e:
                raise SystemExit(f"could not open {port}: {e}\n"
                                 "Close the PlatformIO serial monitor / stop an upload first - the bridge needs the "
                                 "port for itself.")
            log.info(f"serial open: {port} @ {self.baud}")
        self._running = True
        threading.Thread(target=self._read_loop, daemon=True, name="serial-reader").start()
        loop.create_task(self._broadcast_loop())

    def _read_loop(self) -> None:
        while self._running:
            try:
                line = self.ser.readline()
            except Exception as e:  # unplugged
                log.error(f"serial read error: {e}")
                self.loop.call_soon_threadsafe(self.queue.put_nowait, b"W bridge: serial port lost\n")
                break
            if line:
                self.loop.call_soon_threadsafe(self.queue.put_nowait, line)

    async def _broadcast_loop(self) -> None:
        while True:
            text = (await self.queue.get()).decode(errors="replace")
            if self.verbose or not text.startswith("T "):
                log.info(f"ESP -> PC  {text.rstrip()}")
            if self.clients:
                await asyncio.gather(*(c.send(text) for c in list(self.clients)), return_exceptions=True)

    async def write(self, text: str) -> None:
        if self.ser is None or not self.ser.is_open:
            return
        if self.verbose or not text.startswith(("D ", "S")):
            log.info(f"PC  -> ESP {text.rstrip()}")
        async with self.write_lock:
            try:
                self.ser.write(text.encode())
            except Exception as e:
                log.error(f"serial write error: {e}")

    def stop(self) -> None:
        self._running = False
        if self.ser is not None and self.ser.is_open:
            try:
                self.ser.write(b"S\n")  # leave the thrusters neutral
            except Exception:
                pass
            self.ser.close()
            log.info("serial closed")


async def control_handler(link: SerialLink, websocket) -> None:
    peer = websocket.remote_address
    log.info(f"control client connected: {peer}")
    link.clients.add(websocket)
    try:
        async for message in websocket:
            text = message.decode(errors="replace") if isinstance(message, bytes) else message
            if not text.endswith("\n"):
                text += "\n"
            await link.write(text)
    except websockets.ConnectionClosed:
        pass
    finally:
        link.clients.discard(websocket)
        log.info(f"control client disconnected: {peer}")
        if not link.clients:
            await link.write("S\n")  # browser closed or crashed: stop now, do not wait for the watchdog


# ---------------------------------------------------------------- vision side

async def vision_handler(session, executor, websocket) -> None:
    loop = asyncio.get_running_loop()
    log.info("vision client connected")
    try:
        await websocket.send(json.dumps(session.command({})))  # current state (tags survive a page reload)
        async for message in websocket:
            if isinstance(message, bytes):
                reply = await loop.run_in_executor(executor, session.handle_frame, message, time.monotonic())
            else:
                try:
                    reply = session.command(json.loads(message))
                except (ValueError, KeyError) as e:
                    reply = {"type": "error", "text": f"bad command: {e}"}
            await websocket.send(json.dumps(reply))
    except websockets.ConnectionClosed:
        pass
    finally:
        log.info("vision client disconnected")


# ---------------------------------------------------------------- static files

class GuiHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEBGUI_DIR), **kwargs)

    def translate_path(self, path):
        if path.startswith("/tags/"):  # test tags for the "test image" camera source
            return str(TAGS_DIR / Path(path.split("?")[0]).name)
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # edits show up on reload
        super().end_headers()

    def log_message(self, *args):
        pass


def start_http(args) -> None:
    server = ThreadingHTTPServer((config.HOST, args.http_port), GuiHandler)
    threading.Thread(target=server.serve_forever, daemon=True, name="http").start()
    url = f"http://{config.HOST}:{args.http_port}"
    if (args.ws_port, args.vision_port) != (config.WS_PORT, config.VISION_PORT):
        url += f"/?ws={args.ws_port}&vision={args.vision_port}"  # the page reads its ports from here
    log.info(f"GUI: open {url}")


# ---------------------------------------------------------------- main

async def run(args) -> None:
    loop = asyncio.get_running_loop()
    link = SerialLink(args.port, args.baud, args.mock, args.verbose)
    link.start(loop)
    try:
        servers = [await websockets.serve(functools.partial(control_handler, link), config.HOST, args.ws_port)]
    except OSError as e:
        raise SystemExit(f"{e}\nport {args.ws_port} is busy - another bridge still running? Stop it, or use "
                         "--ws-port / --vision-port / --http-port")
    log.info(f"control websocket on ws://{config.HOST}:{args.ws_port}")
    if not args.no_vision:
        from bridge.vision_session import TagSession  # OpenCV + pupil-apriltags only when needed
        session = TagSession(args.expected, config.CONFIRM_FRAMES)
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        servers.append(await websockets.serve(functools.partial(vision_handler, session, executor),
                                              config.HOST, args.vision_port, max_size=16 * 1024 * 1024))
        log.info(f"vision websocket on ws://{config.HOST}:{args.vision_port}")
    start_http(args)
    try:
        await asyncio.Future()
    finally:
        link.stop()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mock", action="store_true", help="fake ESP32, no hardware needed")
    ap.add_argument("--port", default=config.SERIAL_PORT, help="serial port, or 'auto'")
    ap.add_argument("--baud", type=int, default=config.SERIAL_BAUD)
    ap.add_argument("--http-port", type=int, default=config.HTTP_PORT)
    ap.add_argument("--ws-port", type=int, default=config.WS_PORT)
    ap.add_argument("--vision-port", type=int, default=config.VISION_PORT)
    ap.add_argument("--expected", type=int, default=config.EXPECTED_TAGS, help="number of tags in Mission 2.1")
    ap.add_argument("--no-vision", action="store_true", help="control only (no OpenCV needed)")
    ap.add_argument("--verbose", action="store_true", help="log every line, including the 20 Hz D / S / T lines")
    args = ap.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        log.info("shutting down")


if __name__ == "__main__":
    main()
