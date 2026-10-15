# Laptop side (bridge + GUI)

```
Keyboard ─► Browser GUI ──WebSocket :8765──► Python bridge ──USB serial──► ESP32 ──► ESCs
              (webgui/)                        (bridge/)
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
(skip the 4 s arming), `-v` (log connects, serial status).

## Keys

| Key | Action |
|---|---|
| `W` / `S` | forward / back |
| `A` / `D` | yaw left / right |
| `R` / `F` | up / down |
| `J` / `K` | lower / raise magnitude (smooth) |
| `Space` (hold) | all zero, instantly |
| `Esc` | **E-STOP** (disarm). Works even while typing |

Keys are physical keys, so they work on the Russian layout too. While a text field has
focus (e.g. a number in Calibration) driving keys are paused and the status bar says so;
press Enter to leave the field. A focused slider or checkbox does not block driving.
Switching to another window or tab clears all keys; hiding the tab also disarms.

## Status bar

`Bridge` (browser ↔ bridge) · `Serial` (bridge ↔ ESP32) · `ESP` (alive = any line within
1.5 s) · `Firmware` LIVE / DRY RUN · `Ping` round trip · `Vision`, `FPS` (phase 4) · `Keys`.

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
   Exactly **one** motor must turn. Write down which. Repeat for `GPIO 42+` and `GPIO 40+`.
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

**Competition day:** at the adjustment period get SSID, password and URL, run Connect + GET
once on the vehicle at the surface and read the text to the referee. If it fails, the
`N wifi:` / `N http error` lines say why (wrong password, SSID not found, 2.4 GHz only,
connection refused = wrong IP or port). Wi-Fi draws current in bursts: if the board resets
when you press Connect (log shows a new `ROV firmware` banner), the USB supply is too weak,
see `WIFI_TX_POWER_QDBM` in `src/config.h`.

## Tests

```bash
cd host && .venv/bin/python -m pytest -q          # bridge, mock ESP32, protocol twin
cd host/webgui && node --test                      # mixer, controller, keys, calibration, Mission 1 panel
sh tests/firmware/run.sh                           # firmware parser + Mission 1 helpers (project root)
```

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
