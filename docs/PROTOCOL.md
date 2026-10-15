# Serial protocol (laptop ↔ ESP32)

The firmware (`src/protocol.h`, `src/main.cpp`), the mock (`host/bridge/mock_esp32.py`)
and the GUI must all follow this file. `host/tests/test_protocol_twin.py` proves the
firmware parser and the mock parser agree on ~22 000 fuzzed lines.

## Framing

- ASCII text lines, `\n`-terminated, 115200 baud, 8N1.
- `\r` is ignored anywhere, so `\r\n` works too (PlatformIO monitor sends it).
- A line may contain only printable ASCII (0x20–0x7E) and tabs. Any other byte
  drops the whole line.
- Max line length: **160 characters**. Longer lines are dropped entirely, never truncated.
- Tokens are separated by one or more spaces/tabs. Leading and trailing whitespace is ignored.
- Commands are one **upper-case** letter. Blank lines are ignored silently.
- The bridge forwards lines unchanged in both directions.

## Browser ↔ bridge (WebSocket, `ws://localhost:8765`)

One text line per WebSocket message, same lines as on the serial port, no `\n`.

- Browser → bridge: only the laptop → ESP32 commands below (`D S P M U G R`). The bridge
  drops anything else — other letters, binary frames, several lines in one message,
  non-printable characters, more than 160 characters — and answers that browser with
  `B rejected: <reason>`. Dropped lines never reach the ESP32.
- Bridge → browser: every line from the ESP32 unchanged, plus the bridge's own status
  lines, prefixed `B ` (never sent to the ESP32):

| Line | Meaning |
|---|---|
| `B bridge serial` / `B bridge mock` | First line after connecting: what the bridge talks to. |
| `B serial <port> connected` | Serial port opened (also sent to browsers connecting later). |
| `B serial lost: <reason>` | Port unplugged or failed. The bridge retries every second. |
| `B serial waiting: <reason>` | No port found / cannot open (e.g. monitor holds it). |
| `B mock ESP32 (no hardware)` | `--mock` mode. |
| `B rejected: <reason>` | Your last line was dropped. |

- When the **last** browser disconnects, the bridge sends `S` at once. It also sends `S`
  on shutdown (Ctrl+C).
- Only pages from `http://localhost:8000`, `http://127.0.0.1:8000` (and non-browser
  clients) may connect; WebSocket connections from other web pages get HTTP 403, so no
  website can drive the motors through your laptop.

## Laptop → ESP32

| Line | Meaning |
|---|---|
| `D <a> <b> <c>` | Thruster commands, each −1.000..1.000 (fraction of the full ESC range), in firmware output order (`ESC_PINS[0]`, `[1]`, `[2]`). Sent continuously at 20 Hz while armed. |
| `S` | All neutral. Sent continuously at 20 Hz while disarmed, and immediately on E-STOP. |
| `P` | Ping. Reply `PONG`. |
| `M <ssid> <password>` | Mission 1: join Wi-Fi. SSID: one token, no spaces, ≤ 32 chars. Password: the rest of the line (may contain spaces, ≤ 63 chars, empty = open network). Progress is reported as `N ...` lines. |
| `U <url>` | Mission 1: set the URL. One token, must start with `http://` or `https://`. |
| `G` | Mission 1: HTTP GET now. Reply `N got: <text>` per non-empty body line, or `N http error ...`. |
| `R` / `R 1` / `R 0` | Pin self-check: report once / stream every 500 ms / stop streaming. |

**Number format** (in `D`): `[+-]digits[.digits]` or `[+-].digits`, e.g. `0`, `-0.250`, `1.000`, `.5`.
No exponent, no hex, no `nan`/`inf`. The GUI sends 3 decimals.

**A `D` line needs exactly three numbers, each in −1..1, and nothing else.**
Anything else is malformed: it is ignored as a whole (never half-applied) and does
not refresh the watchdog.

See "Mission 1" below for what `M`, `U` and `G` do and which `N` lines they produce.

## ESP32 → laptop

| Line | Meaning |
|---|---|
| `T <us0> <us1> <us2>` | Telemetry: pulse widths being sent, ~5 Hz, also during arming. In DRY RUN: the widths that would be sent. |
| `N <text>` | Network / Mission 1 messages, see "Mission 1". |
| `W <text>` | Warning, see below. |
| `R <report>` | Self-check result per output, see below. |
| `PONG` | Answer to `P`. |
| anything else | Free text (boot banner `ROV ...`, ESP32 ROM boot log). Log it, never act on it. |

Warnings the firmware sends:

- `W watchdog: no command for 500 ms, thrusters neutral` — once per trip.
- `W ignored malformed line: "<first 40 chars>"`
- `W ignored overlong line`
- `W ignored line with non-printable bytes`
- `W pwm: LEDC attach failed on io<N>` — at boot, hardware/config problem.

The three `W ignored ...` lines share a rate limit: at most one per second.

### Self-check report

```
R left io1->io4: 1500us 50Hz sent 1500 ok | right io42->io5: 1500us 50Hz sent 1500 ok | vert io40->io6: 1500us 50Hz sent 1500 ok
```

Per output: `<name> io<esc pin>->io<readback pin>: <result>`, where result is one of

