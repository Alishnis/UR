# How our ROV completes each mission

Mission by mission: what the rules ask, how the pilot does it with our system, which algorithms run
underneath, and which libraries we used. Written for the engineering presentation.

**Honest status:** everything below is implemented and covered by automated tests (227 Python,
241 JavaScript, 464 native firmware tests) and practised in our built-in simulator and on synthetic
camera frames. The vision thresholds still have to be calibrated in the real pool water.

---

## 0. The foundation every mission uses

### System
```
Keyboard → Browser GUI → WebSocket → Python bridge → USB serial → ESP32-S3 → PWM → 3 ESCs → 3 thrusters
USB camera → Browser GUI → WebSocket → Python vision service (OpenCV) → hints drawn on the video
```
The laptop does the thinking (control, vision); the ESP32 executes and enforces safety.

### Driving (manual, open-loop — no IMU, no depth sensor)
- Keys: `W`/`S` surge, `A`/`D` yaw, `R`/`F` heave, `J`/`K` magnitude, `Space` zero, `Esc` E-STOP.
- **Mixer** (3 thrusters: left, right, vertical; no sideways motion):
  ```
  left  = surge + yaw          right = surge − yaw        (normalised if |value| > 1)
  vert  = heave
  then per thruster: invert → gain → dead band → MAX throttle → ramp (≤ 1.5 / s)
  ```
- The GUI sends `D left right vert` **20 times per second** while ARMED, `S` while DISARMED.
- **Firmware** maps each value to a pulse `1500 + v × 500 µs`, **hard-clamps** it to 1200–1800 µs
  (60 % power), adds the per-ESC neutral trim and outputs 50 Hz PWM with the ESP32's **LEDC**
  hardware peripheral (14-bit, ~1.2 µs resolution).
- **Safety:** 500 ms watchdog in the firmware (no command → all stop), strict command parser,
  neutral at boot + 4 s ESC arming, E-STOP and auto-disarm on any link loss in the GUI, the bridge
  sends `S` when the browser disconnects.

### Vision pipeline (missions 2.1, 2.2, 3, 5)
1. The browser grabs a frame from the `<video>` element (`getUserMedia` camera, 1280×720).
2. Draws it on a hidden canvas, scaled to the width that mission needs (1280 px for tags, 640 px
   for the line and colours), encodes it as **JPEG** (quality 0.9).
3. Sends it over a **WebSocket** (port 8766) as one binary message: a small JSON header
   `{id, mode, params}` + the JPEG.
4. The Python service decodes it with OpenCV and runs the detector for that mode in a
   **thread pool** (never blocks the motor-command path).
5. Returns JSON (boxes, ids, line angle, …); the browser draws the overlay and runs the mission logic.
- **One frame in flight:** the next frame is sent only after the answer (max ~15 frames/s), so
  latency never builds up.
- **Stateless detector:** all mission state (confirmations, counters) lives in the browser and is
  saved in `localStorage`, so a page reload loses nothing.
- **Hints only:** vision never moves a thruster (Missions 3 and 4 must be piloted manually by rule).

### Libraries at a glance

| Where | Library / API | Used for |
|---|---|---|
| ESP32 firmware (C++) | Arduino core for ESP32 (PlatformIO, pioarduino) | `setup()/loop()`, Serial, timers |
| | **LEDC** (`ledcAttach`, `ledcWrite`) | hardware PWM for the 3 ESCs |
| | **WiFi**, **HTTPClient**, **WiFiClientSecure** | Mission 1: join Wi-Fi, HTTP/HTTPS GET |
| | ESP-IDF `esp_wifi` | stop a scan, Wi-Fi disconnect reason codes |
| Bridge (Python 3.12) | **websockets** | browser ↔ bridge, vision service |
| | **pyserial** | USB serial to the ESP32 |
| | **asyncio**, `http.server`, `concurrent.futures` | event loop, serving the GUI, vision thread pool |
| Vision (Python) | **OpenCV** (`opencv-python`) | image decoding, CLAHE, morphology, HSV, connected components, `solvePnP` |
| | **pupil-apriltags** | AprilTag tag36h11 detection |
| | **NumPy** | image arrays, line fitting (eigenvectors) |
| GUI (JavaScript) | no framework, plain ES modules | everything in the browser |
| | Web APIs: `getUserMedia`, Canvas 2D, WebSocket, `localStorage`, `requestVideoFrameCallback` | camera, overlay, links, saving state |
| Testing | **pytest**, **node:test**, native g++ tests | 900+ automated tests |

