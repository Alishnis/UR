# host/ — laptop-side code

## Setup (once)
The `python3` on PATH is PlatformIO's private Python — do not install packages into it. Use the venv:

```bash
cd ~/Desktop/UR/host
/usr/local/bin/python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
source .venv/bin/activate
```

Run every command below from `host/` with the venv active.

## Browser GUI — control, Mission 1, Mission 2.1

Adapted from the ur_vehicle_juneer template (the original is kept unchanged in `archive/ur_vehicle_juneer_original`).
The browser shows the camera and sends the pilot's keys; the bridge forwards them to the ESP32 and runs the AprilTag
detection with the same Python code as `mission21.py`. Protocol: `docs/PROTOCOL.md`.

### Run
```bash
python -m bridge --mock     # no hardware: fake ESP32 (watchdog, telemetry, Mission 1 replies)
python -m bridge            # real ESP32, serial port found automatically (or --port /dev/cu.usbmodem...)
```
Open http://localhost:8000. Stop the bridge (Ctrl+C) before uploading firmware — it holds the serial port. Port busy
(another bridge still running)? Stop it, or start with `--ws-port 8775 --vision-port 8776 --http-port 8010` and open
the address the bridge prints.

1. **Connect** (bridge), pick the camera in the list (the ROV USB camera, or "test image: 3 tags" to try Mission 2.1
   without any camera), **Start Camera**.
2. **ARM** only with all movement keys released. W/S forward-back, A/D turn, R/F up-down, J/K throttle, hold Space =
   stop, **Esc = E-STOP** (disarms; press ARM again to drive).
3. The bars show the L / R / V commands and, under them, the pulse widths the ESP32 reports back (`T` lines).

### Safety built in
- Commands go out 20 times a second also when nothing changes; disarmed = `S`. The firmware watchdog stops the
  thrusters 500 ms after the last line (browser frozen, cable pulled).
- The bridge sends `S` when the last browser disconnects, and when it shuts down.
- `MAX throttle` slider (default 0.30 = +-150 us, limit 0.60 in `js/config.js`), a ramp (no jumps), and the firmware
  clamps again. Direction, gain and dead band per thruster: `js/config.js` (no reflashing).

### Thruster test (which motor is where)
Under the Pilot display: hold **L + / R + / V +** (or **-**) and only that motor runs, at the J/K throttle within
MAX. The `io4/io5/io6` labels over the bars show which ESP32 pin each thruster is sent to.
- Wrong motor spins -> swap the numbers in `outputSlot` in `js/config.js` (0 = GPIO 4, 1 = GPIO 5, 2 = GPIO 6).
- Right motor, wrong direction -> `invert: true` for that thruster.
- Motor does not start at all -> raise MAX / throttle until it starts, note the us value, set `deadBand`.
**PIN TEST** (GPIO 4 / 5 / 6 +/-) sends a raw signal to that one pin and ignores `outputSlot` and `invert`: use it
first to check the wiring (each pin must spin exactly one motor), then fix the names with THRUSTER TEST.
Goal: **L +** and **R +** push the ROV forward (water out of the back), **V +** pushes it up (water down).

### Two displays and two filter sets
- **PILOT VIEW** (big) uses the *pilot view filters*: only for our eyes, they never change detection.
- **DETECTOR INPUT** shows exactly the frame sent to the AprilTag detector, after the *detector filters*
  (brightness, contrast, saturation, hue, blur). Use them in the pool to help detection, and check the `margin`
  numbers: higher = more reliable. CLAHE (Mission 2.1 panel) runs in the bridge after these filters.
- `Same as pilot view` copies the pilot settings to the detector, `Reset` clears, double-click a slider = neutral.
  Both sets and the layout (`Pilot + detector` / `Pilot only` / `Detector only`) are remembered by the browser.
- Blur almost always makes AprilTag detection worse; it only helps against heavy sensor noise.
- Canvas filters need Chrome or Safari 18+; otherwise the detector label says they are ignored.

