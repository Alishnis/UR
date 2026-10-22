# Laptop side (bridge + GUI)

```
Keyboard ─► Browser GUI ──WebSocket :8765──► Python bridge ──USB serial──► ESP32 ──► ESCs
              (webgui/)                        (bridge/)
USB camera ─► Browser GUI ──WebSocket :8766──► vision service (bridge/ + vision/), display-only
```

## Install (once)

```bash
cd host
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

**Without hardware** (fake ESP32, good for learning the GUI):

```bash
cd host && .venv/bin/python -m bridge --mock
```

**With the ESP32** (close the PlatformIO monitor first, only one program can hold the port):

```bash
cd host && .venv/bin/python -m bridge
```

Then open <http://localhost:8000/> in Chrome. The serial port is found automatically
(`--port /dev/cu.usbmodemXXXX` to force one). Ctrl+C stops the bridge and sets the
motors to neutral first.

Useful options: `--mock-dry-run` (mock behaves like DRY_RUN firmware), `--mock-arm-ms 0`
(skip the 4 s arming), `-v` (log connects, serial status), `--no-vision` / `--vision-port N`
(camera helpers, see "Camera and missions 2-5").

## Keys

| Key | Action |
|---|---|
| `W` / `S` | forward / back |
| `A` / `D` | yaw left / right |
| `R` / `F` | up / down |
| `J` / `K` | lower / raise magnitude (smooth) |
| `Space` (hold) | all zero, instantly |
| `Esc` | **E-STOP** (disarm). Works even while typing |
| `H` | Mission 4 hold timer start / stop (only on the camera tab `4 Hook`) |

Keys are physical keys, so they work on the Russian layout too. While a text field has
focus (e.g. a number in Calibration) driving keys are paused and the status bar says so;
press Enter to leave the field. A focused slider or checkbox does not block driving.
Switching to another window or tab clears all keys; hiding the tab also disarms.

## Status bar

`Bridge` (browser ↔ bridge) · `Serial` (bridge ↔ ESP32) · `ESP` (alive = any line within
1.5 s) · `Firmware` LIVE / DRY RUN · `Ping` round trip · `Vision` (detector service) and
`FPS` (camera frames / detector results per second), see "Camera and missions 2-5" · `Keys`.

**ARM is refused** unless the bridge is connected, the ESP32 answers, the firmware has
finished its 4 s power-up wait, and `outputSlot` uses 0, 1, 2 exactly once.
**The GUI disarms by itself** if the bridge connection drops, the ESP32 goes silent or
reboots, or the tab is hidden.

## Calibration (no reflash)

Defaults: [`webgui/js/config.js`](webgui/js/config.js), reload the page after editing.
The **Calibration** panel overrides output mapping, invert, gain and dead band and
remembers them in this browser; **Reset to config.js** returns to the file. The panel is
locked while ARMED.

| Value | Meaning | How to find it |
|---|---|---|
| `outputSlot` | which firmware output (0, 1, 2 = `ESC_PINS` order) drives left / right / vert | PIN TEST, then THRUSTER TEST (below) |
| `invert` | flip a motor that spins the wrong way | THRUSTER TEST |
| `gain` | balance left against right | drive straight, adjust until the ROV does not curve |
| `deadBand` | `(starting pulse in µs − 1500) / 500` | PIN TEST with the MAX slider raised slowly (hardware question Q3) |

The MAX throttle slider defaults to 0.30 (±150 µs, the firmware clamp). The firmware
clamp `MAX_DELTA_US` in `src/config.h` cannot be bypassed: a slider value above it changes nothing.

## Thruster test procedure (first power-up of all three motors)

Always: **motor clamped, propeller area clear, hand on the power-box e-stop, MAX slider at
its low default.** Never leave a motor running dry for more than a few seconds.

1. Start the bridge, open the GUI, wait for `ESP: alive`, `Firmware: LIVE`, then ARM.
2. **PIN TEST** (raw, ignores all mapping). Hold `GPIO 1+` briefly.
   Exactly **one** motor must turn. Write down which. Repeat for `GPIO 40+` and `GPIO 42+`.
   Two motors on one pin, or none: stop and check wiring and the `R` self-check
   (see `docs/PROTOCOL.md`).
3. Set `outputSlot` in Calibration so that **THRUSTER TEST** `L+` turns the *left* motor,
   `R+` the right one, `V+` the vertical one.
4. **THRUSTER TEST** direction: `L+` and `R+` must push the ROV *forward*, `V+` must push it
   *up*. A motor that turns the wrong way: tick `invert` for it. Do not rewire.
5. Dead band: PIN TEST on each pin, raise MAX in small steps until the motor just keeps
   turning, read the µs next to the bar, compute `deadBand`, enter it in Calibration.
6. Record all results in `docs/HARDWARE_QUESTIONS.md`.

The test buttons only work while ARMED, only while held (release, pointer cancel, window
blur, Space and Esc stop them) and stop by themselves after 5 s.

## Mission 1: Wi-Fi pairing (20 pts)

The ESP32 itself must join the tower and fetch the text; a laptop, phone or browser doing
the fetch scores zero. SSID, password and URL are given on site: type them into the
**Mission 1** panel (they are remembered in this browser) and press **Connect**, then **GET**.
The received text is shown big, with the Wi-Fi state above it. Do it at the surface, with the
vehicle **DISARMED** (the panel is locked while ARMED).

**Desk test before the competition** (needs a 2.4 GHz network the laptop is on too, a phone
hotspot works; 5 GHz-only networks cannot be joined):

1. Start the tower stand-in on the laptop, it prints the URL to use and logs every request:
   ```bash
   cd host && .venv/bin/python -m tools.m1_server
   ```
   macOS asks once whether Python may accept incoming connections: allow it.
2. Start the bridge and open the GUI. In the Mission 1 panel enter the hotspot's SSID and
   password and the printed URL (e.g. `http://172.20.10.2:8080/`). Connect, then GET.
