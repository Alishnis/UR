"""Fake ESP32 that follows docs/PROTOCOL.md: a Python twin of src/main.cpp.

Used by the bridge (--mock), by pytest, and standalone on a pseudo-terminal:

    python -m bridge.mock_esp32 --pty          # prints a /dev/ttys... path
    python -m tools.fw_check --port /dev/ttysNNN --yes

Keep the rules here identical to src/protocol.h and src/main.cpp.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import select
import struct
import sys
import time
import tty
from dataclasses import dataclass, field
from typing import Callable

from bridge.mock_mission1 import HttpGet, MockMission1

FW_VERSION = "0.1.0-mock"
NUM_ESC = 3
ESC_PINS = (1, 40, 42)
READBACK_PINS = (4, 6, 5)
NEUTRAL_TRIM_US = (0, -22, 0)  # src/config.h: added to the real pulse only, T stays untrimmed
ESC_NAMES = ("left", "right", "vert")

ARM_MS = 4000
WATCHDOG_MS = 500
TELEMETRY_MS = 200
READBACK_STREAM_MS = 500
BAD_LINE_WARN_MS = 1000
MAX_LINE = 160
MAX_SSID_LEN = 32
MAX_PASSWORD_LEN = 63

_NUMBER = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)")
_WS = re.compile(r"[ \t]+")


def _f32(x: float) -> float:
    """Round to IEEE float32, like the firmware's `float`."""
    return struct.unpack("f", struct.pack("f", x))[0]


def _lround(x: float) -> int:
    """C lroundf: halves round away from zero (Python round() does not)."""
    return int(math.floor(x + 0.5)) if x >= 0 else -int(math.floor(-x + 0.5))


@dataclass
class Command:
    type: str  # empty, invalid, drive, stop, ping, report, wifi, url, get
    values: tuple[float, float, float] = (0.0, 0.0, 0.0)
    report: int = -1  # -1 once, 1 stream on, 0 stream off
    ssid: str = ""
    password: str = ""
    url: str = ""


INVALID = Command("invalid")


def _parse_number(tok: str) -> float | None:
    if not _NUMBER.fullmatch(tok):
        return None
    try:
        v = _f32(float(tok))
    except OverflowError:  # strtof -> inf -> rejected
        return None
    if not math.isfinite(v):
        return None
    return v


def parse_line(line: str) -> Command:
    """Mirror of proto::parseLine(). `line` holds printable ASCII/tabs only."""
    s = line.strip(" \t")
    if not s:
        return Command("empty")
    if len(s) > MAX_LINE:
        return INVALID
    letter = s[0]
    if len(s) > 1 and s[1] not in " \t":
        return INVALID
    rest = s[1:].lstrip(" \t")

    if letter == "D":
        toks = _WS.split(rest) if rest else []
        if len(toks) != NUM_ESC:
            return INVALID
        vals = []
        for t in toks:
            v = _parse_number(t)
            if v is None or v < -1.0 or v > 1.0:
                return INVALID
            vals.append(v)
        return Command("drive", values=tuple(vals))
    if letter in "SPGL":
        if rest:
            return INVALID
        return Command({"S": "stop", "P": "ping", "G": "get", "L": "scan"}[letter])
    if letter == "R":
        modes = {"": -1, "1": 1, "0": 0}
        if rest not in modes:
            return INVALID
        return Command("report", report=modes[rest])
    if letter == "M":
        parts = _WS.split(rest, maxsplit=1) if rest else []
        if not parts or not (1 <= len(parts[0]) <= MAX_SSID_LEN):
            return INVALID
        password = parts[1] if len(parts) > 1 else ""
        if len(password) > MAX_PASSWORD_LEN:
            return INVALID
        return Command("wifi", ssid=parts[0], password=password)
    if letter == "U":
        if not rest or _WS.search(rest):
            return INVALID
        if not (rest.startswith("http://") or rest.startswith("https://")):
            return INVALID
        return Command("url", url=rest)
    return INVALID


@dataclass
class EscConfig:
    bidirectional: bool = True
    max_delta_us: int = 150

    @property
    def neutral_us(self) -> int:
        return 1500 if self.bidirectional else 1000

    @property
    def us_per_unit(self) -> int:
        return 500 if self.bidirectional else 1000

    @property
    def min_us(self) -> int:
        return self.neutral_us - self.max_delta_us if self.bidirectional else self.neutral_us

    @property
    def max_us(self) -> int:
        return self.neutral_us + self.max_delta_us

    def clamp_us(self, us: int) -> int:
        return max(self.min_us, min(self.max_us, us))

    def value_to_us(self, v: float) -> int:
        """Mirror of proto::valueToUs() (float32 math, lroundf)."""
        if not (-1.0 <= v <= 1.0):  # also NaN
            v = 0.0
        if not self.bidirectional and v < 0.0:
            v = 0.0
        return self.clamp_us(self.neutral_us + _lround(_f32(_f32(v) * self.us_per_unit)))


