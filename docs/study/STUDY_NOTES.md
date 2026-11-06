# ROV — study notes (everything connected)

One story from the pilot's finger to the propeller, then every layer in depth, the key numbers,
the missions, and the answers to the questions judges ask. Read top to bottom once, then use the
tables as a cheat sheet.

---

## 1. The whole system in one picture

```
                    POOL SIDE                                     │              ROV
                                                                  │
 Keyboard ─► Browser GUI ──WebSocket :8765──► Python bridge ──USB serial (5 m)──► ESP32-S3 ──PWM──► 3 ESCs ──3-phase──► 3 thrusters
             (mixer,        text lines        (whitelist,        115200 baud      (parser,   50 Hz             (left, right,
              safety,       D/S/P/R/M/U/G/L    origin check,                       clamp,     GPIO 1/40/42       vertical)
              missions)  ◄── T/N/W/R/PONG ───  S on disconnect)                    watchdog)
                 ▲                                                │                    ▲
 USB camera ─────┘ getUserMedia ──WebSocket :8766──► Vision service (OpenCV, pupil-apriltags)
                                  JPEG frames ◄── JSON results     │                    │
                                                                  │   Power box 12 V ──XT60──► ESC power (parallel)
                                                                  │   ESP32 power: USB from the laptop
```

**The design principle:** *the laptop thinks, the ESP32 executes and keeps it safe.* No IMU, no depth
sensor → open-loop control: the pilot drives, the camera and software give hints.

---

## 2. One key press, end to end

The pilot holds **W** (forward) while ARMED:

1. **Keyboard → GUI.** `controls.js` matches the *physical* key (`event.code`), so any layout works.
   Driving is paused while a text field has focus; `Esc` (E-STOP) always works.
2. **Axes.** Held keys become `surge = +1, yaw = 0, heave = 0`; `J`/`K` scale them (magnitude).
3. **Mixer** (`mixer.js`, three thrusters, no sideways motion):
   `left = surge + yaw`, `right = surge − yaw` (both divided by the larger if > 1), `vert = heave`;
   then per thruster **invert → gain → dead band → MAX throttle (0.30) → ramp (≤ 1.5 / s)**.
4. **Command loop** (`app.js`, every **50 ms = 20 Hz**): ARMED → `D 0.300 0.300 0.000`;
   DISARMED → `S`. Values are fractions **−1..1**, not microseconds.
5. **WebSocket :8765 → bridge** (`server.py`): checks the line (whitelist `DSPMUGRL`, one line,
   printable, ≤ 160 chars) and writes it to the serial port (`links.py`, own thread).
6. **USB serial → ESP32** (`main.cpp`): `pollSerial()` collects bytes into a line, `parseLine()`
   (`protocol.h`) validates it strictly, `handleLine()` acts on it.
7. **Value → pulse:** `valueToUs()`: `1500 + 0.3 × 500 = 1650 µs` → `clampUs()` keeps 1350–1650 →
   `+ NEUTRAL_TRIM_US` (left 0) → `usToDuty()`: 1650 µs → 1352 of 16384 → `ledcWrite()`.
8. **LEDC** outputs a 1650 µs pulse every 20 ms on GPIO 1 and GPIO 40; the watchdog timer is reset.
9. **ESC** reads the pulse width (1500 = stop, 1650 = forward), switches its three phases →
   the brushless motor spins.
10. **Feedback:** every 200 ms the ESP32 sends `T 1650 1650 1500`; the GUI draws real pulses on the
    thruster bars.

**Release W:** the GUI keeps sending `D` 20×/s, now with zeros (ramped down). The **watchdog is not
involved**; it only acts if commands stop arriving entirely.

---

## 3. Electrical part