---

## Mission 1 — Communication Pairing (20 pts)

**Rule:** the ROV's microcontroller itself must join the tower's Wi-Fi and fetch a short text by HTTP
GET; a laptop/phone/browser doing it scores zero. SSID, password and URL are given on site.

**How we do it (at the surface, DISARMED):**
1. Type SSID, password and URL in the Mission 1 panel.
2. (Optional) **Scan** — the ESP32 lists the networks it hears, to confirm the tower is visible.
3. **Auto: Connect + GET** — one button does the rest.
4. **Show to referee** — the text full-screen with the ESP32's own IP address and signal strength.

**Algorithms:**
- **Text protocol:** `U <url>`, `M <ssid> <password>`, `G`, `L` sent from the GUI; answers come back
  as `N ...` lines (`N wifi: connected, ip …`, `N got: <text>`).
- **Non-blocking join (state machine):** Idle → Connecting → Connected / Failed. `WiFi.begin()`
  starts it; every `loop()` pass checks the status, so the watchdog keeps running. 15 s timeout.
- **Wrong-password detection:** a Wi-Fi event callback counts disconnect reasons that mean "bad key"
  (handshake timeout, auth fail); two in a row → "wrong password?".
- **Blocking GET with safety:** thrusters → neutral first; strict timeouts (5 s connect, 5 s answer,
  5 s body, 5 s TLS handshake); afterwards all serial commands that queued up are discarded (stale
  drive commands must not be applied late).
- **Body reader:** handles `Content-Length`, **chunked transfer encoding** (own incremental decoder)
  and read-until-close; 2 KB cap; non-printable bytes → `?`; one `N got:` line per text line.
- **Async Wi-Fi scan:** sorted strongest-first (insertion sort, top 15).
- **GUI auto-run (state machine):** join (skipped if already on that SSID) → wait for "connected" →
  GET → on error retry every 3 s, up to 2 min; optional "keep fetching" every 10 s; stops on ARM.

**Libraries:** Arduino-ESP32 `WiFi`, `HTTPClient`, `WiFiClientSecure`; ESP-IDF `esp_wifi`.

**Proof it was the ESP32:** the server sees `User-Agent: ESP32HTTPClient`; the referee view shows
the ESP32's IP. Our test tower `host/tools/m1_server.py` prints exactly that.

---

## Mission 2.1 — AprilTag Scanning (40 pts)

**Rule:** scan three AprilTags (family **tag36h11**, 16.2 cm), display each detection, and pick the
**largest** or **smallest** id as assigned. 10 pts per tag detected and displayed + 10 for the rule.

**How we do it:**
1. Camera tab **2.1 Tags**, press **LARGEST** or **SMALLEST** (as the referee assigned).
2. Fly slowly past the tags. Each tag gets a box and its id on the video: amber = seen, green =
   confirmed, grey dashed `ID n?` = seen but not trusted yet.
3. When exactly 3 are confirmed: big **`SELECTED: ID n (LARGEST)`** — show it to the referee.
4. A wrong tag can be removed with **Undo** (it is then ignored until Reset).

**Algorithms:**
- **AprilTag detection** (pupil-apriltags, tag36h11 family, full 1280×720 resolution):
  - **Pass 1:** grey image, no pre-blur (`quad_sigma = 0`) — finds small, far tags best.
  - **Pass 2 (only if fewer than 3 tags found):** **CLAHE** (Contrast Limited Adaptive Histogram
    Equalisation — local contrast boost for faint tags / murky water) + light blur; results merged
    by id, keeping the sighting with the higher decision margin.