@dataclass
class MockEsp32:
    """Feed bytes in with feed(), call tick() often; output lines go to emit()."""

    emit: Callable[[str], None]
    dry_run: bool = False
    arm_ms: int = ARM_MS
    readback_wired: bool = True
    esc: EscConfig = field(default_factory=EscConfig)
    clock: Callable[[], float] = time.monotonic
    # Mission 1 simulation: known Wi-Fi networks (ssid -> password), time to connect, HTTP backend.
    networks: dict[str, str] | None = None
    connect_delay_ms: int = 800
    http_get: HttpGet | None = None

    def __post_init__(self) -> None:
        self.us = [self.esc.neutral_us] * NUM_ESC
        self.armed = False
        self.boot_ms = self._now()
        self.last_cmd_ms = 0
        self.wd_tripped = True
        self.last_telemetry_ms = self.boot_ms - TELEMETRY_MS  # first T right away
        self.rb_stream = False
        self.last_rb_ms = 0
        self.bad_warned = False
        self.last_bad_warn_ms = 0
        self._buf = bytearray()
        self._overflow = False
        self._bad_char = False
        self._discard = False
        self._mid_line = False
        self._flushed = False
        self.m1 = MockMission1(
            emit=self._out,
            stop_thrusters=self._all_neutral,
            after_get=self._after_get,
            networks=self.networks,
            connect_delay_ms=self.connect_delay_ms,
            http_get=self.http_get,
        )
        self._banner()

    # -- helpers ---------------------------------------------------------
    def _now(self) -> int:
        return round(self.clock() * 1000)

    def _out(self, line: str) -> None:
        self.emit(line)

    def _banner(self) -> None:
        e = self.esc
        self._out("")
        self._out(f"ROV firmware {FW_VERSION}")
        self._out("ROV reset reason: power-on")
        self._out("ROV mode: " + ("DRY RUN (ESC pins held LOW, no pulses)" if self.dry_run else "LIVE"))
        pins = " ".join(f"{n}=io{p}" for n, p in zip(ESC_NAMES, ESC_PINS))
        rb = " ".join(f"io{p}" for p in READBACK_PINS)
        self._out(f"ROV ESC pins: {pins} | readback: {rb}")
        kind = "bidirectional" if e.bidirectional else "forward-only"
        self._out(
            f"ROV ESC: {kind}, neutral {e.neutral_us} us, clamp {e.min_us}..{e.max_us} us, "
            "50 Hz, 14-bit LEDC"
        )
        trims = ", ".join(f"{n} {t:+d}" for n, t in zip(ESC_NAMES, NEUTRAL_TRIM_US))
        self._out(f"ROV ESC neutral trim: {trims} us")
        self._out(f"ROV watchdog {WATCHDOG_MS} ms, arming: neutral for {self.arm_ms} ms, input ignored")

    def _all_neutral(self) -> None:
        self.us = [self.esc.neutral_us] * NUM_ESC

    def _refresh(self, now: int) -> None:
        self.last_cmd_ms = now
        self.wd_tripped = False

    def _warn_bad(self, now: int, what: str, line: str | None) -> None:
        if self.bad_warned and now - self.last_bad_warn_ms < BAD_LINE_WARN_MS:
            return
        self.bad_warned = True
        self.last_bad_warn_ms = now
        if line is None:
            self._out(f"W ignored {what}")
        else:
            more = "..." if len(line) > 40 else ""
            self._out(f'W ignored {what}: "{line[:40]}{more}"')

    def readback_report(self) -> str:
        parts = []
        for i in range(NUM_ESC):
            head = f"{ESC_NAMES[i]} io{ESC_PINS[i]}->io{READBACK_PINS[i]}: "
            out = self.us[i] + NEUTRAL_TRIM_US[i]  # what is really on the pin, like outUs() in main.cpp
            if self.dry_run or not self.readback_wired:
                parts.append(head + f"no signal (LOW) sent {out}")
            else:
                parts.append(head + f"{out}us 50Hz sent {out} ok")
        return "R " + ("[DRY RUN] " if self.dry_run else "") + " | ".join(parts)

    # -- protocol --------------------------------------------------------
    def handle_line(self, line: str, now: int) -> None:
        cmd = parse_line(line)
        t = cmd.type
        if t == "empty":
            return
        if t == "invalid":
            self._warn_bad(now, "malformed line", line)
        elif t == "drive":
            self.us = [self.esc.value_to_us(v) for v in cmd.values]
            self._refresh(now)
        elif t == "stop":
            self._all_neutral()
            self._refresh(now)
        elif t == "ping":
            self._out("PONG")
            self._refresh(now)
        elif t == "report":
            if cmd.report == 0:
                self.rb_stream = False
                return
            self.rb_stream = cmd.report == 1
            self.last_rb_ms = now
            self._out(self.readback_report())
        elif t == "wifi":
            self.m1.connect(cmd.ssid, cmd.password, now)
        elif t == "url":
            self.m1.set_url(cmd.url)
        elif t == "get":
            self.m1.get(now)
        elif t == "scan":
            self.m1.scan(now)

    def _after_get(self) -> None:
        """Like afterBlockingGet() in main.cpp: input queued during the GET is stale."""
        self._flushed = True
        if not self.wd_tripped:
            self.last_cmd_ms = self._now()

    def feed(self, data: bytes) -> None:
        now = self._now()
        for pos, c in enumerate(data):
            if not self.armed:
                self._mid_line = c != 0x0A
                continue
            if c == 0x0D:
                continue
            if c == 0x0A:
                if self._discard:
                    pass
                elif self._overflow:
                    self._warn_bad(now, "overlong line", None)
                elif self._bad_char:
                    self._warn_bad(now, "line with non-printable bytes", None)
                else:
                    self.handle_line(self._buf.decode("ascii"), now)
                self._buf.clear()
                self._overflow = self._bad_char = self._discard = False
                if self._flushed:  # a GET just ran: input that arrived meanwhile is stale
                    self._flushed = False
                    if pos + 1 < len(data):  # something was queued: also drop a possibly cut line
                        self._discard = True
                    return
                continue
            if self._discard or self._overflow:
                continue
            if len(self._buf) >= MAX_LINE:
                self._overflow = True
                continue
            if not (0x20 <= c <= 0x7E or c == 0x09):
                self._bad_char = True
                c = 0x3F  # keep the buffer decodable; line is dropped anyway
            self._buf.append(c)

    def tick(self) -> None:
        now = self._now()
        if not self.armed and now - self.boot_ms >= self.arm_ms:
            self.armed = True
            self._discard = self._mid_line
            self._refresh(now)
            self.wd_tripped = True
            self._out("ROV ready, accepting commands")
        if self.armed and not self.wd_tripped and now - self.last_cmd_ms > WATCHDOG_MS:
            self._all_neutral()
            self.wd_tripped = True
            self._out(f"W watchdog: no command for {WATCHDOG_MS} ms, thrusters neutral")
        if now - self.last_telemetry_ms >= TELEMETRY_MS:
            self.last_telemetry_ms = now
            self._out("T {} {} {}".format(*self.us))
        self.m1.poll(now)
        if self.rb_stream and now - self.last_rb_ms >= READBACK_STREAM_MS:
            self.last_rb_ms = now
            self._out(self.readback_report())


