"""Tiny USB check: does the ESP32 show up and send anything?

    .venv/bin/python -m tools.port_probe [--port /dev/cu.usbmodemXXXX]

Close the bridge and the PlatformIO monitor first.
"""
import argparse
import glob
import time

import serial
from serial.tools import list_ports


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port")
    ap.add_argument("--seconds", type=float, default=5)
    args = ap.parse_args()

    print("USB devices seen by macOS:")
    for p in list_ports.comports():
        print(f"  {p.device}  vid:pid={p.vid and f'{p.vid:04x}'}:{p.pid and f'{p.pid:04x}'}  {p.description}")
    cands = glob.glob("/dev/cu.usb*") + glob.glob("/dev/cu.wchusb*")
    print("candidate ports:", cands or "NONE (cable/data lines problem, or power-only cable)")

    port = args.port or (cands[0] if cands else None)
    if not port:
        return
    print(f"\nlistening on {port} for {args.seconds}s ...")
    with serial.Serial(port, 115200, timeout=0.2) as s:
        s.write(b"\n")
        end, n = time.time() + args.seconds, 0
        while time.time() < end:
            line = s.readline()
            if line:
                n += 1
                print("  RX:", line.decode(errors="replace").rstrip())
    print(f"\n{n} lines received:", "OK, signal is coming through" if n else "NOTHING received")


if __name__ == "__main__":
    main()
