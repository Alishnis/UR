# Open hardware questions

Nothing below may be assumed. Each item has a named config value and a way to measure it.
Fill in the "Result" line when measured, with the date.

Safety for every spin test: clamp the motor, keep a hand on the power-box e-stop,
start from neutral, use the default low clamp (±150 µs).

## Q1. Are the ESCs bidirectional?

- **Config:** `ESC_BIDIRECTIONAL` in `src/config.h` (default `true`; needs a reflash).
- **Why it matters:** bidirectional: 1500 µs = stop, below = reverse. Forward-only ESCs
  stop at ~1000 µs, and for them **1500 µs would be half throttle**. Forward-only ESCs
  usually refuse to arm at 1500 µs (they keep beeping) rather than spin, but do not rely on it.
- **How to measure:**
  1. Look for a model name or label on the ESC. Search "<model> bidirectional" or "3D mode".
  2. Motor clamped, propeller area clear. Flash LIVE firmware. Connect XT60 with the
     e-stop in hand. Listen: a bidirectional ESC at 1500 µs plays its startup tones
     and then an "armed" beep. Continuous beeping = no valid neutral → disconnect, it
     is probably forward-only.
  3. If armed: in the GUI PIN TEST (phase 2), hold `+` briefly, then `−`. If the
     motor turns one way, then the other way, the ESC is bidirectional.
- **Result:** _not measured yet_

## Q2. How does the ESP32 get 5 V?

- **No config value** (wiring decision), but it must be written down.
- **Options:** (a) LM2596 buck output → ESP32 `5V` pin; (b) USB from the laptop/power box.
  **Never both at once without protection** (a diode or cutting the USB 5 V): two
  supplies fight each other and can back-feed the laptop.
- **How to measure:** before connecting the ESP32, power the LM2596 from 12 V and
  turn its screw until the multimeter (DC V) reads 5.0–5.1 V at the output.
  Then check the ESP32 `5V` pin to GND: 4.8–5.2 V. Also check the ESC red wires:
  ESCs with a BEC output 5 V on red. **Do not connect several red wires together
  or to the ESP32 5 V** unless you know the BECs can be paralleled. Only signal
  (white) and GND (black) are needed.
- **Result:** _not decided yet_

## Q3. Dead zone: smallest command at which each motor starts

- **Config:** per-thruster `deadBand` in `host/webgui/js/config.js` (phase 2, no reflash).
- **How to measure (per motor):** motor clamped, in water if possible (as it behaves
  differently in air). Use PIN TEST with a very low MAX throttle and raise it slowly
  until the motor just keeps turning. Read the µs from the telemetry bar. Then
  `deadBand = (start_us − 1500) / 500`. Example: starts at 1560 µs → 0.12.
  Measure both directions separately; use the larger value.
- **Result:** left _?_, right _?_, vert _?_

## Q4. Does each motor spin the right way?

- **Config:** per-thruster `invert` in `host/webgui/js/config.js` (phase 2, no reflash).
  Never fix direction by rewiring after the safety inspection.
- **How to measure:** THRUSTER TEST `L+` must push the ROV forward on the left side,
  `R+` forward on the right, `V+` up. If one pushes the wrong way, set its `invert: true`.
  Feel the water jet or watch a strip of paper in front of the shroud.
- **Result:** left _?_, right _?_, vert _?_

## Q5. Which pin drives which motor?

- **Config:** `ESC_PINS` in `src/config.h` (wiring) and `outputSlot` in
  `host/webgui/js/config.js` (logical mapping, no reflash).
- **How to measure:** first the `R` self-check (no motor power) proves each pin
  outputs its own signal. Then with power: PIN TEST `GPIO 1+` must spin exactly one
  motor. Write down which. Repeat for 42 and 40. Then fix `outputSlot` so that
  THRUSTER TEST `L` spins the left motor, etc.
- **Result (2026-10-21):** io1 → left, io40 → right, io42 → vert. `ESC_PINS` = {1, 40, 42}.

## Q6. One motor twitches by itself every ~2 s (seen on io40, right)

- **Code:** checked, no cause found. The firmware changes an output only on `D` / `S` or the
  watchdog; with nothing commanded every ESC gets a steady 1500 µs. Look at the hardware.
- **How to find it** (motor clamped, hand on the e-stop):
  1. GUI log: does `ROV firmware ...` repeat? The GUI warns "ESP32 restarted ..." with the
     reason. Restarts mean power: ESP32 supply, common GND, ESC red wires not on the ESP32 5 V.
  2. No restarts: the VERT bar shows `1500 us` and the self-check shows
     `right io40->io6: 1500us 50Hz ok` while the motor twitches → the pin sends clean neutral.
  3. Then it is the ESC side. A twitch every ~2 s at neutral is usually the ESC beeping through
     the motor windings because it does not see a valid signal: check that ESC's signal and
     GND wires (the re-soldered harness). Swap its signal plug with another ESC's: the twitch stays
     on the same motor → ESC / motor / its cable; it moves → the wire from io40.
  4. Same motor: its ESC's stop is off 1500 µs. In drive_test find the range where it is
     still (`n`, `[`, `]`) and put the middle into `NEUTRAL_TRIM_US` in `src/config.h`.
- **Result (2026-10-21):** no restarts; the twitch follows the right (io40) ESC/motor. Still at
  1460–1495 µs → `NEUTRAL_TRIM_US` right = −22 (1478 µs).
