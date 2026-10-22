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

- Browser → bridge: only the laptop → ESP32 commands below (`D S P M U G R L`). The bridge
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
| `L` | Mission 1: scan for Wi-Fi networks (asynchronous, 2-4 s, does not block or touch the thrusters). Reply `N scan: ...` / `N net: ...` lines. |

**Number format** (in `D`): `[+-]digits[.digits]` or `[+-].digits`, e.g. `0`, `-0.250`, `1.000`, `.5`.
No exponent, no hex, no `nan`/`inf`. The GUI sends 3 decimals.

**A `D` line needs exactly three numbers, each in −1..1, and nothing else.**
Anything else is malformed: it is ignored as a whole (never half-applied) and does
not refresh the watchdog.

See "Mission 1" below for what `M`, `U` and `G` do and which `N` lines they produce.

## ESP32 → laptop

| Line | Meaning |
|---|---|
| `T <us0> <us1> <us2>` | Telemetry: commanded pulse widths, ~5 Hz, also during arming, **without** the per-ESC trim (1500 = stop). The pin gets width + `NEUTRAL_TRIM_US`; `R` shows that real pulse. In DRY RUN: the widths that would be sent. |
| `N <text>` | Network / Mission 1 messages, see "Mission 1". |
| `W <text>` | Warning, see below. |
| `R <report>` | Self-check result per output, see below. |
| `PONG` | Answer to `P`. |
| anything else | Free text (boot banner `ROV ...`, ESP32 ROM boot log). Log it, never act on it. |

The boot banner includes `ROV reset reason: <why>`: `power-on`, `reset pin`, `software`, `USB`,
or a problem: `BROWNOUT (supply voltage dropped)`, `POWER GLITCH`, `CRASH (...)`. The GUI
shows a warning for a problem reason and when the board restarts 3 times within 30 s. Each
restart cuts the ESC pulses for a moment, which makes the motors twitch.

Warnings the firmware sends:

- `W watchdog: no command for 500 ms, thrusters neutral` — once per trip.
- `W ignored malformed line: "<first 40 chars>"`
- `W ignored overlong line`
- `W ignored line with non-printable bytes`
- `W pwm: LEDC attach failed on io<N>` — at boot, hardware/config problem.

The three `W ignored ...` lines share a rate limit: at most one per second.

### Self-check report

```
R left io1->io4: 1500us 50Hz sent 1500 ok | right io40->io6: 1478us 50Hz sent 1478 ok | vert io42->io5: 1500us 50Hz sent 1500 ok
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
| `N wifi: failed, wrong password?` | Authentication failed (the access point refused the key, or two key handshakes in a row timed out: the usual sign of a wrong WPA2 password); attempt stopped. |
| `N wifi: failed to start joining (a WPA2 password needs 8-63 characters)` | `WiFi.begin()` refused the settings at once (usually a 1-7 character password). |
| `N wifi: timeout after 15 s (<status>): check SSID, password, 2.4 GHz network` | Gave up. |
| `N wifi: connection lost, reconnecting` | Link dropped after a successful join. |
| `N url set: <url>` | `U` accepted. |
| `N get: <url>` | `G` started (the firmware is blocked until the result below). |
| `N http <code>, <n> bytes` | Answer 2xx with `<n>` body bytes. |
| `N got: <text>` | One non-empty body line, trimmed, printable ASCII (other bytes become `?`), max 300 chars, max 20 lines. |
| `N got: (empty body)` / `(<k> more lines not shown)` / `(cut at 2048 bytes)` | Notes about the body. |
| `N http error <code>` | Non-2xx answer (redirects are not followed). |
| `N http error: <reason>` | `wifi not connected (send M first)`, `no URL set (send U first)`, `bad URL`, `body read timeout`, `bad chunked data`, `body incomplete (timeout), text above may be cut`, or the HTTP library's text (`connection refused`, `read Timeout`, ...). |
| `N scan: started` | `L` accepted, scanning (2-4 s). |
| `N scan: <n> networks` | Scan finished: `<n>` networks heard, the `N net:` lines follow. |
| `N net: <rssi> dBm ch <ch> open\|secured <ssid>` | One network, strongest first, at most 15. SSID last (may contain spaces), non-printable bytes as `?`, hidden networks as `(hidden)`. |
| `N scan: (<k> more not shown)` | More than 15 networks: the weakest are left out. |
| `N scan: failed` / `failed (timeout)` / `already running` / `busy joining Wi-Fi, scan again when it is connected or failed` | Scan not done (or still running). |
| `N scan: cancelled (joining Wi-Fi)` / `cancelled (GET)` | `M` or `G` arrived during a scan: the scan is dropped, the command runs. |

Rules:

- **Before any blocking Wi-Fi/HTTP call all thrusters go to neutral.** A GET blocks for
  well under a second normally, at most about 15 s when the tower is silent (5 s connect +
  5 s answer + 5 s body).
- After a GET (and after `M`, and after the first `L` that switches the radio on: both block up
  to about 1 s) the firmware **drops whatever serial input queued up meanwhile** (stale `D`
  lines!) and does not let the block itself trip the watchdog. If anything was queued, the next
  line is discarded too (it may have been cut in the middle); harmless with `S`/`D` at 20 Hz.
- `https://`: the TLS handshake is limited to 5 s (`HTTP_CONNECT_TIMEOUT_MS`), the certificate is
  not checked. A host name instead of an IP adds DNS time that no timeout bounds.
