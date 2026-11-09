# Disrover ROV: control software

Software for **Disrover**, the mini underwater ROV of Team 8 (CityUHK Underwater Robotics, Fall
Training 2026): ESP32-S3 firmware, a laptop bridge, and a browser GUI with camera vision for the
contest missions.

```
Keyboard ─► Browser GUI ──WebSocket :8765──► Python bridge ──USB serial──► ESP32-S3 ──50 Hz PWM──► 3 ESCs ─► 3 thrusters
USB camera ─► Browser GUI ──WebSocket :8766──► vision service (OpenCV, AprilTags)       (Wi-Fi: Mission 1)
```

| Mission | What the software does |
|---|---|
| **1** Communication pairing | the **ESP32 itself** joins the tower Wi-Fi and fetches the text over HTTP |
| **2.1** AprilTag scan | detects tag36h11 tags, confirms IDs over 5 frames, picks the largest or smallest |
| **2.2** Chamber docking | distance, bearing and a "TURN LEFT / RIGHT" hint from the target tag |
| **3** Line following | finds the black line and tape checkpoints, steering hint |
| **4** Object retrieval | hook reticle and the 3-second hold timer |
| **5** Pole colours | HSV colour detection, the referee's order, "NEXT: RED" hint |

Safety is built in at every level: 4 s ESC arming at boot, the GUI sends Stop until ARM is pressed,
the firmware clamps pulses to **1350 to 1650 µs**, a **500 ms watchdog** stops the thrusters if
commands stop, and `Esc` is an instant E-STOP.

## Repository layout

| Path | Contents |
|---|---|
| `src/` | firmware (C++, Arduino, PlatformIO): `main.cpp`, `protocol.h`, `mission1.cpp`, `config.h` |
| `platformio.ini` | firmware build configuration |
| `host/bridge/` | Python bridge: browser WebSocket to ESP32 serial, plus the fake ESP32 (`--mock`) |
| `host/vision/` | OpenCV detectors: AprilTags, line, colours |
| `host/webgui/` | the browser GUI (plain JavaScript, no build step) |
| `host/tools/m1_server.py` | stand-in for the Mission 1 tower, for desk tests |
| `host/tests/`, `host/webgui/tests/`, `tests/firmware/` | automated tests (Python, JavaScript, C++) |
| `docs/` | protocol, architecture, mission explanations, hardware checklist; `docs/study/` has presentation prep |

## Supported systems

Windows 10/11, macOS and Linux. The tests run on all three in GitHub Actions (see `.github/workflows/ci.yml`).
You need **Python 3.12** (3.10 to 3.12 work), **Chrome**, and for the firmware **PlatformIO**.
Node.js 18+ is only needed to run the GUI tests.

## 1. Try it without any hardware (2 minutes)

This starts the GUI with a simulated ESP32 and a built-in camera simulator, so you can learn
everything before touching the robot.

**macOS / Linux**

```bash
git clone https://github.com/Alishnis/UR.git && cd UR
git checkout rov-software-v2
cd host
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m bridge --mock
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/Alishnis/UR.git; cd UR
git checkout rov-software-v2
cd host
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m bridge --mock
```

If PowerShell refuses to run `Activate.ps1`, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.
In `cmd.exe` use `.venv\Scripts\activate.bat`.

Open <http://localhost:8000/> in Chrome (always `localhost`, not `127.0.0.1`: saved calibration
belongs to the address). In the **Camera** panel choose **Test scene (simulator)** and press **Start**.
Press **Ctrl+C** in the terminal to stop the bridge.

Every new terminal needs the `activate` line again; the prompt then starts with `(.venv)`.

## 2. Flash the firmware to the ESP32-S3

Board: **ESP32-S3-DevKitC-1 N8R8**. Wiring (details in `docs/ESP32_AND_ELECTRONICS_EXPLAINED.md`
and `docs/HARDWARE_QUESTIONS.md`):

| Thruster | ESP32 pin | Self-check jumper (optional) |
|---|---|---|
| left | GPIO 1 | IO1 to IO4 |
| right | GPIO 40 | IO40 to IO6 |
| vertical | GPIO 42 | IO42 to IO5 |

