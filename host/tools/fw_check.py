"""Automated firmware acceptance test over the serial port.

Checks: alive (PONG), telemetry rate, hard clamp, per-output values,
readback self-check (each pin outputs its own signal), malformed lines
ignored, watchdog. SIGNAL-ONLY: run it with ESC power (XT60) unplugged.

    cd host
    .venv/bin/python -m tools.fw_check            # auto-detect the port
    .venv/bin/python -m tools.fw_check --port /dev/cu.usbmodemXXXX

Close the PlatformIO monitor first: only one program can hold the port.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time

import serial

from bridge.mock_esp32 import EscConfig
from bridge.serial_port import PortError, find_port

SEND_PERIOD_S = 0.05  # 20 Hz, like the GUI


class Link:
    """Serial port + reader thread collecting (timestamp, line) + 20 Hz sender."""

    def __init__(self, port: str, verbose: bool) -> None:
        self.ser = serial.Serial()
        self.ser.port = port
        self.ser.baudrate = 115200
        self.ser.timeout = 0.05
        # Deasserted DTR/RTS = do not reset the board on open (best effort).
        self.ser.dtr = False
        self.ser.rts = False
        self.ser.open()
        self.ser.reset_input_buffer()
        self.verbose = verbose
        self.lines: list[tuple[float, str]] = []
        self.lock = threading.Lock()
        self.stream: str | None = None  # line repeated at 20 Hz, None = silent
        self.last_stream_sent = 0.0
        self._stop = False
        self._threads = [
            threading.Thread(target=self._reader, daemon=True),
            threading.Thread(target=self._sender, daemon=True),
        ]
        for t in self._threads:
            t.start()

    def _reader(self) -> None:
        while not self._stop:
            try:
                raw = self.ser.readline()
            except (serial.SerialException, OSError):
                return
            if not raw:
                continue
            line = raw.decode("ascii", errors="replace").rstrip("\r\n")
            if self.verbose:
                print(f"   < {line}")
            with self.lock:
                self.lines.append((time.monotonic(), line))

    def _sender(self) -> None:
        while not self._stop:
            line = self.stream
            if line is not None:
                self.send(line, quiet=True)
                self.last_stream_sent = time.monotonic()
            time.sleep(SEND_PERIOD_S)

    def send(self, line: str, quiet: bool = False) -> None:
        if self.verbose and not quiet:
            print(f"   > {line[:60]}")
        self.ser.write((line + "\n").encode("ascii"))

    def mark(self) -> int:
        with self.lock:
            return len(self.lines)

    def since(self, idx: int) -> list[tuple[float, str]]:
        with self.lock:
            return self.lines[idx:]

    def wait_for(self, pred, timeout: float, idx: int) -> tuple[float, str] | None:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for item in self.since(idx):
                if pred(item[1]):
                    return item
            time.sleep(0.01)
        return None

    def close(self) -> None:
        self.stream = None
        self._stop = True
        time.sleep(0.1)
        self.ser.close()


def parse_t(line: str) -> tuple[int, int, int] | None:
    parts = line.split()
    if len(parts) != 4 or parts[0] != "T":
        return None
    try:
        return int(parts[1]), int(parts[2]), int(parts[3])
    except ValueError:
        return None


def t_lines(items: list[tuple[float, str]]) -> list[tuple[float, tuple[int, int, int]]]:
    out = []
    for ts, line in items:
        t = parse_t(line)
        if t:
            out.append((ts, t))
    return out


class Report:
    def __init__(self) -> None:
        self.results: list[tuple[bool, str]] = []

    def check(self, ok: bool, name: str, detail: str = "") -> bool:
        self.results.append((ok, name))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f": {detail}" if detail else ""))
        return ok

    def info(self, text: str) -> None:
        print(f"[INFO] {text}")


def hold(link: Link, line: str | None, seconds: float) -> int:
    """Stream `line` at 20 Hz for `seconds`; returns the line index at start."""
    link.stream = line
    idx = link.mark()
    time.sleep(seconds)
    return idx


def last_t(link: Link, idx: int) -> tuple[int, int, int] | None:
    ts = t_lines(link.since(idx))
    return ts[-1][1] if ts else None


def run(link: Link, rep: Report) -> None:
    # 1. Alive: ping until PONG (the board may be in its 4 s arming phase).
    idx = link.mark()
    t0 = time.monotonic()
    got = None
    while time.monotonic() - t0 < 8.0 and got is None:
        link.send("P", quiet=True)
        got = link.wait_for(lambda s: s == "PONG", 0.5, idx)
    if not rep.check(got is not None, "alive (P -> PONG)", "no PONG in 8 s" if got is None else ""):
        rep.info("Check: right port? baud 115200? firmware flashed? monitor closed?")
        return
    for _, line in link.since(0):
        if line.startswith("ROV "):
            rep.info(line)

    # Ping round trip.
    idx = link.mark()
    t_send = time.monotonic()
    link.send("P", quiet=True)
    got = link.wait_for(lambda s: s == "PONG", 1.0, idx)
    rtt_ms = (got[0] - t_send) * 1000 if got else None
    rep.check(got is not None and rtt_ms < 100, "ping round trip < 100 ms",
              f"{rtt_ms:.0f} ms" if rtt_ms is not None else "timeout")

    # 2. Telemetry at ~5 Hz, neutral under S.
    hold(link, "S", 0.5)
    idx = link.mark()
    time.sleep(1.0)
    ts = t_lines(link.since(idx))
    rep.check(3 <= len(ts) <= 7, "telemetry rate ~5 Hz", f"{len(ts)} T lines in 1 s")
    if not ts:
        return
    neutral = ts[-1][1]
    ok = neutral[0] == neutral[1] == neutral[2] and neutral[0] in (1500, 1000)
    rep.check(ok, "neutral under S", f"T {neutral}")
    if not ok:
        return
    esc = EscConfig(bidirectional=neutral[0] == 1500)

    # 3. Hard clamp: full command must be limited by the firmware.
    idx = hold(link, "D 1 -1 0", 0.8)
    t = last_t(link, idx)
    if t is None:
        rep.check(False, "clamp", "no telemetry")
        return
    max_delta = t[0] - esc.neutral_us
    esc.max_delta_us = max_delta
    expect = (esc.max_us, esc.min_us, esc.neutral_us)
    ok = 0 < max_delta <= 500 and t == expect
    rep.check(ok, "hard clamp (D 1 -1 0)", f"T {t}, clamp +/-{max_delta} us")
    if ok and max_delta > 150:
        rep.info(f"MAX_DELTA_US is {max_delta} us, above the 150 us default")

    # 4. Distinct value per output + readback self-check.
    vals = (0.1, -0.1, 0.2)
    expect = tuple(esc.value_to_us(v) for v in vals)
    idx = hold(link, "D {} {} {}".format(*vals), 0.8)
    t = last_t(link, idx)
    rep.check(t == expect, "each output gets its own value", f"T {t}, expected {expect}")

    idx = link.mark()
    link.send("R")
    got = link.wait_for(lambda s: s.startswith("R "), 1.0, idx)
    if got is None:
        rep.check(False, "readback report (R)", "no R line")
    else:
        rep.info(got[1])
        if "[DRY RUN]" in got[1]:
            rep.info("DRY RUN firmware: no pulses, readback check skipped (expected)")
        else:
            segs = got[1][2:].split(" | ")
            ok = len(segs) == 3 and all(s.endswith(" ok") for s in segs)
            rep.check(ok, "readback: every pin outputs its own signal")
            if not ok:
                rep.info("no signal -> jumper missing/wrong pin; MISMATCH -> wrong width, "
                         "e.g. two pins swapped or one pin driving two outputs")

    # 5. Malformed lines are ignored and do not refresh the watchdog.
    hold(link, "D 0.1 0.1 0.1", 0.6)
    good = esc.value_to_us(0.1)
    link.stream = None
    time.sleep(SEND_PERIOD_S * 1.5)  # let the sender thread go quiet
    t_last_valid = link.last_stream_sent
    idx = link.mark()
    bad = [
        "D 0.9 0.9", "D 0.9 0.9 0.9 0.9", "D 0.9 0.9 x", "D 2 0 0", "D nan 0 0",
        "d 0.9 0.9 0.9", "D 0.9 0.9 0.9 " + "0" * 200, "DD 0.9 0.9 0.9",
    ]
    for line in bad:
        link.send(line, quiet=True)
        time.sleep(0.03)
    w = link.wait_for(lambda s: s.startswith("W watchdog"), 1.2, idx)
    window = link.since(idx)
    before_wd = [t for ts, t in t_lines(window) if w is None or ts < w[0]]
    ok = bool(before_wd) and all(t == (good, good, good) for t in before_wd)
    rep.check(ok, "malformed lines ignored", f"T while sending garbage: {sorted(set(before_wd))}")
    rep.check(any(s.startswith("W ignored") for _, s in window), "malformed lines reported as W")

    # 6. Watchdog: neutral ~500 ms after the last valid line, garbage does not count.
    if w is None:
        rep.check(False, "watchdog fires", "no W watchdog line")
    else:
        dt = (w[0] - t_last_valid) * 1000
        rep.check(450 <= dt <= 900, "watchdog fires ~500 ms after last valid line", f"{dt:.0f} ms")
        after = link.wait_for(lambda s: parse_t(s) is not None, 0.6, link.mark())
        rep.check(after is not None and parse_t(after[1]) == neutral, "neutral after watchdog",
                  after[1] if after else "no T")

    # Leave the board neutral.
    hold(link, "S", 0.3)
    link.stream = None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="serial port (default: auto-detect)")
    ap.add_argument("--yes", action="store_true", help="skip the safety question")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every line")
    args = ap.parse_args(argv)

    if not args.yes:
        print("SIGNAL-ONLY TEST: commands up to the firmware clamp are sent.")
        print("Unplug ESC power (XT60) first, or flash with DRY_RUN = true.")
        if input("Type YES when ESC power is unplugged: ").strip() != "YES":
            print("Aborted.")
            return 2

    try:
        port = find_port(args.port)
    except PortError as e:
        print(e)
        return 2
    print(f"Port: {port}")
    try:
        link = Link(port, args.verbose)
    except serial.SerialException as e:
        print(f"Cannot open {port}: {e}")
        print("Is the PlatformIO monitor or the bridge still running? Close it first.")
        return 2

    rep = Report()
    try:
        run(link, rep)
    finally:
        link.close()
    failed = [name for ok, name in rep.results if not ok]
    print()
    print("ALL PASSED" if not failed else f"FAILED: {', '.join(failed)}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
