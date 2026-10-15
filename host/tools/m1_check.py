"""Mission 1 acceptance test from the terminal, no GUI: join Wi-Fi, GET, print the text.

    cd host
    .venv/bin/python -m tools.m1_check --ssid UR_Field --password 12345678 --url http://192.168.4.1/

Close the PlatformIO monitor and the bridge first (one program per serial port).
Exit code 0 only if the ESP32 itself fetched text.
"""

from __future__ import annotations

import argparse
import sys
import time

import serial

from bridge.serial_port import PortError, find_port
from tools.fw_check import Link


def wait_n(link: Link, pred, timeout: float, idx: int):
    return link.wait_for(lambda s: s.startswith("N ") and pred(s[2:]), timeout, idx)


def run(link: Link, ssid: str, password: str, url: str, timeout: float) -> bool:
    # Alive (the board may still be in its 4 s arming wait).
    idx = link.mark()
    t0 = time.monotonic()
    got = None
    while time.monotonic() - t0 < 8.0 and got is None:
        link.send("P", quiet=True)
        got = link.wait_for(lambda s: s == "PONG", 0.5, idx)
    if got is None:
        print("[FAIL] no PONG: right port? firmware flashed? monitor closed?")
        return False
    print("[PASS] ESP32 answers")

    link.stream = "S"  # keep the watchdog calm, like the GUI does while disarmed
    time.sleep(0.3)

    idx = link.mark()
    link.send(f"U {url}")
    if wait_n(link, lambda t: t.startswith("url set:"), 1.5, idx) is None:
        print("[FAIL] firmware did not confirm the URL (old firmware without Mission 1?)")
        return False
    print(f"[PASS] URL set: {url}")

    idx = link.mark()
    link.send(f"M {ssid} {password}")
    print(f"... joining {ssid!r} (up to {timeout:.0f} s)")
    end = time.monotonic() + timeout
    shown = idx
    connected = False
    while time.monotonic() < end and not connected:
        for _, line in link.since(shown):
            if line.startswith("N wifi:"):
                print("   ", line)
                if "connected" in line and "lost" not in line:
                    connected = True
                if "failed" in line or "timeout" in line:
                    print("[FAIL] could not join the network")
                    return False
        shown = link.mark()
        time.sleep(0.1)
    if not connected:
        print("[FAIL] no 'connected' within the time limit")
        return False
    print("[PASS] joined the network")

    idx = link.mark()
    link.send("G")
    # GET blocks the firmware for up to ~15 s in the worst case.
    end = time.monotonic() + 20
    lines: list[str] = []
    done = False
    while time.monotonic() < end and not done:
        for _, line in link.since(idx):
            if line.startswith("N http error"):
                print("   ", line)
                print("[FAIL] GET failed")
                return False
        lines = [l[len("N got: "):] for _, l in link.since(idx) if l.startswith("N got: ")]
        done = any(l.startswith("N http ") and "bytes" in l for _, l in link.since(idx)) and bool(lines)
        time.sleep(0.1)
    if not lines:
        print("[FAIL] no text received")
        return False
    print("[PASS] the ESP32 fetched the text:")
    for l in lines:
        print(f"    {l}")
    link.stream = None
    return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ssid", required=True)
    ap.add_argument("--password", default="")
    ap.add_argument("--url", required=True)
    ap.add_argument("--port", help="serial port (default: auto-detect)")
    ap.add_argument("--timeout", type=float, default=20.0, help="seconds to wait for Wi-Fi (default 20)")
    args = ap.parse_args(argv)
    try:
        port = find_port(args.port)
    except PortError as e:
        print(e)
        return 2
    print(f"Port: {port}")
    try:
        link = Link(port, verbose=False)
    except serial.SerialException as e:
        print(f"Cannot open {port}: {e}\nClose the PlatformIO monitor / bridge first.")
        return 2
    try:
        ok = run(link, args.ssid, args.password, args.url, args.timeout)
    finally:
        link.stream = None
        link.close()
    print("\nMISSION 1 OK" if ok else "\nMISSION 1 FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