Each ESC: signal wire to its pin, ESC ground to ESP32 GND, **ESC 5 V (BEC red wire) left
unconnected**. The ESP32 is powered from the laptop over USB. The 12 V supply goes to the ESCs only.

Install PlatformIO once (Python is enough):

```bash
pip install platformio
```

Then, in the **project root** (the folder with `platformio.ini`), with the **bridge stopped**
(only one program can hold the serial port):

```bash
pio run -t upload
```

The first build downloads the ESP32 toolchain (about 1 GB, once). If PlatformIO cannot find the
board, plug the cable into the other USB port of the board, or hold **BOOT**, tap **RST**,
release **BOOT**, and upload again. To watch the firmware's own messages:

```bash
pio device monitor
```

Close the monitor before starting the bridge. Windows: if the board does not appear as a COM port
in Device Manager, install the CP210x (or CH34x) USB driver for your board's UART chip. A data
cable is required (charge-only cables show nothing).

Build without uploading: `pio run`. Firmware constants (pins, limits, trim) are in `src/config.h`.

## 3. Drive the real robot

1. Plug in the ESP32 by USB. Start the bridge with the virtual environment active:

   ```bash
   cd host
   python -m bridge
   ```

   The port is found automatically. To force one: `--port COM5` (Windows), `--port /dev/cu.usbmodemXXXX`
   (macOS) or `--port /dev/ttyACM0` (Linux).
2. Open <http://localhost:8000/>. Wait for the status bar to show **ESP: alive** and **Firmware: LIVE**.
3. Do the thruster test and the pre-dive checklist once (`host/README.md`, "Thruster test procedure"
   and "Pre-dive checklist"). **Motor clamped, propeller area clear, hand on the power-box emergency switch.**
4. Press **ARM**. ARM is refused unless the bridge, the ESP32 and the 4 s arming wait are all fine.
5. Drive:

| Key | Action |
|---|---|
| `W` / `S` | forward / back: each press = one power level up / down (7 levels), **the level stays** after release |
| `A` / `D` | yaw left / right (same) |
| `R` / `F` | up / down (same) |
| `J` / `K` | lower / raise magnitude |
| `Space` | all zero at once |
| `Esc` | **E-STOP** (works even while typing) |

The Drive panel also has an **on-screen pad with the same six directions** (Forward, Back, Left,
Right, Up, Down; Left / Right turn the ROV). Press and hold a button like its key; it shows the level
as a gauge with its level (e.g. `3/7`). Below it, **Left / Right / Up thruster** buttons drive one
thruster alone (buttons only, no keyboard key; the **Reverse** toggle makes them push backwards). Per-thruster bars, thruster and pin tests, self-check and calibration are in the collapsed
**Diagnostics** section.

This is the default **Throttle mode** (Drive panel > Drive mode): like a throttle lever, a key press moves
the level one step (of 7) and it stays. Choose **Hold** there for the old behaviour (full only while the key is pressed).
Levels are reset by Space, Esc, DISARM, losing window focus and hiding the tab.

Useful bridge options: `--mock` (fake ESP32), `-v` (verbose), `--no-vision` (no camera service),
`--http-port`, `--ws-port`, `--vision-port` (if a port is taken).

## 4. Camera and missions 2 to 5

In the **Camera** panel choose the USB camera and press **Start**, then pick the mission tab:
`2.1 Tags`, `2.2 Dock`, `3 Line`, `4 Hook`, `5 Poles`. On the `Drive` tab set the camera's horizontal
field of view and tick **Underwater** (water narrows the view by about 1.33). Pole colours are judged
after a water-colour balance, so the defaults should work in the pool. Check that each pole gets its
own box at 1–3 m, and calibrate (click the pole) only if one is missed. All tabs are explained in
`host/README.md` ("Camera and missions 2-5"). The **Test scene (simulator)** source lets you
practise every mission on land.

Vision needs `opencv-python`, `numpy` and `pupil-apriltags` (installed by `requirements.txt`). If
they are missing the bridge still drives the robot, and its console says `Vision:     UNAVAILABLE: <reason>`.

## 5. Mission 1: Wi-Fi pairing

The organisers give the **SSID**, **password** and the **server URL** (`http://<server IP>:<port>/`).
Do this at the surface, with the robot **DISARMED**, and keep the dry box above the water (Wi-Fi does
not go through water). The ESP32 supports **2.4 GHz only**.

