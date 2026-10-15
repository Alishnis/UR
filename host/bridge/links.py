"""Links between the bridge and the ESP32: a real serial port, or the mock.

Both give the bridge the same three things:
    start(loop)      begin work; lines arrive through on_line(line)
    write_line(line) queue one text line for the ESP32 (no newline needed)
    stop()           send S, then close

Status changes ("serial /dev/cu.x connected", "serial lost: ...") go through
on_status(text) and are shown to browsers as `B ...` lines.
"""

from __future__ import annotations

import asyncio
import queue
import threading
import time
from typing import Callable

import serial

from bridge.mock_esp32 import MockEsp32
from bridge.serial_port import PortError, find_port, is_native_usb

LineCb = Callable[[str], None]
StatusCb = Callable[[str], None]

BAUD = 115200
MAX_RX_LINE = 400  # a line longer than this without '\n' is flushed as-is (boot garbage)
RECONNECT_S = 1.0


def decode_line(raw: bytes) -> str:
    """ESP32 ROM boot output can contain non-ASCII bytes: show them as '?'."""
    return "".join(chr(b) if 0x20 <= b <= 0x7E or b == 0x09 else "?" for b in raw if b != 0x0D)


class RealSerialLink:
    kind = "serial"

    def __init__(self, on_line: LineCb, on_status: StatusCb, port: str | None = None) -> None:
        self._on_line = on_line
        self._on_status = on_status
        self._explicit_port = port
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tx: queue.Queue[str] = queue.Queue(maxsize=200)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_wait_msg = ""
        self._native_warning = ""
        self.connected = False

    # -- thread-safe callbacks into the asyncio loop ----------------------
    def _line(self, line: str) -> None:
        assert self._loop is not None
        self._loop.call_soon_threadsafe(self._on_line, line)

    def _status(self, text: str) -> None:
        assert self._loop is not None
        self._loop.call_soon_threadsafe(self._on_status, text)

    # -- API ------------------------------------------------------------
    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._thread = threading.Thread(target=self._run, name="serial-io", daemon=True)
        self._thread.start()

    def write_line(self, line: str) -> None:
        if not self.connected:
            return  # nothing to send to; never queue stale commands
        try:
            self._tx.put_nowait(line)
        except queue.Full:
            pass  # wedged port: drop, the firmware watchdog covers us

    def stop(self) -> None:
        if self.connected:
            self.write_line("S")
            deadline = time.monotonic() + 0.5
            while not self._tx.empty() and time.monotonic() < deadline:
                time.sleep(0.01)
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.5)

    # -- io thread ------------------------------------------------------
    def _open(self) -> serial.Serial | None:
        try:
            port = find_port(self._explicit_port)
        except PortError as e:
            msg = str(e).splitlines()[0]
            if msg != self._last_wait_msg:  # tell the browser once, not every second
                self._last_wait_msg = msg
                self._status(f"serial waiting: {msg}")
            return None
        ser = serial.Serial()
        ser.port = port
        ser.baudrate = BAUD
        ser.timeout = 0.01
        ser.write_timeout = 0.2
        ser.dtr = False  # do not reset the board when opening (best effort)
        ser.rts = False
        try:
            ser.open()
        except (serial.SerialException, OSError) as e:
            msg = f"cannot open {port}: {e}"
            if msg != self._last_wait_msg:
                self._last_wait_msg = msg
                self._status(f"serial waiting: {msg} (close the PlatformIO monitor?)")
            return None
        self._last_wait_msg = ""
        self._native_warning = (
            " (NATIVE USB port: the firmware talks on the COM/UART port, expect no data)"
            if is_native_usb(port) else ""
        )
        return ser

    def _run(self) -> None:
        while not self._stop.is_set():
            ser = self._open()
            if ser is None:
                self._stop.wait(RECONNECT_S)
                continue
            self.connected = True
            self._status(f"serial {ser.port} connected{self._native_warning}")
            reason = ""
            try:
                self._serve(ser)
            except (serial.SerialException, OSError) as e:
                reason = str(e) or e.__class__.__name__
            finally:
                self.connected = False
                try:
                    ser.close()
                except Exception:
                    pass
            while not self._tx.empty():  # stale commands must not reach a rebooted board
                try:
                    self._tx.get_nowait()
                except queue.Empty:
                    break
            if not self._stop.is_set():
                self._status(f"serial lost: {reason or 'closed'}")
                self._stop.wait(RECONNECT_S)

    def _serve(self, ser: serial.Serial) -> None:
        buf = bytearray()
        ser.reset_input_buffer()
        while not self._stop.is_set():
            chunk = ser.read(ser.in_waiting or 1)
            for b in chunk:
                if b == 0x0A:
                    line = decode_line(bytes(buf))
                    buf.clear()
                    if line:
                        self._line(line)
                else:
                    buf.append(b)
                    if len(buf) > MAX_RX_LINE:
                        self._line(decode_line(bytes(buf)))
                        buf.clear()
            while True:
                try:
                    line = self._tx.get_nowait()
                except queue.Empty:
                    break
                ser.write((line + "\n").encode("ascii"))


class MockLink:
    """The bridge's --mock mode: an in-process fake ESP32, no hardware."""

    kind = "mock"

    def __init__(self, on_line: LineCb, on_status: StatusCb, arm_ms: int = 4000,
                 dry_run: bool = False) -> None:
        self._on_line = on_line
        self._on_status = on_status
        self._arm_ms = arm_ms
        self._dry_run = dry_run
        self._task: asyncio.Task | None = None
        self.mock: MockEsp32 | None = None
        self.connected = True

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.mock = MockEsp32(emit=self._on_line, arm_ms=self._arm_ms, dry_run=self._dry_run)
        self._on_status("mock ESP32 (no hardware)")
        self._task = loop.create_task(self._tick())

    async def _tick(self) -> None:
        assert self.mock is not None
        while True:
            self.mock.tick()
            await asyncio.sleep(0.005)

    def write_line(self, line: str) -> None:
        if self.mock is not None:
            self.mock.feed((line + "\n").encode("ascii"))

    def stop(self) -> None:
        self.write_line("S")
        if self._task:
            self._task.cancel()