### Mission 2.1 panel
LARGEST / SMALLEST, Undo last (drops a false tag), Reset, CLAHE, number of tags. The answer `SELECTED: ID n` appears
only when exactly that many tags are confirmed. The tags are kept in the bridge, so reloading the page loses nothing.

### Mission 1 panel
SSID + password -> **Join Wi-Fi** (`M`), URL -> **HTTP GET** (`U`, `G`). The text the ESP32 received is shown large
for the referee. (Needs the firmware; the mock answers with the sample string from the manual.)

## Mission 2.1 — AprilTag scanning

### Camera: USB webcam on the laptop ("Wed Camera", UVC)
- The camera is plugged into the laptop (directly or through a USB hub), not into the ESP32.
- macOS: System Settings -> Privacy & Security -> Camera -> allow your terminal / VS Code (restart it afterwards).
- macOS also lists the built-in MacBook camera and, if nearby, the iPhone (Continuity Camera). Find the index of the
  USB webcam: `python -m tools.list_cameras` (it saves one snapshot per index into `captures/`, open them to see which is which).
  Use that index as `--source N` below.
- Close every other app that uses the camera (browser tab, Zoom, Photo Booth): only one app can hold it.

### Test tags
`python -m tools.make_tags` → 3 random tag36h11 IDs in `tags/` (`sheet.png` has all three).
Show them on another screen/tablet or print so the black square is 16.2 cm (competition size).
Fixed IDs: `python -m tools.make_tags --ids 17 245 503`.

### Run
```bash
python mission21.py --source 1          # camera index from list_cameras
python mission21.py --source 1 --rule smallest
python mission21.py --source tags/sheet.png   # still image, no camera needed
```

| Key | Action |
|---|---|
| L / S | rule LARGEST / SMALLEST (must be set, otherwise no answer is shown) |
| R | reset — forget all tags (start of an attempt) |
| U | drop the last confirmed tag (false positive), ignored until reset |
| Space | freeze the frame to show the referee |
| P | screenshot to `captures/` |
| C | CLAHE contrast boost on/off (on by default) |
| F | fullscreen |
| Q / Esc | quit |

How it decides: a tag counts only after it was seen in `--confirm-frames` frames (default 5) with zero bit errors and `decision margin >= --min-margin` (20). Tags are remembered for the whole attempt, so they can be scanned one by one. `SELECTED` appears only when exactly `--expected` (3) tags are confirmed; with more it shows `???` until you press U.

### Tuning at the pool (no code changes needed)
- Tags far away / small: keep `--decimate 1.0` (default). Low FPS: `--decimate 2.0`.
- Murky / dark water: CLAHE is on by default (`C` toggles, `--no-clahe` starts with it off). Watch the `margin`
  number under each tag — higher is more reliable. The margin drops with image contrast, not only with misreads:
  murky water gives ~20 even for a perfectly read tag, which is why the default threshold is 20, not 30.
- Flickering false IDs: raise `--min-margin` (40–50) or `--confirm-frames` (8–10).
- Image mirrored (tags never detected): `--flip`.

### Simulating underwater conditions on land
```bash
python mission21.py --source 0 --sim murky
```
The frame is degraded *before* detection, so you see exactly what the detector gets. A second window
"Underwater sim" has live sliders: `tint` (red absorbed), `haze` (turbidity), `dark`, `blur`, `motion`
(ROV moving), `noise`, `resolution` (% of detail kept). Keys: `W` sim on/off, `1` clear, `2` murky, `3` bad.

| Preset | Expected result |
|---|---|
| clear | all tags detected |
| murky | detected with the defaults (CLAHE on, `quad_sigma` 0.8, margin 20) up to ~3 m on paper; nothing with `--no-clahe` |
| bad | nothing detected — shows the limit; it must never show a *wrong* ID |

Findings from synthetic tests: contrast loss + **motion blur** together is the main killer (each alone is harmless),
so hold the ROV still while scanning tags. In murky water CLAHE is essential.
A tag shown on a laptop/phone screen has much less contrast than paper (grey black, glare) and fails
first in murky water — test with a print.