3. The server log must show `UA='ESP32HTTPClient' -> ESP32`. That proves the ESP32 fetched it.

Without the GUI: `.venv/bin/python -m tools.m1_check --ssid UR_Field --password 12345678 --url http://...`
(close the bridge first). With `--mock` the bridge simulates a tower that knows `UR_Field` /
`12345678` and serves the manual's sample text, so you can practise the panel anywhere.

**Panel tools:**

- **Scan**: the ESP32 itself lists the Wi-Fi networks it hears (strongest first, signal bars,
  channel). Click a network to take its SSID. Below the list it says whether the SSID in the
  field is heard, mistyped (case!), too weak, or missing (then the tower is probably 5 GHz,
  which the ESP32 cannot join). Scanning does not block the ESP32 and does not touch the motors.
- **Auto: Connect + GET**: one press joins (skipped when already on that network), waits for
  Wi-Fi, sends GET, and retries (join or GET, every 3 s) until the text arrives, for up to 2 min.
  **keep fetching every 10 s** repeats the GET after that (the tower repeats its string).
  **Stop auto**, Connect, GET, or ARM end it.
- **Show to referee**: the received text huge over the whole page, with when, from which URL
  and over which Wi-Fi (ESP32's IP, RSSI) it was fetched. Close or Esc returns.
- **History**: every answer and error with its time (this browser, last 50).

**Competition day:** at the adjustment period get SSID, password and URL, press **Scan** to
check the tower is heard, then **Auto** on the vehicle at the surface, then **Show to referee**. If it fails, the
`N wifi:` / `N http error` lines say why (wrong password, SSID not found, 2.4 GHz only,
connection refused = wrong IP or port). Wi-Fi draws current in bursts: if the board resets
when you press Connect (log shows a new `ROV firmware` banner), the USB supply is too weak,
see `WIFI_TX_POWER_QDBM` in `src/config.h`.

## Camera and missions 2-5

The **Camera** panel (top of the page) shows the USB camera with an overlay and one tab per
mission. The bridge's vision service (`ws://localhost:8766`) finds tags, the line and the pole
colours in the frames the GUI sends it. Protocol: `docs/PROTOCOL.md`, "Vision WebSocket".

**Hints only.** Vision never sends anything to the ESP32 and never moves a motor: no
autopilot. Missions 3 and 4 must be piloted manually; every arrow and text is advice for the
pilot, who drives with the keys as usual.

### Start

1. Start the bridge as usual. The console shows `Vision:     ws://localhost:8766/  (camera missions 2-5)`.
   `Vision:     UNAVAILABLE: ...` = OpenCV / pupil-apriltags missing (reinstall
   `requirements.txt`) or port 8766 busy (another bridge still running?). Driving works either way.
2. Plug in the camera (the source list updates by itself).
3. Pick the camera in the source list, press **Start**. Chrome asks once for camera access:
   allow it. On macOS Chrome also needs System Settings → Privacy & Security → Camera.
4. Pick the mission tab. Only `2.1`, `2.2`, `3` and `5` send frames; `Drive` and `4` do not.

Placeholder messages: `Camera permission denied` (allow it in the address bar),
`Camera not found` (plug it in, pick another source), `Camera busy` (close Photo Booth, Zoom,
another tab), `Camera signal lost: reconnecting…` (the cable glitched or came out).

**Auto-reconnect:** when the camera drops out (a touched 5 m cable) or its picture freezes for
2.5 s, the GUI retries the same camera every 0.5 s and at once when the device reappears. The
picture comes back by itself; the log says `camera: back after N s`. **Stop** cancels the retries.

Options: `--vision-port N` moves the service (open the GUI with `?visionPort=N` then, or set
`visionPort` in `config.js`); `--no-vision` does not start it (chip `Vision: OFF`).

Header controls:

- **Source** + **Start / Stop**. The choice and the running state survive a page reload: the
  picture comes back by itself.
- **Attempt clock** (20:00, `attemptMinutes` in `config.js`): Start / Pause / Resume, Reset.
  Amber under 5 min, red under 1 min, `-mm:ss` over time. Keeps running over a reload.
- **Big view**: the picture fills the window under the status bar. It is not browser
  fullscreen on purpose, so `Esc` stays E-STOP.
- **View filters** (under the picture): brightness, contrast, saturation for the pilot's eyes
  only. The detector always gets the raw frame.

Overlay corners: ARMED / DISARMED top left, attempt clock top right, mission bottom left,
detector time per frame bottom right.

### Practice on land: Test scene (simulator)

Practice never touches the real attempt: while the simulator is the source, confirmed tags, the
tape count, the hold result, dropped balls and sampled colours live in a throw-away copy; picking
the camera again brings back what was saved for the real attempt.

Source **Test scene (simulator)** draws a simple pool with the course of the active tab
(tag wall, docking frame, line, object with handle, three poles) and sends it to the real
detector. **W A S D R F move the simulated ROV, also while DISARMED**; nothing reaches the
motors. `Reset position` puts it back at the start. Use it with `--mock` to practise every
mission, the buttons and the competition-day steps below.

### Status chips

| Chip | Meaning |
|---|---|
| `Vision: tags 23 ms` (green) | detections arriving; time per frame in the bridge. Amber: answers take > 0.5 s |
| `Vision: ready` | service connected, the tab sends no frames (Drive, 4) |
| `Vision: tags, waiting` / `no video` | no fresh result yet / no source started |
| `Vision: ERROR` | the detector refused a frame, hover for the reason (also in the log) |
| `Vision: UNAVAILABLE` | the bridge has no OpenCV / pupil-apriltags, hover for the reason |
| `Vision: OFF` | no service: bridge not running, `--no-vision`, or wrong port. Red on a mission tab with video |
| `FPS: 30 · det 10/s` | camera frames per second · detector results per second. Amber under 15 fps |

Results older than 1 s are never drawn; the side panel then says why (`NO VIDEO`,
`VISION OFF`, `WAITING FOR DETECTOR`, `DETECTOR ERROR`, ...).

### Camera lens (Drive tab)

Enter the camera's horizontal field of view **in air** (`HFOV`, default 70°, from the camera's
data sheet or measured) and tick **Underwater**: behind a flat port the view shrinks about
1.33x (70° in air = 55.4° in water). The effective value is shown under it. It is used for the
2.2 distance and position: a wrong HFOV gives wrong metres, not wrong directions. Defaults:
`camera` in `config.js`; changes are remembered in this browser.