| Part | What it is | Key facts |
|---|---|---|
| **Power box** (organiser) | 12 V DC supply | fuse, kill switch, V/A meter; we may not modify it |
| **XT60** | power connector on the tether | keyed, ~60 A |
| **ESC power** | 3 ESCs in **parallel** on one main 12 V cable | each gets full 12 V; main cable carries all 3 currents → thicker; splices insulated + waterproofed |
| **ESC** | Electronic Speed Controller | input: 12 V + PWM signal; output: 3 phase wires; **bidirectional** (1500 stop, < reverse, > forward) |
| **Brushless thruster** | 3 coils, no brushes | ESC switches coils in sequence → rotating field; swap 2 phases = reverse (we use software `invert`) |
| **ESC signal cable** | white = signal, black = GND, red = 5 V BEC | we use **signal + GND only**; red BECs left unconnected (would fight each other / the ESP32 supply) |
| **ESP32-S3 DevKitC-1 N8R8** | microcontroller, 2 cores 240 MHz, 2.4 GHz Wi-Fi, 8 MB flash + 8 MB PSRAM | **3.3 V logic** (never 5 V on a pin); UART USB port for flashing + commands |
| **Pins** | left GPIO 1, right GPIO 40, vertical GPIO 42 | self-check jumpers io1→io4, io40→io6, io42→io5 |
| **ESP32 power** | over USB from the laptop | never USB + buck converter at the same time without a diode |
| **Common ground** | all signal grounds connected | a 3.3 V signal only means something relative to a shared ground |

**Forbidden pins** (checked at compile time): strapping 0, 3, 45, 46; USB 19, 20; flash/PSRAM 26–37;
UART0 43, 44.

**Brownout:** supply voltage dips (Wi-Fi current burst, long thin cable) → the chip resets → ESC
signal drops → thrusters twitch. The boot banner prints the **reset reason**; the GUI warns on
`BROWNOUT` / `CRASH` or 3 restarts in 30 s.

**Waterproofing rules:** no exposed copper, sealed splices, sealed box and cable glands, wires clear
of propellers, tether with strain relief.

---

## 4. Signals: PWM, LEDC, arming, trim

- **Servo/ESC PWM:** a pulse every **20 ms (50 Hz)**; the **pulse width** is the command:
  1000 µs full reverse, **1500 µs stop**, 2000 µs full forward.
- **Our mapping:** `pulse = 1500 + value × 500`, **hard clamp ±150 µs → 1350–1650 µs** (~30 %
  power) in the firmware — the laptop can't bypass it.
- **LEDC** ("LED Control"): the ESP32's **hardware PWM** peripheral. `ledcAttach(pin, 50, 14)` once,
  `ledcWrite(pin, duty)` per command. 14 bits = 16384 steps per 20 ms → **≈ 1.22 µs per step**.
  `duty = µs × 16384 / 20000` (1500 → 1229). Computed in 64-bit with rounding (`usToDuty`).
- **Why not ESP32Servo:** v3.2.1 on the S3 put the 3rd servo on the 1st one's pin — one pin drove
  two motors. LEDC directly = simple and correct.
- **ESC arming:** an ESC safety routine — at power-up it won't drive the motor until it has seen a
  steady stop signal (beeps, then ready). So `setup()` outputs neutral **first**, before Serial, and
  the firmware ignores all input for **4 s**. Don't confuse with the GUI's **ARM button** (pilot's
  permission to drive).
- **Neutral trim:** real ESCs don't stop at exactly 1500. Right ESC stops at **1478 (−22)**,
  vertical at **1495 (−5)**. Trim is added *after* the clamp → each ESC still gets ±150 µs around
  *its own* stop; telemetry `T` stays untrimmed (1500 = stop), `R` shows the real pin pulse.

---

## 5. Firmware (`src/`, C++, Arduino core on the ESP32)

| File | Role |
|---|---|
| `config.h` | every setting (pins, neutral, clamp, trims, timings, Wi-Fi limits) + `static_assert` checks: a forbidden/duplicate pin or a trim > ±50 µs **fails the build** |
| `protocol.h` | command types + **strict parser** + pulse math (`valueToUs`, `clampUs`, `usToDuty`); no Arduino → tested on the laptop |
| `main.cpp` | `setup()` / `loop()`: outputs, serial line assembly, command dispatch, arming, watchdog, telemetry, readback self-check, boot banner |
| `mission1.cpp` | Wi-Fi join, HTTP GET, Wi-Fi scan |
| `mission1_text.h` | body buffer, chunked decoder, line splitting, scan list — no Arduino → tested |
| `mission1.h` | Mission 1 function declarations + hooks implemented in `main.cpp` |
| `timing.h` | wrap-safe `millis()` comparisons (signed difference) |

