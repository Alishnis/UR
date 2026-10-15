"""Spin ONE thruster briefly at low throttle (first power-on test, before the GUI).

    cd host
    .venv/bin/python -m tools.spin_test --output 0            # io1  (left)
    .venv/bin/python -m tools.spin_test --output 1 --value 0.12 --seconds 3

Safety built in:
- one output at a time, the others stay at neutral;
- |value| is limited to 0.30 and the firmware clamp (+/-150 us) still applies;
- ramps up and down slowly, never jumps;
- refuses to run on DRY RUN firmware;
- if this script dies or the cable is pulled, the firmware watchdog stops the
  motors after 500 ms; Ctrl+C sends S immediately.
Read docs/HARDWARE_QUESTIONS.md (Q1) before the first run.
"""

from __future__ import annotations

import argparse
import sys
import time

import serial

from bridge.mock_esp32 import EscConfig, ESC_NAMES, ESC_PINS
from bridge.serial_port import PortError, find_port
from tools.fw_check import Link, last_t, parse_t

MAX_VALUE = 0.30
RAMP_S = 1.0
PERIOD_S = 0.05  # 20 Hz


def drive_line(output: int, value: float) -> str:
    vals = [0.0, 0.0, 0.0]
    vals[output] = value
    return "D {:.3f} {:.3f} {:.3f}".format(*vals)


def run(link: Link, output: int, value: float, seconds: float) -> bool:
    # Alive?
    # (the board may be rebooting after the port was opened: it ignores input for 4 s)
    idx = link.mark()
    t0 = time.monotonic()
    got = None
    while time.monotonic() - t0 < 8.0 and got is None:
        link.send("P", quiet=True)
        got = link.wait_for(lambda s: s == "PONG", 0.5, idx)
    if got is None:
        print("No answer from the ESP32 (is the monitor closed? flashed? right port?)")
        return False

    # Must be LIVE firmware.
    idx = link.mark()
    link.send("R")
    rep = link.wait_for(lambda s: s.startswith("R "), 1.0, idx)
    if rep is None:
        print("No R report from the firmware.")
        return False
    if "[DRY RUN]" in rep[1]:
        print("Firmware is in DRY RUN: no pulses are produced. Set DRY_RUN = false in")
        print("src/config.h and flash again.")
        return False

    esc = EscConfig()
    link.stream = "S"
    time.sleep(0.4)
    t = last_t(link, link.mark() - 5) or (0, 0, 0)
    neutral = esc.neutral_us if t[output] == esc.neutral_us else t[output]
    print(f"Spinning {ESC_NAMES[output]} (firmware output {output}, GPIO {ESC_PINS[output]}), "
          f"value {value:+.3f}, hold {seconds:.1f} s. Neutral is {neutral} us.")

    steps = max(1, int(RAMP_S / PERIOD_S))
    schedule = [value * (i + 1) / steps for i in range(steps)]
    schedule += [value] * int(seconds / PERIOD_S)
    schedule += [value * (steps - 1 - i) / steps for i in range(steps)]

    ok = True
    try:
        t0 = time.monotonic()
        for k, v in enumerate(schedule):
            link.stream = drive_line(output, v)
            time.sleep(PERIOD_S)
            if k % 10 == 0:
                tt = last_t(link, max(0, link.mark() - 12))
                shown = f"T {tt[0]} {tt[1]} {tt[2]}" if tt else "no T yet"
                print(f"  {time.monotonic() - t0:4.1f} s  cmd {v:+.3f}  {shown}")
    except KeyboardInterrupt:
        print("\nCtrl+C: stopping")
        ok = False
    finally:
        link.stream = "S"
        for _ in range(3):
            link.send("S", quiet=True)
            time.sleep(PERIOD_S)
    time.sleep(0.4)
    tt = last_t(link, max(0, link.mark() - 5))
    final_ok = tt is not None and tt == (neutral, neutral, neutral)
    print("Stopped, telemetry:", f"T {tt[0]} {tt[1]} {tt[2]}" if tt else "none",
          "(neutral OK)" if final_ok else "(NOT neutral, cut ESC power!)")
    link.stream = None
    return ok and final_ok


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--output", type=int, required=True, choices=(0, 1, 2),
                    help="firmware output: 0=io1 (left), 1=io42 (right), 2=io40 (vert)")
    ap.add_argument("--value", type=float, default=0.10,
                    help="throttle -0.30..0.30 (default 0.10 = +50 us); negative = reverse")
    ap.add_argument("--seconds", type=float, default=2.0, help="hold time, 0.5..5 (default 2)")
    ap.add_argument("--port", help="serial port (default: auto-detect)")
    ap.add_argument("--yes", action="store_true", help="skip the safety question")
    args = ap.parse_args(argv)

    if abs(args.value) > MAX_VALUE or args.value == 0:
        ap.error(f"--value must be non-zero and within +/-{MAX_VALUE}")
    if not 0.5 <= args.seconds <= 5.0:
        ap.error("--seconds must be 0.5..5")

    if not args.yes:
        print(f"This SPINS the {ESC_NAMES[args.output]} motor (GPIO {ESC_PINS[args.output]}).")
        print("Check: motor clamped, propeller area clear, hand on the power-box e-stop,")
        print("ESP32 powered and 'ROV ready' seen BEFORE connecting ESC power.")
        if input("Type YES to continue: ").strip() != "YES":
            print("Aborted.")
            return 2

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
        return 0 if run(link, args.output, args.value, args.seconds) else 1
    finally:
        link.close()


if __name__ == "__main__":
    sys.exit(main())