Also test for real: laminated tag in a clear box / bucket of water (glare!), a drop of milk for turbidity,
dim light, 2–3 m distance, steep angles.

## Mission 2.2 — Chamber docking

Goal: dock inside the chamber whose tag is the one selected by the Mission 2.1 rule (largest/smallest).
20 pts with no contact, 10 with any contact (tether too), 0 in the wrong chamber.

### Run
```bash
python mission22.py --rule largest                    # 3D pool simulator (default --source sim)
python mission22.py --rule largest --mount back       # tags on the back face of each cell
python mission22.py --source 0 --calib camera_usb.json   # real camera
```

| Key | Action |
|---|---|
| T | rule LARGEST / SMALLEST (same rule as 2.1) |
| N | new attempt: forget tags, reset the simulator |
| U | drop the last confirmed tag (false positive) |
| Space | pause |
| P | screenshot to `captures/` |
| C | CLAHE contrast boost |
| V / 1 2 3 | underwater image effects on/off / clear, murky, bad |
| G | fullscreen |
| Q / Esc | quit |
| **Simulator only** | `W`/`S` forward/back, `A`/`D` turn, `R`/`F` up/down, `X` all stop — throttle steps −3..+3 like the real ESCs |

### What the screen shows
- Tag boxes: `TARGET` (magenta), `WRONG` (red) once the target is known.
- Cyan rectangle = the 70×70 cm entrance of the target chamber, projected from the tag pose. Green = lined up.
- `LAT` / `VERT` / `YAW`: offset of the ROV from the chamber axis, green when inside the tolerance.
- `DIST`: metres from the camera (ROV nose) to the entrance plane; `line up before X m` — see blind zone below.
- One advice line: `TURN LEFT 12 deg`, `UP 8 cm`, `FORWARD`, `BACK UP to 2.1 m`, `STOP - DOCKED`, ...
- Simulator panel: throttle levels, `CONTACTS` (any contact = 10 pts max), the referee's `SCORE`, pose error vs truth.

### Things to MEASURE on the real ROV (flags, no code change)
| Flag | What | How |
|---|---|---|
| `--rov-width/--rov-height/--rov-length` | outer size incl. thruster guards | tape measure |
| `--slow-speed` | m/s at the slow forward throttle | time the ROV over 1 m in the pool |
| `--cam-tilt` | camera pitched down, degrees | phone level app on the camera mount |
| `--calib` | camera intrinsics | `tools.calibrate_camera`, **underwater** for the ROV camera |
| `--mount` | where the tags sit on the chambers | look at the props on the day (`above` or `back`) |

### Camera calibration
```bash
python -m tools.calibrate_camera --make-board        # tags/checkerboard.png, show full screen on a 2nd display
python -m tools.calibrate_camera --source 0 --out camera_usb.json
```
Space captures a view, C computes and saves after 12+ views. RMS < 0.5 px is good. Without `--calib` the
app assumes `--hfov 70`; distances are then only roughly right. `--water` converts an in-air calibration
(×1.33), but calibrating in the pool is better.

### How the guidance works (findings from the simulator)
- We have **no sideways thruster**, so a sideways offset is fixed like parking a car: steer at a point on the
  chamber axis 0.8 m ahead ("carrot"), merge onto the axis, then go straight.
- **Blind zone:** with `--mount above` the tag leaves the top of the image ~1.6 m before the entrance (we fly at
  entrance height, the tag is higher). Everything must be lined up *before* `line up before X m`. After the tag
  is lost the app counts down: `BLIND: SLOW FORWARD ~N s more, then STOP` (uses `--slow-speed`).
- In the final approach the nose is pointed at the docking spot, and the heading precision needed shrinks with
  the distance left (8° over 2 m = 30 cm drift = contact).
