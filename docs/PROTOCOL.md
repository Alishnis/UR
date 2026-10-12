# Serial protocol: laptop <-> ESP32

Text lines, ASCII, ending with `\n`, 115200 baud over the USB-UART port. The browser GUI sends lines to the bridge
over a WebSocket and the bridge forwards them unchanged to the serial port (and every line from the ESP32 back to
the browser).

Firmware: `src/main.cpp` (`pio run -t upload`, close the bridge first). `DRY_RUN = true` there means the ESCs get
no signal (commands, telemetry, watchdog and Mission 1 all work); `false` drives the motors.
`host/bridge/mock_serial.py` behaves like this firmware, so the GUI can be tested without hardware.

## Laptop -> ESP32

| Line | Meaning |
|---|---|
| `D <left> <right> <vert>` | Thruster commands, each `-1.000 .. 1.000` (fraction of the full ESC range, + = forward / up). Sent **continuously at 20 Hz** while the GUI is armed. |
| `S` | All thrusters neutral (1500 us). Sent continuously at 20 Hz while disarmed, and at once on E-STOP. |
| `P` | Ping. Reply `PONG`. |
| `M <ssid> <password>` | Mission 1: Wi-Fi credentials (no spaces in the SSID). Reply with `N ...` lines while connecting. |
| `U <url>` | Mission 1: URL for the HTTP GET (e.g. `http://192.168.4.1/`). |
| `G` | Mission 1: do the HTTP GET now. Reply `N got: <text>` (one line per text line) or `N http error <code>`. |

## ESP32 -> laptop

| Line | Meaning |
|---|---|
| `T <left_us> <right_us> <vert_us>` | Telemetry: the pulse widths really sent to the ESCs, about 5 times a second. |
| `N <text>` | Network / Mission 1 messages (shown in the Mission 1 panel). |
| `W <text>` | Warning, e.g. `W watchdog: no command for 500 ms, thrusters neutral`. |
| `PONG` | Answer to `P`. |
| `ACK <what>` | Optional acknowledgement. |

## Firmware rules (safety, from CLAUDE.md)

- Start at neutral (1500 us) and stay there during the ESC arming delay.
- `us = 1500 + value * 500`, then **clamp to `1500 +- MAX_DELTA_US`** (start with 150, like the test sketch). The
  GUI also limits throttle (`maxThrottle`), but the firmware limit is the one that cannot be bypassed.
- **Watchdog:** no valid `D` / `S` / `P` line for 500 ms -> all thrusters neutral and send one `W` line.
- Malformed lines are ignored (never "half-applied").
- The three `D` / `T` numbers are in firmware output order (GPIO 4, 5, 6). Which thruster is on which output
  (`outputSlot`), and per-thruster direction, gain and dead band live in the GUI config (`host/webgui/js/config.js`), so they can be
  changed without reflashing.
