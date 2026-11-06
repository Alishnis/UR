# ROV software: flow charts

Diagrams of the code as it is in this repository (firmware `src/`, bridge `host/bridge/`, vision
`host/vision/`, browser GUI `host/webgui/`). GitHub draws the Mermaid blocks below. The one-page flow chart
for the technical documentation (electrical + coding part) is
[`diagrams/rov_flow_chart.png`](diagrams/rov_flow_chart.png) (also `.svg`), made by
`python3 docs/make_flowchart_doc.py`.

Contracts: [`PROTOCOL.md`](PROTOCOL.md). How to run: [`../host/README.md`](../host/README.md).

## 0. Flow chart: electrical + coding part

```mermaid
flowchart TB
    subgraph ELEC["ELECTRICAL PART"]
        direction LR
        PB["Organiser power box<br/>12 V DC, fuse, kill switch<br/>voltmeter, ammeter"]
        CAM["USB camera 720p"]
        LAP["Laptop (ground station)<br/>keyboard, browser GUI"]
        ESP["ESP32-S3 DevKitC-1<br/>(waterproof box)"]
        ESCS["3 ESCs<br/>left: GPIO 1<br/>right: GPIO 40<br/>vertical: GPIO 42"]
        THR["3 brushless thrusters<br/>left, right, vertical"]
        TOWER["Mission 1 tower"]
        CAM -- "USB 5 m, video" --> LAP
        LAP -- "USB 5 m<br/>serial 115200 and 5 V" --> ESP
        ESP -- "PWM 50 Hz signal<br/>and common GND" --> ESCS
        PB -- "12 V DC<br/>XT60 tether" --> ESCS
        ESCS -- "3-phase" --> THR
        ESP -. "Wi-Fi 2.4 GHz" .-> TOWER
    end

    subgraph CODE["CODING PART"]
        direction TB
        START(["Start"]) --> BOOT["ESP32 boots<br/>all thrusters neutral<br/>4 s ESC arming"]
        BOOT --> RUN["Laptop: start bridge<br/>open the GUI in Chrome"]
        RUN --> ARMQ{"ARM pressed?"}
        ARMQ -- no --> STOPS["GUI sends S (stop)<br/>20 times per second"]
        ARMQ -- yes --> KEYS["read keys<br/>W/S surge, A/D yaw, R/F heave"]
        KEYS --> MIX["mixer: left = surge + yaw<br/>right = surge - yaw<br/>vert = heave<br/>speed limit, smooth ramp"]
        MIX --> SEND["send D left right vert<br/>USB serial, 20 Hz"]
        SEND --> VALID{"ESP32: valid<br/>command?"}
        VALID -- no --> IGN["ignore the line"]
        VALID -- yes --> PWM["clamp to ±150 µs, ESC trim<br/>PWM 50 Hz to the ESCs"]
        PWM --> MOVE(["thrusters move"])
        SEND -. "no command for 500 ms" .-> WD["watchdog:<br/>all thrusters stop"]
        ESTOP(["Esc key = E-STOP"]) --> WD
        CAMF["camera frame"] --> DET["vision: AprilTags,<br/>line, pole colours"]
        DET --> HINT(["hints on the video<br/>for the pilot"])
    end

    ELEC ~~~ CODE
```

## 1. System overview (hardware + software)

```mermaid
flowchart LR
    KB["Keyboard<br/>W/S A/D R/F, J/K<br/>ARM, Esc = E-STOP"] --> GUI
    CAM["USB camera 720p<br/>(5 m cable)"] -- getUserMedia --> GUI
    GUI["Browser GUI<br/>host/webgui<br/>mixer, safety, mission panels"]
    GUI -- "D / S at 20 Hz<br/>P, R, M, U, G, L<br/>WebSocket :8765" --> BR["Python bridge<br/>host/bridge<br/>command whitelist"]
    BR -- "T, N, W, R, PONG" --> GUI
    GUI -- "JPEG frames<br/>WebSocket :8766" --> VS["Vision service<br/>host/vision<br/>tags, line, colours"]
    VS -- "JSON results" --> GUI
    BR -- "USB serial 115200<br/>(5 m cable)" --> FW["ESP32-S3 firmware<br/>src/main.cpp<br/>clamp, watchdog, trim"]
    FW -- "T, N, W, R, PONG" --> BR
    FW -- "PWM 50 Hz<br/>GPIO 1 / 40 / 42" --> ESC["3 ESCs"]
    ESC --> THR["Thrusters<br/>left, right, vertical"]
    FW -. "Wi-Fi 2.4 GHz<br/>HTTP GET" .-> TOWER["Mission 1 tower"]
    PB["Power box 12 V<br/>fuse + kill switch"] --> ESC
```

## 2. Firmware: main loop (`src/main.cpp`)