- **False-ID protection** (a wrong id costs the whole mission):
  - at most **1 corrected bit** (tag36h11 codes differ in ≥ 11 bits, so 1 is still safe);
  - **decision margin ≥ 10** (detector's confidence);
  - **temporal confirmation:** an id counts only after being seen in **5 frames**;
  - weaker candidates are shown greyed (`ID n?`) but never counted.
- **Selection logic:** final answer only when exactly the expected number (3) is confirmed; more than
  3 → warning "Undo a wrong one"; the state survives a page reload.
- Tuned on hard synthetic frames (blur, noise, low contrast, small tags): recall rose from 87.6 % to
  92.7 % with zero wrong ids.

**Libraries:** pupil-apriltags (the AprilTag C library with Python bindings), OpenCV (`cvtColor`,
`createCLAHE`, JPEG decode), NumPy.

---

## Mission 2.2 — Chamber Docking (20 pts)

**Rule:** dock inside the correct chamber of a 210 × 70 × 70 cm frame (three cells marked by
AprilTags); 20 pts with no contact, 10 with contact.

**How we do it:**
1. Tab **2.2 Dock**, target tag id = the 2.1 result (**Use 2.1 result**) or typed in.
2. Follow the big hint: **`TURN LEFT/RIGHT`** → **`UP/DOWN`** → **`FORWARD`** → **`SLOW, ENTERING`**,
   with distance, bearing and height offset on screen, a crosshair and an aim ring on the video.

**Algorithms:**
- **Camera model (pinhole):** focal length from the horizontal field of view,
  `fx = fy = (width / 2) / tan(HFOV / 2)`, centre at the image middle.
- **Underwater correction:** a flat camera window refracts light, shrinking the field of view by
  about **1.333×** (refractive index of water): `HFOV_water = 2·atan(tan(HFOV_air / 2) / 1.333)` —
  70° in air ≈ 55° underwater.
- **Pose estimation:** OpenCV **`solvePnP`** (`SOLVEPNP_IPPE_SQUARE`, made for square markers) from
  the tag's 4 corners and its real size (16.2 cm) → tag position in metres (x right, y down,
  z forward), distance, and the tag's yaw (how far we are off its centre line). If the two mirror
  solutions fit almost equally, the yaw sign is flagged as unreliable.
- **Guidance rule:** bearing = `atan2(x, z)`; turn first if |bearing| > 5°, then correct height if
  |y| > 8 cm, then forward; "slow" under 1 m. An "entrance below the tag" offset can be set if the
  tag is mounted above the opening.

**Libraries:** OpenCV (`solvePnPGeneric`, `Rodrigues`), pupil-apriltags, NumPy.

---

## Mission 3 — Line Following (30 pts)

**Rule:** follow a ~1.5 m black line on the pool floor, **manually piloted**; white tapes mark the
start and every 50 cm (checkpoint 1 = 50 cm, checkpoint 2 = 100 cm, final = 150 cm).

**How we do it:**
1. Tab **3 Line**. The detected line is drawn on the video with a steering arrow.
2. Big hint: **`YAW LEFT` / `ON LINE` / `YAW RIGHT`** (or `LINE LOST · last seen LEFT`) plus a
   steering gauge, the line angle and offset.
3. A checkpoint track (start · 50 · 100 · 150 cm) counts the white tapes automatically; `−1 / +1`
   buttons correct it (the referee decides).

**Algorithms:**
- **"Darker than the floor", not "black":** underwater a black line looks blue-green and the light
  changes across the pool, so a fixed colour threshold fails. Instead:
  1. take the **brightest colour channel** (a black line is dark in all channels, the blue floor is
     bright in at least one), downscale, light Gaussian blur;
  2. **morphological closing** with a kernel wider than the line paints the line over with the
     surrounding floor → an estimate of the local floor brightness;
  3. **relative darkness** = (floor − pixel) / floor — robust to dim corners of the pool.