- `M` while connecting or connected restarts the attempt. No password = open network.
- The body is read with a deadline, with `Content-Length`, chunked, or until-close
  responses; `http://` and `https://` (certificate not checked) are accepted.
- Only `Transfer-Encoding: chunked` and plain bodies are supported (no compression).

## Pulse mapping and safety rules (firmware)

- 50 Hz frame. `us = NEUTRAL_US + value × US_PER_UNIT`, rounded half away from zero.
  Bidirectional ESC (default): `1500 + value × 500`.
  Forward-only (`ESC_BIDIRECTIONAL = false`): `1000 + value × 1000`, negative values → 0.
- **Per-ESC trim:** `NEUTRAL_TRIM_US` (`src/config.h`) is added to every pulse of that output,
  for an ESC whose real stop is not at 1500 µs. `T` keeps showing the untrimmed widths
  (1500 = stop); the `R` self-check shows and checks the real pulse on the pin.
- **Hard clamp** to `NEUTRAL_US ± MAX_DELTA_US` (default ±150 µs → 1350..1650 µs), applied before the
  trim: an ESC with trim −22 gets 1328..1628 µs on its pin.
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

## Vision WebSocket (:8766)

Camera help for missions 2-5. **Display-only:** the vision service never talks to the
ESP32 and never changes a motor command; its results only draw boxes and hints in the GUI.
Code: `host/bridge/vision_service.py` (WebSocket), `host/vision/` (detectors),
`host/webgui/js/vision_proto.js` (browser side). Protocol version 1.

- URL `ws://localhost:8766/` (`--vision-port N` to change, `--no-vision` to switch it off;
  the GUI takes `visionPort` from `config.js`, `?visionPort=N` in the address bar overrides it).
- Same Origin rule as the line WebSocket: only the bridge's own GUI pages (and non-browser
  clients) may connect, other web pages get HTTP 403.
- If OpenCV or pupil-apriltags cannot be loaded, the service still listens and says so in
  its hello; the line WebSocket and driving work as before. A busy port is not fatal either:
  the bridge prints `Vision:     UNAVAILABLE: cannot listen on port 8766: ...` and drives normally.

### Browser → service: one frame = one binary message

```
bytes 0..3      uint32 big-endian N = header length, 1 <= N <= 4096
bytes 4..4+N    UTF-8 JSON object {"id": <int 0..2147483647>, "mode": "tags" | "line" | "colors", "params": {...}}
rest            JPEG image, 1 .. 4 000 000 bytes
```

- `id`: any integer 0..2^31−1 (not a bool); the reply carries it back. The GUI counts up.
- `params` may be left out (= `{}`); when present it must be an object. Unknown params are
  ignored, out-of-range numbers are clamped, a wrong type (or NaN) gives the default.
- The JPEG is decoded as is (EXIF rotation ignored), at most 4096 × 4096 pixels.
- Largest message: 4 000 000 + 4 + 4096 = 4 004 100 bytes. A bigger one closes the
  connection (WebSocket close code 1009); the GUI reconnects within 1 s.

Text messages: `{"type":"ping"}` → `{"type":"pong"}`. Any other text → error reply.

**One frame in flight.** The service reads the next message of a connection only after it
has answered the previous one, so replies come in order. The GUI sends the next frame only
after the answer (or after `vision.timeoutMs` = 2000 ms without one; a late answer for that
frame is then ignored), at most `vision.sendHz` = 15 frames/s. Detection runs in a pool of
two threads, never on the bridge's event loop, so motor commands and E-STOP stay responsive.

What the GUI sends per camera tab (JPEG quality 0.9, width from `vision.sendWidth`):

| Tab | mode | params | JPEG width |
|---|---|---|---|
| Drive, 4 Hook | – | no frames sent | – |
| 2.1 Tags | `tags` | `clahe`, `minMargin`, `maxHamming`, `expect` 3, `tagSizeM` 0.162 | 1280 |
| 2.2 Dock | `tags` | as 2.1 plus `hfovDeg` (effective HFOV, see README) | 1280 |
| 3 Line | `line` | `darkThresh`, `refRow`, `mask` | 640 |
| 5 Poles | `colors` | `colors` (calibrated ranges), `minAreaFrac`, `maxBlobs` 3, `mask` | 640 |