1. Start the bridge (section 3) and open the GUI.
2. In the **Mission 1** panel press **Scan** and click the tower's network (fills in the SSID).
3. Type the password and the URL, then press **Auto: Connect + GET**. It joins, fetches the text and
   retries by itself for up to 2 minutes.
4. Press **Show to referee**: the text appears full-screen with the ESP32's own IP address as proof.

**Desk test with your own "tower"** (needs a 2.4 GHz network that both the laptop and the ESP32 can join;
a phone hotspot works, with a name without spaces; on iPhone enable "Maximise Compatibility"):

```bash
cd host
python -m tools.m1_server
```

It prints the URL to type into the GUI and logs every request. The log must show
`UA='ESP32HTTPClient' -> ESP32`, which proves the ESP32 (not the laptop) fetched the text.
Campus and public Wi-Fi often block traffic between two devices; then the GET times out after 5 s.
Use a phone hotspot for this test.

`python -m bridge --mock` simulates a tower too: SSID `UR_Field`, password `12345678`, any URL.

## 6. Tests

```bash
# Python: bridge, fake ESP32, protocol twin, vision (from host/, venv active)
python -m pytest -q

# JavaScript: mixer, controller, Mission 1, camera missions (from host/webgui/, Node 18+)
node --test

# Firmware logic compiled natively (from the project root, needs g++ or clang++)
python tests/firmware/run.py

# Firmware build for the real chip (project root)
pio run

# Mission 5 colours: the full underwater sweep, 144 pool conditions (from host/, ~2 min)
python -m tools.colors_bench
```

The firmware parser is also compared with its Python twin on 20,000 random lines, so the fake
ESP32 and the real firmware cannot drift apart. On Windows the C++ tests need MinGW-w64 `g++`
(for example from MSYS2) on `PATH`; without a compiler those two comparison tests are skipped.

## 7. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `No ESP32 serial port found` | charge-only cable, wrong port of the board, or a missing USB driver (Windows). Try the other USB port; check Device Manager (Windows) or `ls /dev/cu.*` (macOS) |
| `Cannot start: ... address already in use` | another bridge is running; stop it, or use `--http-port` / `--ws-port` |
| serial "busy" / access denied | the PlatformIO monitor or an upload holds the port; close it |
| GUI says the bridge is not connected | the bridge is not running, or you opened the page by file; use <http://localhost:8000/> |
| the GUI works but the robot "does not exist" | the bridge was started with `--mock`; restart it without `--mock` |
| thruster spins by itself at neutral | ESC stop point drifted; adjust `NEUTRAL_TRIM_US` in `src/config.h` and reflash |
| Mission 1: `SSID not found` | tower off, too far, 5 GHz only, or a typo (case matters); use **Scan** |
| Mission 1: `wrong password?` | wrong password, or one that is not 8 to 63 characters |
| Mission 1: GET fails after about 5 s | wrong IP or port, server off, or the Wi-Fi blocks device-to-device traffic. An instant error means the address answers but nothing listens on that port |
| SSID with spaces rejected | the protocol cannot send spaces; rename the hotspot |
| camera stream drops when the cable is touched | the GUI reconnects by itself; the 5 m USB cable is at the limit of the USB 2.0 spec |
| bridge console says `Vision: UNAVAILABLE` | `pip install -r requirements.txt` in the active virtual environment |

## 8. Documentation

| File | About |
|---|---|
| `host/README.md` | GUI, calibration, camera missions, checklists (the full manual) |
| `docs/PROTOCOL.md` | the serial and WebSocket text protocol |
| `docs/ARCHITECTURE.md`, `docs/diagrams/` | block diagrams and the Electrical and Coding flow chart |
| `docs/HARDWARE_QUESTIONS.md` | open hardware facts and how to measure them |
| `docs/MISSIONS_EXPLAINED.md` | how each mission works and which algorithms and libraries it uses |
| `docs/MISSION5_COLOURS_UNDERWATER.md` | why red changes colour under water, how the detector copes, measured results, pool test plan |
| `docs/study/` | presentation preparation: study notes, judge Q&A, electronics explained (partly in Russian) |
| `docs/screenshots/` | vision modes running on the built-in test scene |
