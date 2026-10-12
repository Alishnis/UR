# ROV architecture

Status legend: **done** = in the repo and tested, *planned* = not built yet, (?) = open hardware question.

## Electrical (planned — not wired yet)

```mermaid
flowchart LR
    subgraph POOLSIDE["Pool side"]
        PB["Organiser power box<br/>12 V DC, fuse, e-stop, V/A meters"]
        LAP["Laptop<br/>(Python host apps)"]
    end
    subgraph ROV["ROV (waterproof box 200x120x75 mm)"]
        SW["Rocker switch"]
        BUCK["LM2596 buck<br/>12 V to 5 V"]
        ESP["ESP32-S3-DevKitC-1"]
        ESC1["ESC 1"] --> M1["Thruster left"]
        ESC2["ESC 2"] --> M2["Thruster right"]
        ESC3["ESC 3"] --> M3["Thruster vertical"]
        CAM["USB camera 720p"]
    end
    PB -- "12 V XT60 (tether)" --> SW
    SW --> ESC1 & ESC2 & ESC3
    SW --> BUCK -- "5 V (?)" --> ESP
    ESP -- "GPIO 4 / 5 / 6 PWM 50 Hz" --> ESC1 & ESC2 & ESC3
    ESP -- "USB-UART, 5 m cable via isolated USB port" --- LAP
    CAM -- "USB, 5 m cable (direct to the laptop or via a hub)" --- LAP
```

Notes: common ground between ESP32 and all ESC signal grounds. Open: ESC bidirectional?, ESP32 5 V from the
buck or from USB (never both without protection), motor dead zone and direction.

## Software data flow

```mermaid
flowchart TD
    SRC["Frame source<br/>USB webcam / video / 3D simulator"] --> PRE["Scale to 720p, undistort<br/>(optional underwater effects)"]
    PRE --> DET["TagDetector: tag36h11<br/>hamming 0, margin filter, solvePnP pose"]
    DET --> TRK["TagTracker<br/>confirm over N frames, remember the attempt"]
    TRK --> SEL["select_target: LARGEST / SMALLEST"]
    PRE --> LINE["LineDetector (3)<br/>black-hat darkness, collinear pieces,<br/>tape gaps"]
    LINE --> FOLLOW["LineAssistant (3)<br/>floor projection, height from line width,<br/>carrot steering, tape counter"]
    FOLLOW --> M3["Mission 3 overlay<br/>line, tapes, rails, advice, STEER bar"]
    PRE --> POLE["PoleDetector (5)<br/>HSV ranges (red wraps), pole shape,<br/>ball-on-top check"]
    CAL["pole_colors.json<br/>click / trackbar calibration"] --> POLE
    POLE --> PGUIDE["PoleAssistant (5)<br/>order R-Y-B, distance from width,<br/>glide path, blocking pole, blind push"]
    PGUIDE --> M5["Mission 5 overlay<br/>target box, ORDER / NEXT, advice"]
    SEL --> M21["Mission 2.1 overlay<br/>tags + SELECTED ID"]
    SEL --> ASSIST["DockingAssistant (2.2)<br/>row heading, hidden-target estimate,<br/>smoothing, guidance, blind countdown"]
    DET --> ASSIST
    ASSIST --> M22["Mission 2.2 overlay<br/>entrance box, LAT/VERT/YAW, advice"]
    M21 & M22 & M3 & M5 --> OP["Operator / pilot"]
    OP -- "keyboard W/S A/D R/F, ARM, E-STOP" --> GUI["Browser GUI (host/webgui)<br/>mixer L/R/V, MAX limit, ramp,<br/>Mission 2.1 panel, Mission 1 panel"]
    GUI -- "JPEG frames / JSON (ws :8766)" --> TAGSVC["Bridge AprilTag service<br/>TagDetector + TagTracker"]
    TAGSVC --> GUI
    GUI -- "D l r v / S at 20 Hz (ws :8765)" --> BRIDGE["Bridge (host/bridge)<br/>WebSocket to serial, S on disconnect"]
    BRIDGE -- "serial 115200, docs/PROTOCOL.md" --> FW["ESP32 firmware (src/main.cpp)<br/>ESC PWM, +-150 us limit,<br/>500 ms watchdog, Mission 1 Wi-Fi"]
    FW -. "planned: WiFi + HTTP GET (Mission 1)" .-> TOWER["Comms tower"]
```

| Part | Where | State |
|---|---|---|
| Tag detection, tracking, 2.1 app | `host/vision/`, `host/mission21.py` | done |
| Docking guidance, 2.2 app | `host/vision/docking.py`, `host/mission22.py` | done |
| Line detection, guidance, tape counter, Mission 3 app | `host/vision/line_*.py`, `host/vision/floor_geometry.py`, `host/mission3.py` | done |
| Pole colour detection, guidance, Mission 5 app | `host/vision/pole_*.py`, `host/mission5.py` | done |
| 3D pool simulator + autopilot check | `host/sim/` | done (docking, line following, poles) |
| Underwater image effects | `host/vision/underwater_sim.py` | done |
| Camera calibration | `host/tools/calibrate_camera.py` | done |
| Browser GUI + bridge: control, Mission 1 panel, Mission 2.1 | `host/webgui/`, `host/bridge/`, `docs/PROTOCOL.md` | done (tested with the mock ESP32) |
| Firmware (protocol, 3 ESCs, watchdog, Mission 1 Wi-Fi) | `src/main.cpp` | done; live ESC test in progress (wiring check with the GUI PIN TEST) |