- **Segmentation:** threshold the darkness map (operator-tunable `darkThresh`, default 25, and ≥ 45 %
  of the darkest line-like pixels), **connected components** → candidate pieces.
- **Line fitting:** each piece is fitted with **PCA** (eigenvectors of the point covariance) → centre,
  direction, length, width; elongated pieces only; pieces that are parallel (< 12°) and on one axis
  are merged — that is one line broken by tapes. A line must also be clearly dark on average
  (≥ 3 × `darkThresh`), which rejects tile joints and shadows.
- **Two passes** (480 px and 240 px wide): the coarse pass handles a line that fills much of the
  frame when the ROV flies low.
- **Tapes:** walking along the fitted axis, a **gap that is clearly not dark** is a tape; a **bright
  band right past either end** of the line is the start or final tape.
- **Steering hint:** `steer = offset + angle / 45` (offset = line position at 75 % of the image
  height, −1..1; angle in degrees); |steer| ≤ 0.08 → `ON LINE`.
- **Checkpoint counter:** a tape counts when it crosses a trigger row (dashed line on screen) moving
  down the image; tapes are tracked frame to frame by nearest position; **1.5 s debounce** and a
  **re-arm hysteresis** prevent double counts. The start tape counts as tape 1.

**Libraries:** OpenCV (`resize`, `GaussianBlur`, `morphologyEx` close/open,
`connectedComponentsWithStats`, `remap`), NumPy (covariance, eigenvectors).

---

## Mission 4 — Object Retrieval (40 pts)

**Rule:** hook the object (black U handle) from the floor, **manually piloted**; holding it clear of
the ground for **3 continuous seconds** = 20 pts (kept even if dropped later); bringing it back
across the start baseline = 40 pts.

**How we do it:**
1. Tab **4 Hook** — no vision processing (saves CPU): a **hook reticle** is placed once by clicking
   where the hook appears in the camera image, so the pilot can line the handle up with it.
2. When the object is hooked and lifted, press **`H`** (or the button) — a ring timer runs to 3.0 s
   and turns into **"20 pts secured ✓"**.
3. Fly back to the start area.

**Algorithms:**
- **Hold timer (state machine):** start/stop, continuous-hold measurement, best hold; "secured" stays
  true after one continuous 3 s hold (matches the drop rule); saved immediately so a page reload
  can't lose it.
- **Attempt clock:** 20:00 countdown on the video HUD (wall-clock based, survives reloads).

**Libraries:** none beyond the browser (Canvas for the reticle and ring).

---

## Mission 5 — Pole Colour Recognition and Hitting (50 pts)

**Rule:** red, yellow and blue poles with a golf ball on top; the referee gives an order like
`R-B-Y`; 10 pts per ball dropped, +20 if all three in the exact order.

**How we do it:**
1. Tab **5 Poles**, type the order (`R-B-Y`, `rby`, `red blue yellow` all work) → **Set**.
2. **Calibrate colours in the pool** once: pick a colour, **click on the pole** in the video
   (Shift+click widens the range), optional mask preview; export/import to a file.
3. The video labels each pole; the **next target** gets a thick pulsing frame and **`NEXT: BLUE`**
   with a hint (`YAW LEFT/RIGHT`, `FORWARD`, `CLOSE: hit it`).
4. After the ball drops, press **Ball dropped ✓** — the next colour in the order becomes the target.

**Algorithms:**
- **Water-colour balance first** (the answer to "red looks like another colour under water"):
  water absorbs red light ~35× faster than blue and puts a blue-green veil in front of everything,
  so in the raw camera picture a red pole turns brown → magenta → blue-grey as the distance grows.
  The detector measures the water colour in every row of the picture (the median: the poles are thin,
  most of each row is water) and scales B, G, R so the water becomes neutral grey. Measured on a
  physics-based simulator (144 pool conditions): red stays red (hue 2–9) out to 3 m, and a pole is
  never reported as another colour. Details and numbers: `docs/MISSION5_COLOURS_UNDERWATER.md`.