### Service → browser: JSON text

On connect, first message:

```json
{"type":"hello","version":1,"available":true,"modes":["tags","line","colors"]}
{"type":"hello","version":1,"available":false,"modes":[],"reason":"ModuleNotFoundError: No module named 'cv2'"}
```

Per frame, exactly one of:

```json
{"type":"result","id":42,"mode":"tags","w":1280,"h":720,"ms":23.4, ...mode fields...}
{"type":"error","id":42,"text":"unknown mode 'tag', expected one of tags, line, colors"}
```

- `w`, `h`: size of the decoded JPEG. **All coordinates are pixels of that JPEG**, origin top
  left, x right, y down. `ms`: decode + detection time.
- Rounding: pixels 1 decimal, metres 3, degrees 1, `offset` 3, `confidence` 2,
  `areaFrac` 6, `aspect` and `fill` 3. Replies never contain NaN or Infinity.
- `error.id` is the frame's id when the header could be read, else `null`. `text` is at most
  300 characters. **The connection stays open after an error**; the next frame is processed
  normally.

Error texts:

| Text | When |
|---|---|
| `message shorter than the 4-byte header length` | |
| `header length <N> not in 1..4096` | |
| `message ends inside the <N>-byte header` | |
| `header is not valid JSON: ...` | also for absurdly deep nesting |
| `header must be a JSON object` | |
| `header id must be an integer 0..2147483647` | id `null` |
| `header mode must be a string` | |
| `header params must be an object` | |
| `no JPEG after the header` | |
| `JPEG larger than 4000000 bytes` | |
| `unknown mode '<mode>', expected one of tags, line, colors` | |
| `not a JPEG image` / `could not decode the JPEG` | |
| `JPEG size <W>x<H> not accepted (max 16777216 pixels)` | refused before decoding |
| `vision unavailable: <reason>` | OpenCV / pupil-apriltags missing, id `null` |
| `text messages must be JSON` / `unknown text message (frames are binary)` | text other than ping, id `null` |
| `internal error: <Type>: <message>` | a detector bug; logged in the bridge at most once per 10 s per error |

### mode `tags` (missions 2.1, 2.2)

| Param | Default | Range | Meaning |
|---|---|---|---|
| `clahe` | `true` | bool | allow the second, CLAHE (local contrast boost) pass: faint tags, murky water |
| `minMargin` | 10 | 0..200 | minimum decision margin: higher = fewer false ids, lower = finds faint tags |
| `maxHamming` | 1 | 0..2 | corrected bits allowed (tag36h11 ids differ in >= 11 bits: 1 is still safe) |
| `expect` | 3 | 0..20 | run the CLAHE pass only while fewer tags than this were found |
| `decimate` | 1.0 | 1..4 | detector downscale, snapped to 1, 1.5, 2, 3 or 4 (faster, misses small tags) |
| `tagSizeM` | 0.162 | 0.01..2 | black square edge in metres, for the pose |
| `hfovDeg` | `null` | 20..170 | horizontal FOV of the camera; `null` = no pose |

Detector: pupil-apriltags, family `tag36h11`, two passes: the raw grey image without pre-blur
(finds small, far tags best), then, only while fewer than `expect` tags were found and `clahe`
is on, a CLAHE pass with a light pre-blur. Results are merged by id (higher margin wins). A tag
is reported in `tags` only with `hamming <= maxHamming` and `decision_margin >= minMargin`; the
browser also needs 5 sightings before it trusts an id. Frames smaller than 32 px on a side give
no tags.

`weak`: candidates seen but rejected by those two filters (at most 10, best margin first):
`{"id", "corners", "center", "margin", "hamming"}`, display only (the GUI draws them dashed
grey as `ID n?`), never counted.

```json
"tags": [{"id": 245, "corners": [[x,y],[x,y],[x,y],[x,y]], "center": [x,y], "margin": 87.3,
          "pose": {"x": 0.112, "y": -0.054, "z": 1.874, "dist": 1.878, "yawDeg": -12.4, "yawOk": true}}]
```

- Sorted by id. `corners`: pupil-apriltags order, counter-clockwise on screen, always starting
  at the same physical corner of the tag. `margin`: decision margin (bigger = surer).
- `pose`: `null` unless `hfovDeg` is given. Then: tag centre in the camera frame, metres,
  **x right, y down, z forward**, `dist` = |(x, y, z)|. Camera model: fx = fy =
  (w/2)/tan(hfov/2), centre (w/2, h/2), no lens distortion; `cv2.solvePnP` IPPE_SQUARE.