- **Heading from the row of tags:** one tag's angle is noisy (median 3°, often 6–10° at 720p) but tag positions
  are accurate to ~1 cm. When 2+ tags are visible the chamber axis is taken from the line through their centres.
- If the target is hidden (e.g. behind a pipe) but a neighbour is visible, its position is computed from the
  neighbour (cells are 70 cm apart; the left-to-right order is learned while all three are visible).
- Turns are limited so the target stays in the image; too close with a sideways error → `BACK UP` far enough to fix it.
- With `--mount back` a tag is only visible from a ±26° cone in front of its own cell (side posts hide it):
  line up in front of the row first.

### Simulator and autopilot check
`python -m sim.autopilot` flies a bot that **only follows the on-screen advice** from 6 start poses per mount.
Current result in clear water: 11/12 clean dockings (20 pts), 0 contacts. Options: `--effects murky`, `--no-clahe`.

## Mission 3 — Line following

Goal: follow the black line on the pool floor through the tapes (props manual: a ~1.5 m dark pipe, a tape every
50 cm, the first tape is the START; contest manual: CP1, CP2, final). **Manual operation is mandatory** — the app
only shows the pilot what to do.

### Run
```bash
python mission3.py                                  # pool-floor simulator, drive with W/S A/D R/F X
python mission3.py --source 0 --cam-tilt 30         # real camera (add --calib camera.json)
python -m sim.line_autopilot                        # bot that only obeys the advice, 5 start poses
```

| Key | Action |
|---|---|
| N | new attempt: tape counter to 0, simulator reset |
| + / - | correct the tape counter by hand (the referee decides, the counter only helps) |
| Tab | follow another dark line (if it locked on a lane marking / shadow) |
| [ / ] | darkness threshold down / up (murky water: lower it) |
| M | show the detector mask |
| Space, P, V, 1 2 3, G, Q | pause, screenshot, underwater effects, fullscreen, quit |

### What the screen shows
- Magenta line = the line being followed (green when lined up). Yellow circles = tapes, labelled with the
  milestone they will be and the distance along the line. `LINE BEGINS` / `END` when an end of the line is in view.
- White "rails" = where the ROV body goes if it keeps straight, with 0.5 m ticks. Cyan cross = the point to steer at.
- `HEADING` (line direction vs our nose), `OFFSET` (line left/right of the ROV centre), `HEIGHT` above the floor
  estimated from the line width, one advice line (`TURN LEFT 7 deg | FORWARD SLOWLY`, `UP 5 cm`, ...),
  `STEER` bar = suggested yaw for a future assisted mode, `TAPES PASSED n/4`.

### How it works
- Line = "darker than the floor around it" (morphological black-hat), not a fixed colour: underwater black turns
  blue-green and lighting changes. Tapes = places where the line is interrupted and clearly not dark (any colour).
- Pixels are projected onto the floor using the camera tilt. Heading needs no height; distances do, so the height
  is estimated from the known pipe width.
- No sideways thruster: a sideways offset is fixed like a car, by steering at a point 0.5 m ahead on the line.
- A tape counts when it slides out of the bottom of the image *while getting closer* (rising or turning does not
  count, reversing counts back). The camera cannot see the floor right under the ROV, so the app then says
  `keep going ~X cm to pass it`. At the end of the line it counts down `FORWARD SLOWLY ~N s` (uses `--slow-speed`).
- It only locks on to a line that is clearly darker than everything else, and then ignores lines less than half as
  dark (tile grout, shadows).

### Simulator findings
- **Camera tilt is the key hardware decision.** With the camera looking straight ahead (tilt 0) the floor is only
  visible from ~1.5 m ahead: the bot passed the course in 3/5 runs and the counter was wrong in all 5. With 20–45°
  down: 30/30 runs passed all four tapes, worst offset from the line 8 cm (with a side current, ~4 cm
  without), counter right in 29/30. The same camera is used for
  docking (`mission22.py --cam-tilt` supports it), so agree on one angle with the team.