def run_pty(mock_kwargs: dict) -> None:
    """Serve the mock on a pseudo-terminal so serial tools can open it."""
    master, slave = os.openpty()
    tty.setraw(slave)
    os.set_blocking(master, False)
    print(f"mock ESP32 on {os.ttyname(slave)}  (Ctrl+C to stop)", flush=True)

    def emit(line: str) -> None:
        try:
            os.write(master, (line + "\n").encode("ascii"))
        except BlockingIOError:
            pass  # nobody reading: drop, like a UART with no listener

    mock = MockEsp32(emit=emit, **mock_kwargs)
    try:
        while True:
            r, _, _ = select.select([master], [], [], 0.005)
            if r:
                try:
                    data = os.read(master, 4096)
                except (BlockingIOError, OSError):
                    data = b""
                if data:
                    mock.feed(data)
            mock.tick()
    except KeyboardInterrupt:
        pass
    finally:
        os.close(master)
        os.close(slave)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pty", action="store_true", help="serve on a pseudo-terminal")
    ap.add_argument("--dry-run", action="store_true", help="behave like DRY_RUN firmware")
    ap.add_argument("--arm-ms", type=int, default=ARM_MS)
    ap.add_argument("--no-readback", action="store_true", help="simulate open jumpers")
    args = ap.parse_args(argv)
    if not args.pty:
        ap.error("only --pty mode is available standalone (the bridge embeds the mock itself)")
    run_pty({"dry_run": args.dry_run, "arm_ms": args.arm_ms, "readback_wired": not args.no_readback})
    return 0


if __name__ == "__main__":
    sys.exit(main())