```mermaid
flowchart TD
    ON([Power on / reset]) --> SETUP["setup()<br/>all 3 outputs neutral at once<br/>Serial 115200<br/>readback interrupts<br/>banner: pins, clamp, trim"]
    SETUP --> LOOP{{"loop()"}}
    LOOP --> READ["pollSerial(): read bytes into a line<br/>(max 160 chars, printable only)"]
    READ --> ARMQ{"4 s arming<br/>finished?"}
    ARMQ -- no --> DROP["drop the input"] --> M1POLL
    ARMQ -- yes --> LINE{"complete<br/>line?"}
    LINE -- no --> M1POLL
    LINE -- yes --> PARSE{"parseLine()"}
    PARSE -- "D a b c" --> DRIVE["value → 1500 ± 500·v µs<br/>clamp to 1350..1650<br/>plus per-ESC trim → LEDC pin"]
    PARSE -- "S" --> NEUT["all neutral"]
    PARSE -- "P" --> PONG["reply PONG"]
    DRIVE & NEUT & PONG --> WDREF["refresh watchdog"] --> M1POLL
    PARSE -- "M / U / G / L" --> M1["Mission 1<br/>Wi-Fi join / set URL /<br/>HTTP GET (thrusters neutral) / scan"] --> M1POLL
    PARSE -- "R" --> RB["readback report<br/>measured pulse per pin"] --> M1POLL
    PARSE -- malformed --> WARN["ignore whole line<br/>W ignored ... (≤ 1/s)"] --> M1POLL
    M1POLL["m1::poll(): Wi-Fi progress,<br/>scan results → N lines"] --> WD{"no D/S/P<br/>for 500 ms?"}
    WD -- yes --> TRIP["all neutral<br/>W watchdog (once)"] --> TEL
    WD -- no --> TEL{"200 ms since<br/>last T?"}
    TEL -- yes --> SENDT["send T us0 us1 us2"] --> NEXT
    TEL -- no --> NEXT(["next loop() pass<br/>(thousands per second)"])
```

## 3. Browser GUI: 20 Hz command loop (`host/webgui/js/app.js`)

```mermaid
flowchart TD
    TICK([every 50 ms: tick]) --> ALIVE{"ARMED and ESP32<br/>silent over 1.5 s?"}
    ALIVE -- yes --> ESTOP1["E-STOP: disarm, send S"] --> PING
    ALIVE -- no --> PING["every 1 s: send P (ping)"]
    PING --> AUTO["Mission 1 auto run step<br/>(never while ARMED)"]
    AUTO --> KEYS["held keys → surge, yaw, heave<br/>J/K magnitude"]
    KEYS --> MIX["mixer: left = surge + yaw<br/>right = surge − yaw, vert = heave<br/>invert, gain, dead band<br/>MAX throttle, ramp ≤ 1.5/s"]
    MIX --> ARMED{"ARMED?"}
    ARMED -- yes --> DLINE["send D l r v<br/>(firmware output order)"]
    ARMED -- no --> SLINE["send S"]
    DLINE & SLINE --> RENDER["render: status chips, bars,<br/>mission panels"] --> NEXTT(["next tick in 50 ms"])

    EV1(["Esc key / E-STOP button"]) --> ESTOP2["disarm, send S at once"]
    EV2(["bridge lost, serial lost,<br/>ESP32 reboot, tab hidden"]) --> ESTOP2
```

## 4. Mission 1: Wi-Fi pairing (Auto: Connect + GET)

```mermaid
flowchart TD
    START(["Press Auto (DISARMED)"]) --> SAME{"already on<br/>this SSID?"}
    SAME -- no --> JOIN["send U url, M ssid password<br/>ESP32 joins in station mode"]
    SAME -- yes --> GET
    JOIN --> JR{"N wifi: ..."}
    JR -- connected --> GET["send G<br/>ESP32 does the HTTP GET itself<br/>(thrusters neutral, ≤ 15 s)"]
    JR -- "failed / timeout" --> RETRYJ["retry the join in 3 s"] --> JOIN
    GET --> GR{"answer"}
    GR -- "N got: text" --> SHOW["text shown big<br/>Show to referee, History"]
    GR -- "http error / empty" --> RETRYG["retry the GET in 3 s"] --> GET
    GR -- "wifi not connected" --> RETRYJ
    SHOW --> KEEP{"keep fetching?"}
    KEEP -- yes --> WAIT["wait 10 s"] --> GET
    KEEP -- no --> DONE([done])
    RETRYJ & RETRYG -. "2 min without text" .-> FAIL([gave up: reason shown])
```

## 5. Camera missions: one vision frame

```mermaid
flowchart TD
    CAMF(["camera or simulator frame<br/>(video element)"]) --> READY{"mission tab uses vision<br/>and no frame in flight?"}
    READY -- no --> WAITF["wait (≤ 15 frames/s)"]
    READY -- yes --> JPEG["capture canvas → JPEG<br/>1280 px tags, 640 px line / colours"]
    JPEG --> WS["WebSocket :8766, binary:<br/>header {id, mode, params} + JPEG"]
    WS --> POOL["bridge thread pool<br/>(never blocks motor commands)"]
    POOL --> MODE{"mode"}
    MODE -- tags --> TAGS["AprilTag tag36h11<br/>raw pass, CLAHE pass if under 3 tags<br/>hamming ≤ 1, margin ≥ 10, pose"]
    MODE -- line --> LINEDET["dark line vs floor<br/>angle, offset, white tapes"]
    MODE -- colors --> COL["HSV ranges (red wraps)<br/>blobs per colour"]
    TAGS & LINEDET & COL --> RES["JSON result → GUI"]
    RES --> LOGIC{"mission logic (pure JS)"}
    LOGIC -- "2.1" --> L21["confirm id after 5 frames<br/>SELECTED: largest / smallest"]
    LOGIC -- "2.2" --> L22["distance, bearing, height<br/>TURN / UP / FORWARD"]
    LOGIC -- "3" --> L3["steering hint<br/>tape crossing → checkpoint"]
    LOGIC -- "5" --> L5["poles by colour<br/>NEXT target in the order"]
    L21 & L22 & L3 & L5 --> OVL["overlay on the video<br/>(hints only, no autopilot)"]
```

Mission 4 (object retrieval) sends no frames: hook reticle and the 3-second hold timer (`H`) only.