- Start ~1 m before the line: closer than ~0.8 m the START tape is already under the nose and is not seen as a tape.
- Murky preset: works without changes. Bad preset: only after lowering the threshold (`[`) and still unreliable.
- `--slow-speed` matters for the final countdown: time the ROV over 1 m at the slow throttle.

### Things to MEASURE (flags, no code change)
| Flag | What | How |
|---|---|---|
| `--cam-tilt` | camera pitched down, degrees | phone level app on the camera mount |
| `--line-width` | diameter of the black pipe (default 0.025) | ruler at the venue; wrong value = wrong height/distances |
| `--slow-speed` | m/s at the slow forward throttle | time 1 m in the pool |
| `--rov-length/--rov-width/--rov-height` | ROV size; the camera is assumed at the front | tape measure |
| `--calib` | camera intrinsics | `tools.calibrate_camera`, underwater for the ROV camera |

### Test on land (no ROV)
Black electrical tape or a black cable ~1.5 m on a light floor, white paper bands every 50 cm. Hold the phone at
~50 cm height, tilted down ~30° (check with a level app), run `python mission3.py --source 0 --cam-tilt 30
--line-width <tape width in m>` and walk along the line: `HEIGHT` should be close to the real height, `OFFSET`
should change sign when you step left/right of the line, the counter should go up as you walk over each band.

## Mission 5 — Pole colour recognition and hitting

Goal: knock the golf balls off the red, yellow and blue poles in the order the referee announces (e.g. `R-B-Y`):
10 pts per ball, +20 if all three are in exactly that order. **Manual operation** — the app shows the next target
and how to reach its ball; the pilot flies and confirms each drop with `H`.

### Run
```bash
python mission5.py                                  # pool simulator, drive with W/S A/D R/F X
python mission5.py --source 0 --order R-B-Y         # real camera (add --calib camera.json)
python -m sim.pole_autopilot                        # bot that only obeys the advice, 6 random layouts
```

| Key | Action |
|---|---|
| O, then R / Y / B | type the announced order (Esc cancels) — or `--order R-B-Y` |
| H | the target's ball dropped (you saw it) → next target. The referee decides; the app never moves on by itself |
| U | undo the last H |
| N | new attempt (simulator: new layout and order) |
| click on a pole | set the colour being calibrated from that spot (`Tab` picks red / yellow / blue); the minimum saturation is raised automatically until the pool floor drops out of the mask |
| C | trackbar window for that colour (hue low/high, min saturation, min brightness) |
| K | save the colours to `pole_colors.json` (loaded on start, `--colors` for another file) |
| M | colour masks inset — what the detector thinks is red / yellow / blue |
| Space, P, V, 1 2 3, G, Q | pause, screenshot, underwater effects, fullscreen, quit |

### What the screen shows
- A box per pole in its colour with the distance; the target has a thick box, `TARGET`, and a cyan cross on the ball.
  White circle = ball seen on top; `no ball?` = the top is visible but nothing sits on it.
- `ORDER B R Y` with ticks for done poles, `NEXT: BLUE`; `DIST`, `BEARING`, `BALL ±cm vs camera`.
- One command line: `DOWN 10 cm | TURN LEFT 9 deg | FORWARD`, then `FORWARD SLOWLY`, `HIT: FORWARD SLOWLY`.
- Red warning `YELLOW POLE IN THE WAY - pass it on the LEFT` — touching another pole first can drop its ball and
  lose the +20 order bonus.
- Advice when steering is not possible: `BLIND: FORWARD SLOWLY ~3 s`, `BACK UP SLOWLY ... did the ball drop?`,
  `BALL GONE? press H` (only after a push — in murky water a far ball fades and would look "gone"),
  `BACK UP ~7 s (clear of the pole)`, `TARGET LOST - TURN RIGHT`, `SEARCH: turn a full circle`, and after a
  full circle without the target `RED NOT FOUND - approach the other poles` (they stand together; red is the first
  colour the water swallows).