- `yawDeg`: how far the tag is turned about the vertical axis, 0 = it faces the camera
  squarely. **Positive = the ROV is to the RIGHT of the tag's centre line** (move/yaw left to
  get in front of it). Assumes the ROV is roughly level.
- `yawOk`: `false` when the two mirror-image pose solutions fit almost equally well (small,
  far, or nearly square-on tag); the **sign** of `yawDeg` is then a guess. Distance and
  position are still good.

### mode `line` (mission 3)

| Param | Default | Range | Meaning |
|---|---|---|---|
| `darkThresh` | 25 | 5..120 | darkness threshold, see below |
| `refRow` | 0.75 | 0.3..0.95 | row (fraction of the height from the top) where `offset` is measured |
| `mask` | `false` | bool | also return the dark-pixel mask |

**Darkness** is measured relative to the local floor brightness on a 0..255 scale (0 = as
bright as the floor around it, 255 = black on a lit floor), on the brightest of the three
colour channels, so a dim corner of the pool does not hide the line. A pixel counts as dark
above `darkThresh`; a line must in addition be dark **on average** along its length, at least
3 × `darkThresh` (75 with the default). Tile joints and caustic shade measure 25-60, a black
line seen through pool water 110-200. In very murky water lower `darkThresh`.

```json
"refY": 540.0,
"line": {"p0": [x,y], "p1": [x,y], "angleDeg": 4.2, "offset": -0.135, "widthPx": 38.5,
         "tapes": [[x,y], ...], "confidence": 0.91}
```

- `line` is `null` when no line is found.
- `refY` = `refRow` × h. `p0`: end of the visible line nearer the image bottom, `p1`: far end.
- `angleDeg`: 0 = the line goes straight up the image, **+ = far end leans right**, −90..90.
- `offset`: x of the line at `refY` (extrapolated if needed) minus w/2, divided by w/2,
  clamped −2..2. **+ = the line is right of the image centre.**
- `widthPx`: line width in JPEG pixels. `confidence` 0..1 (low when the line is short, faint
  or a second similar line is in view).
- `tapes`: bright bands across the line, sorted **bottom → top** (y descending). A tape is a
  gap in the dark line that is clearly not dark, or a bright band right at an **end** of the
  line (the final tape when the line ends there, the start tape when it begins there). The GUI
  counts every tape that crosses its trigger row, the start tape included.
- `mask` (only when asked): `data:image/png;base64,...`, white = dark pixel. It is the
  detector's work size (240 or 480 px wide), not the JPEG size: scale it to the frame.
- The detector handles a line up to about 30 % of the frame width. Closer than about 20 cm to
  the floor it may see only one edge of the line.

### mode `colors` (mission 5, general colour blobs)

| Param | Default | Range | Meaning |
|---|---|---|---|
| `colors` | the 3 defaults below | object, ≤ 6 entries | name → `{"h":[lo,hi], "s":[lo,hi], "v":[lo,hi]}` |
| `minAreaFrac` | 0.0008 | 0..0.5 | smallest blob, fraction of the frame area |
| `maxBlobs` | 3 | 1..10 | blobs per colour |
| `mask` | `null` | a name in `colors` | also return that colour's mask |

- Ranges are OpenCV 8-bit HSV: H 0..179 (= hue° / 2), S and V 0..255. **H lo > hi wraps through
  0** (red `[170, 10]`). S and V pairs are put in order. Names: 1..16 characters `a-z 0-9 _ -`;
  invalid names are skipped. A malformed range of `red`, `yellow` or `blue` falls back to its
  default, of another name is dropped. Missing or empty `colors` = the defaults.
- Defaults (air values, approximate: **calibrate in the pool**; same numbers as
  `DEFAULT_COLORS` in `webgui/js/colors.js`):

| Colour | H | S | V |
|---|---|---|---|
| `red` | 170..10 | 100..255 | 70..255 |
| `yellow` | 18..38 | 100..255 | 100..255 |
| `blue` | 100..130 | 150..255 | 50..255 (the pool is blue: blue needs high saturation) |

Detection runs on a copy at most 640 px wide: 3×3 blur, HSV, range, open 3×3, close 5×5,
connected components; coordinates are scaled back to the JPEG.

```json
"blobs": [{"color": "red", "box": [x, y, w, h], "center": [x, y], "area": 5321.0,
           "areaFrac": 0.005774, "aspect": 7.9, "fill": 0.84}]
```

- Sorted by `area`, biggest first. `box`: top-left corner, width, height. `area`: pixels in
  JPEG scale. `areaFrac`: of the frame. `aspect` = box h / w (a pole is tall: > 1).
  `fill` = area / box area.
- `mask` (only when a valid name was asked for): `data:image/png;base64,...`, white = inside
  the range after the clean-up, at the work size (≤ 640 px wide).