- **HSV colour segmentation:** HSV separates colour (hue) from brightness, so it copes with changing
  light better than RGB. Per colour: `inRange` on hue, saturation and value, on the balanced picture.
  - **Red wraps around hue 0/180** in OpenCV's 0–179 hue scale → two masks combined.
  - **Red stops at hue 8 and needs V ≥ 130:** grey / black things close to the camera turn orange
    after the balance (less blue water in front of them than the background); this keeps them out.
- **Cleaning:** downscale to ≤ 640 px, 3×3 Gaussian blur, **morphological opening** (3×3, removes
  speckles) then **closing** (5×5, fills glare holes), **connected components** → blobs with box,
  area, aspect ratio (height/width) and fill ratio; tiny blobs dropped (< 0.08 % of the image).
- **Pole choice:** per colour the best blob by area, preferring tall shapes (aspect ≥ 1.2) — a pole
  is tall and narrow.
- **Click-to-calibrate:** reads a 9×9 pixel patch from the current frame, applies the detector's
  latest balance gains, converts RGB → HSV with the **same integer formula as OpenCV** (checked
  against a 191-colour OpenCV table), and **widens the default range just enough** to include the
  pole (circular median hue ± 3, 85 % of its saturation and brightness). It never narrows
  the defaults: one click at one distance cannot know how much paler the pole gets further away.
- **Approach hint:** horizontal offset of the target's centre → turn until within 8 % of centre;
  "close" when the pole's box fills ≥ 60 % of the image height.
- **Order logic:** order parsing and validation (must be a permutation of R, Y, B), next target,
  undo, reset; saved across reloads.

**Libraries:** OpenCV (`cvtColor` BGR→HSV, `inRange`, `morphologyEx`, `connectedComponentsWithStats`),
NumPy; colour sampling in plain JavaScript.

---

## Extras that help every mission

- **Simulator / test scene:** a 3D-ish practice pool drawn in the browser and fed through the *same*
  detection pipeline as the real camera; driven by the same keys, even DISARMED. It never touches the
  saved competition state.
- **Camera auto-reconnect:** the 5 m USB cable can glitch — the GUI retries the same camera every
  0.5 s and restarts it if the picture freezes for 2.5 s.
- **Status chips:** Vision (detector time in ms) and FPS (camera frames / detections per second).
- **Calibration without reflashing** (allowed after the safety inspection): thruster mapping, invert,
  gain, dead band, colour ranges, detector thresholds — all in the GUI.

---

## Likely judge questions about the missions

| Question | Short answer |
|---|---|
| Why AprilTags with pupil-apriltags and not your own detector? | It's the reference AprilTag library: proven, fast (~20 ms per 720p frame), with built-in error correction. |
| How do you avoid a wrong tag id? | ≤ 1 corrected bit, decision margin ≥ 10, 5-frame confirmation, Undo button. |
| Why CLAHE? | Local contrast boost: faint tags in murky water get a higher decision margin. We only run it when needed. |
| How do you know the distance to the tag? | `solvePnP` with the known tag size (16.2 cm) and a camera model from the field of view, corrected for water (÷ 1.333). |
| Why not detect "black" for the line? | Underwater black isn't black; we detect "darker than the local floor", which is robust to colour and lighting changes. |
| How are checkpoints counted? | White tapes are gaps or bright end bands on the line; one counts when it crosses a trigger row, with debounce and hysteresis. |
| Why HSV? | Hue is separate from brightness, so colours are stable under changing light. Red needs two ranges because its hue wraps around 0. |
| Why calibrate colours in the pool? | Water absorbs red first and adds a blue-green tint; values measured in air don't match. |
| Is any mission autonomous? | No. All guidance is visual hints; the pilot always drives (required for Missions 3 and 4). |
| How did you test vision without a pool? | Synthetic frames with noise, blur, haze and uneven light (pytest), plus the built-in simulator. |
| How does the vision not disturb driving? | Separate WebSocket and a thread pool; one frame in flight; tested that motor commands stay sub-millisecond under vision load. |