**`setup()`** — runs at **every** power-up/reset: neutral outputs → `Serial.begin(115200)` → readback
interrupts → banner (version, reset reason, mode, pins, clamp, trims, watchdog).

**`loop()`** — thousands of times per second, **never blocks**:
1. `pollSerial()` — bytes → line; drops lines > 160 chars or with non-printable bytes; during arming
   drops everything (and the tail of a line cut by the end of arming).
2. `m1::poll()` — Wi-Fi join / scan progress.
3. end of the 4 s arming → `ROV ready`.
4. **watchdog** — no valid `D`/`S`/`P` for **500 ms** → all neutral, one `W` line.
5. telemetry `T` every **200 ms**; `R 1` stream every 500 ms.

**Why non-blocking:** a `delay()` would stop command reading and the watchdog check. All timers are
`millis()` comparisons; Wi-Fi join and scan are started, then polled. **Only the HTTP GET blocks** —
so thrusters stop before it, and queued commands are discarded after it (`afterBlockingGet`).

**Strict parser rules:** one capital letter; `D` = exactly 3 plain decimals (no exponent/hex/nan) in
−1..1 and nothing else; any error → whole line ignored (**never half-applied**) + `W ignored …`
(≤ 1/s); bad lines don't feed the watchdog. Verified against the Python emulator on **20,000 fuzzed
lines**.

**Readback self-check (`R`):** jumper output → input; a `CHANGE` **interrupt** (in IRAM, guarded by a
critical section) measures pulse width (rise→fall) and period (rise→rise); report `ok` (±10 µs,
45–55 Hz) / `MISMATCH` / `no signal (LOW)` / `stuck HIGH`; pull-downs make an open jumper read
cleanly. Born from the ESP32Servo bug; works with ESC power unplugged.

---

## 6. Protocol cheat sheet

| Laptop → ESP32 | Meaning | | ESP32 → laptop | Meaning |
|---|---|---|---|---|
| `D a b c` | left, right, vertical, −1..1 | | `T u1 u2 u3` | pulse widths, 5 Hz |
| `S` | all stop | | `N …` | Wi-Fi / Mission 1 messages |
| `P` | ping → `PONG` | | `W …` | warnings (watchdog, ignored lines) |
| `R` / `R 1` / `R 0` | self-check once / stream / stop | | `R …` | self-check report |
| `M ssid password` | join Wi-Fi | | `PONG` | answer to `P` |
| `U url` | set URL | | `ROV …` | boot banner |
| `G` | HTTP GET (blocks, thrusters stop) | | | |
| `L` | Wi-Fi scan | | | |

Only `D`, `S`, `P` reset the watchdog.

---

## 7. Laptop software

**Bridge (`host/bridge/`, Python, asyncio):** HTTP server :8000 (the GUI), WebSocket :8765 (lines),
WebSocket :8766 (vision). Whitelist `DSPMUGRL`; **Origin check** (only our localhost page);
**`S` when the last browser disconnects** and on Ctrl+C; serial port auto-detected, reconnects every
1 s, I/O in its own thread; vision in a **2-thread pool** so it never delays motor commands
(ping < 1 ms under vision load). `--mock` = Python ESP32 emulator with the same rules.

**WebSocket:** a persistent two-way connection (unlike HTTP request/response) — needed for 20 Hz
commands one way and live telemetry the other. A browser page can't open a USB serial port, hence
the bridge.

**GUI (`host/webgui/`, plain JavaScript, no framework):**
- **ARM refused unless:** bridge connected, ESP32 alive (a line within 1.5 s), firmware finished
  arming, output mapping is a permutation of 0/1/2, no Mission 1 GET in progress.