### 2.1 Tags (AprilTag scan)

Shows: green boxes on confirmed tags, amber with a `k/5` sighting count on new ones, red on
ignored ones, the selected tag highlighted; the big result, confirmed chips (`★` = selected),
"in view now" chips.

- Press **LARGEST** or **SMALLEST** as the referee assigns. Required: no result without it.
- An id counts after it was seen in 5 frames (`confirmFrames`). Only well-read tags count (at
  most 1 corrected bit, margin >= Min margin), so a wrong id is very unlikely.
- A grey dashed **ID n?** = the tag is seen but not trusted yet (blurred, small or faint): hold
  steadier, come closer, or lower **Min margin** a little.
- When exactly 3 are confirmed: `SELECTED: ID n (LARGEST)`. Show the screen to the referee.
- More than 3 (a wrong id): **Undo last** removes the last one and ignores that id until
  **Reset**. Reset forgets the tags and keeps the rule.
- Detector: **CLAHE second pass** helps faint tags and murky water (on by default; it runs only
  while fewer than 3 tags are in view). Lower **Min margin** (default 10) if a clearly visible tag
  stays grey; raise it if strange ids appear.
- Tags are found best when they are at least ~50 px wide in the picture (about 2.5 m away with a
  70° camera) and the ROV is not turning: motion blur is the main cause of misses.