- `<width>us <freq>Hz sent <us> ok` — measured width within ±10 µs of what is sent, frequency 45–55 Hz;
- `<width>us <freq>Hz sent <us> MISMATCH` — signal present but wrong;
- `no signal (LOW) sent <us>` — no edge for 100 ms, input low (open jumper, dead pin, DRY RUN);
- `stuck HIGH sent <us>` — no edge for 100 ms, input high;
- `measuring sent <us>` — edges seen but no full period yet (only right after boot).

In DRY RUN the report starts with `R [DRY RUN] ` and every output reads `no signal (LOW)`.
The width is the last complete pulse (≤ 20 ms old), so ask for `R` at least 100 ms
after changing a value.

## Mission 1: Wi-Fi pairing and HTTP GET

The ESP32 itself joins the tower (station mode, 2.4 GHz only) and fetches the text. SSID,
password and URL are set at runtime, nothing is compiled in. Do it at the surface and
**disarmed**: Wi-Fi does not pass through water, and the firmware blocks during a GET.

Typical sequence (the GUI sends exactly this):

```
> U http://192.168.4.1/
< N url set: http://192.168.4.1/
> M UR_Field 12345678
< N wifi: connecting to UR_Field
< N wifi: connected, ip 192.168.4.2, rssi -48 dBm
> G
< N get: http://192.168.4.1/
< N http 200, 75 bytes
< N got: Congratulations!!! This is the WiFi API task message for the fall training.
```

`N` lines (the GUI parses these texts, keep them identical in firmware and mock):

| Line | Meaning |
|---|---|
| `N wifi: connecting to <ssid>` | `M` accepted, joining started (returns at once, progress follows). The password is never printed. |
| `N wifi: connected, ip <ip>, rssi <n> dBm` | Joined. |
| `N wifi: SSID "<ssid>" not found (still trying; 2.4 GHz only, check spelling)` | Once; the firmware keeps trying until the timeout. |
| `N wifi: failed, wrong password?` | Authentication failed; attempt stopped. |
| `N wifi: timeout after 15 s (<status>): check SSID, password, 2.4 GHz network` | Gave up. |
| `N wifi: connection lost, reconnecting` | Link dropped after a successful join. |
| `N url set: <url>` | `U` accepted. |
| `N get: <url>` | `G` started (the firmware is blocked until the result below). |
| `N http <code>, <n> bytes` | Answer 2xx with `<n>` body bytes. |
| `N got: <text>` | One non-empty body line, trimmed, printable ASCII (other bytes become `?`), max 300 chars, max 20 lines. |
| `N got: (empty body)` / `(<k> more lines not shown)` / `(cut at 2048 bytes)` | Notes about the body. |
| `N http error <code>` | Non-2xx answer (redirects are not followed). |
| `N http error: <reason>` | `wifi not connected (send M first)`, `no URL set (send U first)`, `bad URL`, `body read timeout`, `bad chunked data`, `body incomplete (timeout), text above may be cut`, or the HTTP library's text (`connection refused`, `read Timeout`, ...). |

Rules:

- **Before any blocking Wi-Fi/HTTP call all thrusters go to neutral.** A GET blocks for
  well under a second normally, at most about 15 s when the tower is silent (5 s connect +
  5 s answer + 5 s body).
- After a GET the firmware **drops whatever serial input queued up meanwhile** (stale `D`
  lines!) and does not let the GET itself trip the watchdog. A line that was cut in the
  middle by this is discarded too.
- `M` while connecting or connected restarts the attempt. No password = open network.
- The body is read with a deadline, with `Content-Length`, chunked, or until-close
  responses; `http://` and `https://` (certificate not checked) are accepted.
- Only `Transfer-Encoding: chunked` and plain bodies are supported (no compression).

## Pulse mapping and safety rules (firmware)

- 50 Hz frame. `us = NEUTRAL_US + value × US_PER_UNIT`, rounded half away from zero.
  Bidirectional ESC (default): `1500 + value × 500`.
  Forward-only (`ESC_BIDIRECTIONAL = false`): `1000 + value × 1000`, negative values → 0.
- **Hard clamp** to `NEUTRAL_US ± MAX_DELTA_US` (default ±150 µs → 1350..1650 µs).
  So `D 1 -1 0` gives `T 1650 1350 1500`. The GUI cannot bypass it.
- **Boot:** outputs neutral immediately, held for `ARM_MS` = 4000 ms so the ESCs arm.
  All serial input during this time is dropped, including the rest of a line that was
  cut by the end of arming. Then the firmware prints `ROV ready, accepting commands`.
- **Watchdog:** no valid `D` / `S` / `P` for 500 ms → all neutral + one `W` line.
  The next valid `D` resumes control. No warning right after boot (nothing was commanded yet).
- **DRY_RUN:** ESC pins are held LOW (no pulses), everything else works.

## Example session

```
> P
< PONG
> D 0.100 -0.100 0.200
< T 1550 1450 1600
> D 1 -1 0
< T 1650 1350 1500          (clamped)
> D 0.5 0.5
< W ignored malformed line: "D 0.5 0.5"
  (no D for 500 ms)
< W watchdog: no command for 500 ms, thrusters neutral
< T 1500 1500 1500
```