- **Auto-disarm on:** bridge lost, serial lost, ESP32 silent 1.5 s, ESP32 reboot, tab hidden.
- **Calibration without reflashing** (allowed after the safety inspection): output mapping, invert,
  gain, dead band; saved in `localStorage`. **THRUSTER TEST** (through the mapping) and **PIN TEST**
  (raw) — hold-to-run, 5 s timeout.
- No `window.confirm()` (a modal would freeze the 20 Hz loop) → two-click confirmations; no
  Fullscreen API (it would eat `Esc` = E-STOP).

---

## 8. The missions

| Mission | Pilot does | Key algorithms | Libraries |
|---|---|---|---|
| **1 Wi-Fi (20)** | type SSID/password/URL → Scan → **Auto** → Show to referee (surface, DISARMED) | ESP32 **station mode**; non-blocking join state machine (15 s timeout, wrong-password detection via disconnect reasons); **blocking GET with thrusters stopped**, timeouts 5/5/5 s, chunked decoder, 2 KB cap; stale commands discarded; GUI auto-retry every 3 s up to 2 min | Arduino-ESP32 `WiFi`, `HTTPClient`, `WiFiClientSecure`; ESP-IDF `esp_wifi` |
| **2.1 AprilTags (40)** | press LARGEST/SMALLEST, pass the 3 tags, read `SELECTED: ID n` | tag36h11; pass 1 raw (no blur), pass 2 **CLAHE** only if < 3 tags; **≤ 1 corrected bit, margin ≥ 10, confirmed after 5 frames**; result only with exactly 3; Undo | pupil-apriltags, OpenCV |
| **2.2 Docking (20)** | target = the 2.1 tag; follow TURN → UP/DOWN → FORWARD → SLOW | pinhole camera from HFOV; **underwater FOV ÷ 1.333** (70° → 55°); **`solvePnP` IPPE_SQUARE** with the 16.2 cm tag → distance, offset, yaw; bearing `atan2(x, z)` | OpenCV, NumPy |
| **3 Line (30)** | fly along the line following YAW LEFT / ON LINE / YAW RIGHT; checkpoints counted | "darker than the local floor": brightest channel, **morphological closing** = floor estimate, relative darkness; connected components; **PCA** line fit, merge collinear pieces; tapes = non-dark gaps / bright end bands; `steer = offset + angle/45`; tape crossing a trigger row with debounce + hysteresis | OpenCV, NumPy |
| **4 Hook (40)** | align the handle with the reticle, hook, press `H`: 3 s ring → "20 pts secured" | hold-timer state machine (continuous 3 s, kept after a drop, saved at once) | browser only |
| **5 Poles (50)** | enter order `R-B-Y`, calibrate colours by clicking in the pool, hit the `NEXT` pole, press "Ball dropped" | **HSV** segmentation (red wraps around hue 0 → two masks), open/close morphology, connected components, prefer tall blobs; click calibration with **circular median hue** (same HSV formula as OpenCV); approach hint (centre ± 8 %, close at 60 % height) | OpenCV, NumPy |

**Vision pipeline:** video → hidden canvas (1280 px tags / 640 px line, colours) → JPEG → WebSocket
:8766 → Python thread pool → JSON → overlay. **One frame in flight** (≤ 15 fps), stateless detector,
mission state in the browser (`localStorage`). **Hints only — no autopilot.** Camera auto-reconnect
(0.5 s retries, restart on a 2.5 s freeze). Simulator uses the same pipeline and never touches the
saved competition state.

---

## 9. Safety — defense in depth

| Layer | Protection |
|---|---|
| Hardware | power-box fuse + kill switch; propeller guards; waterproofing |
| Firmware | neutral at boot + 4 s arming; clamp 1350–1650 µs; **500 ms watchdog**; strict parser; thrusters stop before Wi-Fi GET; DRY_RUN mode |
| Bridge | command whitelist; origin check; `S` on browser disconnect and shutdown |
| GUI | E-STOP (`Esc`); auto-disarm on any link loss / reboot / hidden tab; ramp; ARM preconditions |