**Competition day:** set the rule, then pass slowly in front of each tag, square-on and steady,
until all three chips are green. Read `SELECTED: ID ...` to the referee. The result survives a
page reload.

### 2.2 Dock (chamber docking)

Shows: the target tag marked `TARGET`, an arrow and the advice text, distance, bearing, height
offset and tag yaw.

- **Target tag ID**: press **Use 2.1 result**, or type the id the referee gives.
- Advice in this order: `TURN LEFT` / `TURN RIGHT` (bearing over 5°), then `UP` / `DOWN`
  (over 8 cm), then `FORWARD`, `SLOW, ENTERING` under 1 m (`mission22` in `config.js`).
- The hint line warns when you are off the chamber's centre line (tag yaw over 15°). The ROV
  cannot move sideways: back out, get onto the centre line, then go in again.
  `(unsure)` after the yaw = the yaw's sign may be wrong for this view.
- `aimBelowM` in `config.js`: how far the chamber entrance is below its tag (measure on the
  frame). 0 = aim at the tag itself. The simulator uses its own layout.

**Competition day:** confirm the target id with the referee, line up in front of the frame
with the tag in view, follow the advice slowly. No contact = 20 pts, contact = 10.

### 3 Line (line following, manual piloting)

Shows: the detected line (green when on line), tapes as white ticks, a steering arrow; in the
side panel a steering gauge and text (`ON LINE`, `YAW LEFT`, `YAW RIGHT`,
`LINE LOST · last seen LEFT`), angle, offset, confidence and the checkpoint track
(start · 50 · 100 · 150 cm).

- A white tape counts when it crosses the **dashed amber row** (`triggerRow` 0.75).
- The START tape counts too: the panel goes `Before the start tape` → `Start tape passed` →
  `Checkpoint 1 · 50 cm` → … Fix a miss with **−1 / +1**. Untick **Count tapes automatically** to count only by hand.
- **Dark threshold** (default 25): lower it when the line is not found in murky water; raise
  it when tile joints or shadows are taken for the line. **Show mask** paints what the
  detector calls dark.
- Do not fly too low: closer than about 20 cm to the floor the line fills the picture and is lost.

**Competition day:** press Reset before the start tape, follow the line; the panel shows
`Start tape passed`, `Checkpoint 1 · 50 cm`, `Checkpoint 2 · 100 cm`, `FINAL · 150 cm`. Correct the count with
−1 / +1 if a tape was missed or counted twice.

### 4 Hook (object retrieval, manual piloting)

No detection, just the timer and a reticle.

- **Set hook point**, then click the video where the hook is: an amber reticle stays there
  (remembered).
- When the object is hooked and clear of the ground press **H** (or **Hooked: start**);
  press H again when it touches down. 3.0 s continuous = `20 pts secured ✓`, which stays
  (also over a reload) until **Reset**. Best hold is shown.

### 5 Poles (pole colours)

Shows: boxes on the red, yellow and blue poles, a pulsing outline on the NEXT one, the centre
band, `NEXT: BLUE` with an approach hint (`SEARCH: turn slowly`, `YAW LEFT/RIGHT`, `FORWARD`,
`CLOSE: hit it`).

- Type the referee's order, e.g. `R-B-Y` (also `RBY`, `red blue yellow`, or the same keys on
  the Russian layout) and press Enter or **Set**.
- After each drop press **Ball dropped ✓**. **Undo** takes back the last one, **Reset** clears
  the drops and keeps the order.

**Colour calibration in the pool (do it in the adjustment period, every time):**

1. Open **Colour calibration**, pick the colour, press **Sample: click the pole**, click on
   the pole in the video (in the water, at a typical distance).
2. **Shift+click** another spot (lit side, shadow side) to widen the range.
3. Tick **Show mask**: only the pole should light up. If the water lights up too, raise
   **S lo** (and **V lo**); the GUI already raises them when the first range also matches the
   background, and warns when it could not.