### How it works
- Colour = HSV ranges (red wraps around hue 0, so two masks). A pole = a tall, narrow, filled blob of that colour.
- Distance from the pole width in pixels and the known pole diameter (`--pole-diameter`), direction from its
  position, ball height from the image row of the pole top and the camera tilt (or from the pole bottom on the floor
  and `pole_h_m` when the top is out of view).
- "Glide path": with a camera pitched down, a ball at camera height is above the image. So the app keeps the ROV
  higher while far away and brings it down while closing in, ending `--aim-above` (8 cm) over the ball so the front
  of the ROV hits it. The last ~0.5 m is usually blind: a countdown from the last distance and `--slow-speed`.
- Ball check: the spot where the ball should sit is compared with the background left and right of it (a white
  ball underwater looks light blue, like the tiles, so "white" alone does not work).

### Simulator findings (`python -m sim.pole_autopilot --runs 10 ...`, bot clicks each colour first like a pilot)
| Condition | Average of 50 | Notes |
|---|---|---|
| clear water, tilt 0 / 15 / 30 | 50 / 50 / 50 | all 10 layouts in order, incl. red first and far |
| clear water, tilt 45 | 35 | from mid-depth the camera sees only ~2 m of floor: far poles are never in view |
| side current 0.03 m/s, tilt 15 / 30 | 44 / 42 | the current pushes the ROV into a *neighbouring* pole first: order bonus lost |
| turbid (`--visibility 3`) / `--effects murky`, tilt 30 | 16 / 15 | red is invisible beyond ~1–1.5 m, yellow turns green; usually stuck after the first pole |

- Red disappears first with distance (water absorbs red): from ~2.2 m in clear water it looks grey-blue. The app
  then says to approach the other poles — they stand together.
- A side current is the main risk for the order bonus: keep ≥ 0.5 m from poles that are not the target, watch the
  `POLE IN THE WAY` warning, approach the target straight (not sliding past a neighbour).
- Distances are within ~10 % (red reads ~10 % far, yellow ~10 % near: their dark / blended edges change the
  measured width), bearing within 1°, ball height within ~5 cm.

### Colour calibration at the pool (do this first, software changes are allowed after inspection)
1. Put the ROV in the water ~1–1.5 m from a pole, `Tab` to its colour, click on the middle of the pole.
2. Press `M`: the pole should be filled in the mask, nothing else. Fine-tune with `C` (raise `s_lo` if the pool
   floor shows up, widen the hue range if the far side of the pole is missing).
3. Repeat for the other colours, then `K` to save. Check again from ~2.5 m: **red fades first** (water absorbs red),
   yellow drifts towards green.

### Things to MEASURE / ASK (flags, no code change)
| Flag / value | What | How |
|---|---|---|
| `--pole-diameter` | pole diameter (default 0.05, UNCONFIRMED) | calipers / tape at the venue — every distance scales with it |
| `pole_h_m` (`vision/pole_guidance.py`), `--pole-height` (simulator) | top of the pole above the floor | the props drawing says 60 cm, the contest text "~1 m": ask the committee |
| `--aim-above` | camera height over the ball at the hit | depends on which part of the ROV should strike the ball |
| `--cam-tilt`, `--slow-speed`, `--rov-*`, `--calib` | as for Mission 3 | |
| release mechanism | does touching the pole top drop the ball, or must the ball itself be hit? | ask; the simulator assumes the ball or the top 10 cm |

### Test on land (no ROV)
Three sticks / rolled paper in red, yellow and blue, standing ~60 cm tall with a white ball (or paper ball) on top.
Run `python mission5.py --source 0 --cam-tilt 0 --order R-B-Y --pole-diameter <stick width in m>`, click each colour
to calibrate, hold the camera ~1–2 m away: `DIST` should match a tape measure within ~10–15 %, `TURN LEFT/RIGHT`
should point at the target, removing the ball should show `no ball?`.

## Tests
`pytest tests -q` (about 1–2 min; includes full autopilot runs for docking, line following and poles)