**Laptop crashes** → commands stop → watchdog stops thrusters in 500 ms.
**USB pulled** → ESP32 loses power → no PWM at all → ESC signal-loss failsafe (checklist test);
kill switch as the last resort.

---

## 10. Key numbers

| Value | Number |
|---|---|
| Stop pulse / range / clamp | 1500 µs / 1000–2000 µs / **1350–1650 µs (±150, ~30 %)** |
| PWM | **50 Hz** (20 ms), 14-bit, ≈ 1.22 µs/step, duty(1500) = 1229 |
| Trims | left 0, right **−22 (1478)**, vertical **−5 (1495)** |
| Command rate (GUI → ESP32) | **20 Hz** (every 50 ms) |
| Telemetry (ESP32 → GUI) | **5 Hz** (every 200 ms) |
| Watchdog / arming | **500 ms** / **4 s** |
| ESP32 "alive" timeout in GUI | 1.5 s |
| Serial | 115200 baud, lines ≤ 160 chars |
| Ports | GUI :8000, commands :8765, vision :8766 |
| Wi-Fi timeouts | join 15 s; GET connect / answer / body 5 s each; TLS 5 s |
| AprilTag | tag36h11, 16.2 cm, ≤ 1 bit, margin ≥ 10, 5 frames |
| Vision rate | ≤ 15 frames/s, one in flight |
| Tests | 227 pytest + 241 node + 396/52/16 native firmware; parser fuzz 20,000 lines |

---

## 11. Corrections from our practice Q&A (don't repeat these mistakes)

- **50 ms is the command rate**, not telemetry. Telemetry is 200 ms.
- **`D` carries −1..1 values**; the ESP32 converts to microseconds.
- **R = up, F = down.**
- **Releasing a key ≠ watchdog.** The GUI keeps sending `D` with zeros; the watchdog is only for lost
  commands.
- **Vision runs on the laptop** (Python + browser), not in the firmware.
- **AprilTag margin is 10**, not 0.1; CLAHE is a **second pass only when < 3 tags**; also **≤ 1
  corrected bit**.
- **Arming is the ESC's own safety routine**, 4 s, not "preparing configurations".
- **`setup()` runs at every power-up/reset**, not only after upload; `Serial.begin` starts the serial
  link (the monitor is just a laptop program).
- **The 12 V goes into the ESCs**; thrusters connect to ESCs with 3 phase wires.
- Line length limit is **160**, and the real protection is the **strict parser**.
- When explaining "why", always name the **failure it prevents**.

---

## 12. Ten answers in one breath

1. **Control path:** keys → mixer → `D l r v` 20 Hz → WebSocket → bridge → USB → parse → clamp →
   trim → LEDC 50 Hz → ESC → thruster.
2. **Power:** 12 V box → XT60 → ESCs in parallel; ESP32 by USB; signal + common GND only, BEC red
   wires unconnected.
3. **Laptop crash / cable cut:** watchdog 500 ms / ESP32 off → no signal → ESC failsafe; kill switch.
4. **Why ESP32-S3:** 2.4 GHz Wi-Fi for Mission 1, hardware PWM on any pin, fast, cheap, well
   supported.
5. **Corrupted commands:** strict parser, whole-line reject, printable ≤ 160, no watchdog feed, clamp.
6. **No sensors:** open-loop; pilot + camera hints; ramp + power limit for precision.
7. **Wrong AprilTag:** ≤ 1 bit, margin ≥ 10, 5-frame confirmation, exactly 3, Undo.
8. **Line underwater:** relative darkness vs. local floor (morphological closing), PCA fit, tapes as
   gaps, steering hint, crossing counter.
9. **Arming + 1500 at boot:** ESC safety routine needs a steady stop; neutral first, input ignored 4 s.
10. **Non-blocking loop:** `millis()` timers; only the GET blocks → thrusters stopped, stale commands
    flushed.