4. Repeat for all three colours. **Reset colour** returns to the default (air values).
5. **Export** saves `rov_colors.json`; **Import** loads it on another laptop or after
   clearing the browser. Ranges are remembered in this browser.

### What is remembered

In this browser (localStorage): tab, source, lens, filters, big view,
2.1 rule and tags, 2.2 target, 3 count, 4 best hold and hook point, 5 order, drops and colour
ranges, attempt clock. A hold that was running is not resumed after a reload. Storage belongs
to the page address: `127.0.0.1:8000` does not see what was saved on `localhost:8000`, so always
open the same address.

## Tests

```bash
cd host && .venv/bin/python -m pytest -q          # bridge, mock ESP32, protocol twin, vision
cd host/webgui && node --test                      # mixer, controller, keys, calibration, Mission 1, camera missions
sh tests/firmware/run.sh                           # firmware parser + Mission 1 helpers (project root)
```

Vision tests use synthetic frames only (no camera): `tests/vision_synth.py` draws tags 17 / 245 /
503, a line with tapes and coloured poles in fake pool water.

| File | Checks |
|---|---|
| `tests/test_vision_frames.py` | message layout, limits, JPEG decode, params clamping |
| `tests/test_vision_tags.py` | ids, corner order, margin filter, pose distance, yaw sign |
| `tests/test_vision_line.py` | angle, offset sign, tapes, no line → null, uneven light, tile joints |
| `tests/test_vision_colors.py` | each colour, red hue wrap, area filter, mask |
| `tests/test_vision_process.py` | dispatch, bad messages, never raises |
| `tests/test_vision_service.py` | real bridge + mock ESP32: hello, results, errors, ping, origin, oversized message, busy port, no OpenCV, `--no-vision`, driving stays responsive |
| `webgui/tests/vision_proto.test.js` | frame packing, reply parsing |
| `webgui/tests/tags.test.js` | 2.1 confirmation, rule, undo, storage; 2.2 docking advice |
| `webgui/tests/line.test.js` | steering text, checkpoint counting |
| `webgui/tests/colors.test.js` | HSV same as OpenCV, sampling, import / export |
| `webgui/tests/poles.test.js` | order parsing, drops, approach hint |
| `webgui/tests/timers.test.js` | hold timer, attempt clock |
| `webgui/tests/sim.test.js`, `testscene.test.js` | simulator motion, camera, course in view |
| `webgui/tests/overlay.test.js`, `vision_link.test.js` | overlay geometry; one frame in flight, timeouts, connection loss, camera error texts |

Hardware acceptance (ESC power unplugged, or DRY_RUN firmware): 
`.venv/bin/python -m tools.fw_check`. First spin test without the GUI:
`.venv/bin/python -m tools.spin_test --output 0`.

## Pre-dive checklist

- [ ] Firmware is LIVE (`Firmware: LIVE`), clamp ±150 µs unless deliberately changed
- [ ] `fw_check` passes with ESC power unplugged
- [ ] Each pin spins exactly one motor (PIN TEST), names and directions fixed (THRUSTER TEST)
- [ ] Calibration saved (and copied into `config.js` as the new defaults)
- [ ] Common GND between ESP32 and ESC signal wires; ESP32 not powered from USB and the buck at the same time
- [ ] E-STOP (Esc and the button) tested: motors stop, GUI shows DISARMED
- [ ] ESC failsafe (motor clamped, hand on the e-stop): while armed and spinning, unplug the USB
      cable. The ESP32 loses power, so there is no signal at all: the motor must stop. If it keeps
      spinning, the ESCs have no signal-loss failsafe: tell the team, rely on the power-box switch
- [ ] Stop the bridge with Ctrl+C while armed: motors stop at once (bridge sends S)
- [ ] Hand on the power-box emergency switch for the first run
- [ ] Bridge console shows `Vision:     ws://localhost:8766/ ...`, not `UNAVAILABLE`
- [ ] Camera picture in the GUI, chip `FPS` green; Drive tab: HFOV right, **Underwater** ticked
- [ ] Camera cable strain-relieved; pulling it must not unplug the ESP32 USB
- [ ] Reset before the run: attempt clock, 2.1 tags, 3 checkpoints, 4 hold timer, 5 balls
      (2.1 rule and 5 order are set when the referee gives them)
- [ ] 5: colours calibrated **in the pool** (Show mask: only the poles light up), exported to `rov_colors.json`
- [ ] Esc tested once with the camera in Big view: E-STOP still works
