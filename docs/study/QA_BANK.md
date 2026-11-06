# Presentation Q&A bank — software and electrical

Questions judges are likely to ask, with answers you can say in 20–40 seconds. The answers match
our actual code and numbers. Practise saying them in your own words; don't memorise word for word.

Sections: [Overview](#1-overview) · [Electrical](#2-electrical) ·
[Signals: PWM, LEDC, ESC](#3-signals-pwm-ledc-esc) · [Firmware](#4-firmware) ·
[Protocol and reliability](#5-protocol-and-reliability) · [Safety](#6-safety) ·
[Laptop software](#7-laptop-software) · [Computer vision](#8-computer-vision-opencv) ·
[Missions](#9-missions) · [Testing](#10-testing) · [Design choices and improvements](#11-design-choices-limitations-improvements)

---

## 1. Overview

**Q: Give us an overview of your control system.**
A: The laptop thinks and the ESP32 executes. The pilot drives with the keyboard in our browser GUI. The GUI mixes the keys into three thruster values and sends them 20 times per second over a WebSocket to a Python bridge, which forwards them over USB serial to the ESP32. The ESP32 converts each value into a PWM pulse for the three ESCs, and enforces the safety limits itself. A USB camera feeds our vision software on the laptop, which draws hints on the video for the pilot.

**Q: What happens from a key press to a thruster spinning?**
A: The key becomes an axis value; the mixer computes left, right and vertical, with invert, gain, dead band, a power limit and a smooth ramp. The GUI sends `D left right vert`, values from −1 to 1, over the WebSocket to the bridge and then over USB to the ESP32. The ESP32 parses it strictly, converts each value to `1500 + 500 × value` microseconds, clamps it to 1350–1650, adds that ESC's trim, and the LEDC hardware outputs it as a 50 Hz PWM pulse. The ESC turns that into three-phase power for the motor.

**Q: How many thrusters do you have, and how do you move?**
A: Three: left and right horizontal thrusters for forward/back and turning, and one vertical thruster for up and down. There's no sideways motion. Forward is both horizontal thrusters together, turning is them in opposite directions: left = surge + yaw, right = surge − yaw.

**Q: Which parts did you write yourselves?**
A: All the software: the ESP32 firmware in C++, the Python bridge and vision service, and the browser GUI in JavaScript. We use standard libraries: the Arduino core for the ESP32, OpenCV, pupil-apriltags, websockets and pyserial.

---

## 2. Electrical

**Q: How are the thrusters powered?**
A: The organisers' power box gives 12 V DC, with a fuse and a kill switch, through an XT60 connector on the tether. The power wires of all three ESCs are soldered in parallel to one main cable, so each gets the full 12 V. Each thruster connects to its ESC with three phase wires.

**Q: Why is the main power cable thicker?**
A: It carries the current of all three thrusters at once. A thin wire has more resistance and heats up, so the shared cable must handle the sum of the currents.

**Q: How is the ESP32 connected to the ESCs?**
A: Only two wires per ESC: signal and ground. The signals are on GPIO 1 (left), 40 (right) and 42 (vertical). All grounds are common.

**Q: Why do you need a common ground?**
A: A voltage is always measured relative to something. Our 3.3 V signal means "high" only relative to the ESP32's ground. If the ESC's ground isn't connected to it, the ESC can't tell high from low reliably.

**Q: Why don't you connect the red wire of the ESC signal cable?**
A: The red wire is the ESC's BEC, a built-in 5 V output. Three BECs connected together, or to the ESP32's own supply, would fight each other and could damage something. We only need the signal and ground.

**Q: How is the ESP32 powered?**
A: Over the USB cable from the laptop, the same cable that carries the commands. We never connect a second 5 V source at the same time, because two supplies would fight and could back-feed the laptop's USB port.

**Q: What is a brownout, and how do you deal with it?**
A: A brownout is when the supply voltage dips, for example from a current spike when Wi-Fi starts or through a long thin cable, and the chip resets. A reset cuts the ESC signal for a moment, so the motors twitch. Our firmware prints the reset reason at start-up, and the GUI warns if it sees a brownout or several restarts in a row.

**Q: What is an ESC and why do you need one?**
A: An Electronic Speed Controller drives a brushless motor. A brushless motor has three coils and no brushes, so something must switch current through the coils in the right sequence to make it rotate. The ESC does that from 12 V DC, following our PWM signal for speed and direction.

**Q: Why brushless motors?**
A: They have no brushes to wear out, they're efficient, and they work underwater.

**Q: How do you reverse a motor that spins the wrong way?**
A: Physically, swapping any two of the three phase wires reverses it. We don't rewire, though: there's an `invert` setting per thruster in the GUI.

**Q: Which pins can't you use on the ESP32-S3?**
A: The strapping pins 0, 3, 45 and 46, because their level at start-up selects the boot mode; 19 and 20, the USB lines; 26 to 37, used by the flash and PSRAM memory; and 43 and 44, our serial port. Our config has a compile-time check, so the firmware won't even build with a forbidden pin.

**Q: What logic voltage does the ESP32 use?**
A: 3.3 V. You must never put 5 V on a pin. The ESCs accept 3.3 V signals, so we connect them directly.

**Q: How did you waterproof the electronics?**
A: The electronics are in a sealed box with sealed cable glands. Every underwater splice is insulated and waterproofed, there's no exposed copper, wires are fastened away from the propellers, and the tether has strain relief, as the rules require.

**Q: What does the fuse protect against?**
A: A short circuit or overload. If too much current flows, the fuse breaks the circuit before wires or components overheat.

---

## 3. Signals: PWM, LEDC, ESC

**Q: What signal does an ESC take?**
A: A servo-style PWM signal: one pulse every 20 milliseconds, so 50 Hz. The pulse width is the command: 1500 microseconds is stop, more is forward, less is reverse, roughly 1000 to 2000.

**Q: What's the difference between PWM and LEDC?**
A: PWM is the type of signal. LEDC is the hardware block inside the ESP32 that generates it. We configure LEDC once, and it produces steady pulses by itself, so the processor is free for other work.

**Q: What resolution does your PWM have?**
A: 14 bits: each 20 ms period is divided into 16,384 steps, so one step is about 1.22 microseconds. 1500 microseconds is 1229 steps.

**Q: What is a duty cycle?**
A: The fraction of time the signal is high. A 1500 µs pulse in a 20 ms period is 7.5% duty.

**Q: Why 50 Hz?**
A: It's the standard frame rate for servo and ESC signals, and every ESC understands it.

**Q: Why didn't you use the ESP32Servo library?**
A: On the ESP32-S3 its version 3.2.1 mapped the third servo onto the first one's output, so one pin drove two motors and one drove none. We spent a long time suspecting the wiring. Using LEDC directly is simple and predictable.

**Q: What is ESC arming?**
A: A safety routine inside each ESC. At power-up it won't drive the motor until it has seen a steady stop signal, then it beeps and is ready. That prevents a propeller from starting by surprise.

**Q: Why does your firmware send 1500 µs and wait 4 seconds at start-up?**
A: Because the ESCs need a steady neutral signal to arm. Outputting neutral is the very first thing in `setup()`, even before serial starts, and for 4 seconds the firmware ignores all commands so nothing disturbs the arming. Only then does it report "ready" and the GUI allows ARM.

**Q: Is the ESC arming the same as your ARM button?**
A: No. ESC arming happens in the ESC hardware at power-up. Our ARM button is the pilot's permission to drive, and it's only allowed once the firmware is ready.

**Q: What is the neutral trim?**
A: Real ESCs don't stop at exactly 1500 µs. Our right ESC stops at 1478 and the vertical one at 1495, so the motor would creep at 1500. We add a per-ESC correction, −22 and −5 µs, to every pulse. It's applied after the clamp, so each thruster still gets ±150 µs around its own stop: no power is lost.

**Q: How did you find the trim values?**
A: We sent pulses around 1500 µs in small steps and noted the range where the motor stays still, then took the middle of that range.

**Q: Why do you limit pulses to 1350–1650 µs?**
A: That's ±150 µs, about 30% power, for safety during testing: less current, no fuse trips or brownouts, safer bench tests, and finer control without sensors. It's enforced in the firmware, so nothing from the laptop can exceed it. It's one constant, and we'll raise it after pool tests if we need more speed.

---

## 4. Firmware

**Q: What does your firmware do?**
A: It outputs neutral at start-up and waits 4 s for the ESCs to arm. Then it reads text commands from the laptop, checks them strictly, and drives the three ESCs through LEDC with a hard power limit. It runs a 500 ms watchdog, sends telemetry, can self-check its output pins, and does the Wi-Fi part of Mission 1.

**Q: What's the difference between `setup()` and `loop()`?**
A: `setup()` runs once at every power-up or reset: neutral outputs, start serial, set up the self-check, print a status banner. `loop()` then runs forever, thousands of times per second: read commands, check Wi-Fi progress, end the arming hold, check the watchdog, send telemetry.

**Q: Why must your loop never block?**
A: If it waited, for example with `delay()`, it would stop reading commands and stop checking the watchdog, so a lost connection couldn't stop the thrusters. All our timers compare `millis()` timestamps instead. Wi-Fi joining and scanning are started and then polled. The only blocking step is the Mission 1 HTTP GET, so the thrusters are stopped before it.

**Q: How is your firmware organised?**
A: `config.h` holds every setting, with compile-time checks. `protocol.h` is the command parser and pulse math. `main.cpp` has `setup()`, `loop()`, the outputs, the watchdog, telemetry and the self-check. `mission1.cpp` does Wi-Fi and HTTP. `protocol.h` and the text helpers have no Arduino code, so we can unit-test them on the laptop.

**Q: What is the watchdog?**
A: A safety timer. Every valid drive, stop or ping command resets it. If none arrives for 500 ms, the firmware stops all thrusters by itself and sends one warning. Garbage lines don't reset it.

**Q: Why 500 ms?**
A: The GUI sends a command every 50 ms, so 500 ms is ten missed commands in a row: long enough to ignore a late message, short enough that the ROV can't run away.

**Q: How does the pin self-check work?**
A: Each output pin is wired with a jumper to a spare input pin. An interrupt on the input measures the real pulse width and period. One command compares that with what we're sending and reports ok, mismatch or no signal. We built it after the ESP32Servo bug, to prove every pin outputs its own correct signal without a multimeter.

**Q: What is an interrupt?**
A: The hardware pauses the main program for a few microseconds to run a tiny function when something happens, here a signal edge on a pin. It gives exact timing. The function must be short; it's placed in fast internal RAM and protected with a critical section so the main code never reads half-updated data.

**Q: What is DRY_RUN?**
A: A firmware setting that holds the ESC pins low, so no pulses are sent and no motor can spin, while everything else works. We use it to test safely.

**Q: Why is `millis()` overflow a problem and how do you handle it?**
A: `millis()` is a 32-bit counter that wraps to zero after about 49 days, and a timestamp taken slightly later than "now" can make a naive subtraction huge. We compare the signed difference, which stays correct in both cases. It's unit-tested.

---

## 5. Protocol and reliability

**Q: What does your communication protocol look like?**
A: Plain text lines at 115200 baud. The first letter is the command: D drive with three values, S stop, P ping, R self-check, M join Wi-Fi, U set URL, G HTTP GET, L scan. The ESP32 answers with T telemetry, N network messages, W warnings and PONG.

**Q: Why a text protocol and not binary?**
A: It's easy to debug: we can type commands in a serial monitor and read the answers. At 20 commands per second it's far below the link's capacity, so efficiency doesn't matter.

**Q: Is 115200 baud enough?**
A: Yes, by a wide margin. A drive command is about 20 characters, 20 times per second, so about 400 bytes per second, against roughly 11,500 the link can carry.

**Q: How do you protect against corrupted commands over the 5 m cable?**
A: The parser is strict: a drive command must have exactly three plain decimal numbers between −1 and 1 and nothing else, only printable text, at most 160 characters. Anything wrong and the whole line is ignored, never half-applied. Bad lines don't reset the watchdog, and every valid value is still clamped. We tested it with 20,000 random and corrupted lines.

**Q: What happens if the laptop sends `D 2 0 0`?**
A: It's rejected as a whole, because 2 is outside −1 to 1, and the firmware replies with a warning. Even `D 1 1 1` only gives 1650 µs because of the clamp.

**Q: What happens to commands sent while the ESP32 is busy with the HTTP GET?**
A: They're thrown away afterwards. They're stale; applying an old drive command seconds late would be dangerous.

---

## 6. Safety

**Q: What happens if the laptop crashes?**
A: The commands stop arriving, and within 500 ms the ESP32's watchdog stops all thrusters.

**Q: What if the USB cable is unplugged?**
A: The ESP32 is powered over that cable, so it switches off and there's no PWM signal at all. The ESCs stop on signal loss; that's a test on our pre-dive checklist. The kill switch on the power box is the last resort.

**Q: What if the ESP32 restarts?**
A: It boots straight into neutral, and the GUI sees the restart and disarms. The reset reason is shown, so we can tell if it was a power problem.

**Q: Summarise your safety design.**
A: Defense in depth. Hardware: fuse, kill switch, propeller guards. Firmware: neutral at boot, 4 s arming, hard clamp, watchdog, strict parser, thrusters stopped before Wi-Fi requests. Bridge: command whitelist, stop when the browser disconnects. GUI: E-STOP on the Esc key, automatic disarm on any link loss, smooth ramp. No single failure leaves a thruster running.

**Q: How fast is your emergency stop?**
A: The Esc key sends a stop command immediately, not at the next 50 ms tick. If the link itself is broken, the watchdog stops everything within 500 ms.

**Q: What can you change after the safety inspection?**
A: Only software. That's why calibration lives in the GUI: thruster mapping, invert, gain, dead band, colour ranges and detector thresholds, with no reflashing needed.

---

## 7. Laptop software

**Q: Why do you need a Python bridge?**
A: A web page can't open a USB serial port. The bridge serves the GUI, forwards text lines between the browser and the serial port, and runs the vision detection.

**Q: What is a WebSocket?**
A: A persistent two-way connection between the browser and a server. Unlike plain HTTP, either side can send at any time, which we need for 20 Hz commands one way and live telemetry the other.

**Q: Could another website control your ROV through the bridge?**
A: No. The bridge checks the origin and only accepts connections from our own page on localhost, and only whitelisted command letters get through.

**Q: Why a browser GUI?**
A: No installation, it runs on any laptop with Chrome, it's easy to make clear and responsive, and the browser gives direct camera access.

**Q: When does the GUI refuse to arm?**
A: When the bridge isn't connected, the ESP32 isn't answering, the firmware is still arming, the thruster mapping is invalid, or a Mission 1 request is running.

**Q: When does the GUI disarm by itself?**
A: When the bridge connection drops, the serial link is lost, the ESP32 goes silent for 1.5 s, the ESP32 restarts, or the browser tab is hidden.

**Q: What do the mixer settings mean?**
A: Invert flips a motor's direction. Gain balances left and right so the ROV goes straight. Dead band skips the small range where a motor doesn't turn yet. The ramp limits how fast the output can change, to avoid jerks.

---

## 8. Computer vision (OpenCV)

**Q: Where does the vision run?**
A: On the laptop, in Python with OpenCV and pupil-apriltags. The ESP32 isn't involved. The browser sends frames over a separate WebSocket and draws the results on the video.

**Q: How do you keep vision from slowing down driving?**
A: Detection runs in a separate thread pool, on a separate connection from the motor commands, and only one frame is in flight at a time, up to about 15 per second. We measured that motor command latency stays under a millisecond during detection.

**Q: Why convert to grayscale?**
A: AprilTags are black and white, so only brightness matters, and one channel is about a third of the data.

**Q: What is CLAHE?**
A: Contrast Limited Adaptive Histogram Equalization. It boosts contrast locally, in small tiles, so dark and bright regions are each improved, with a limit so noise isn't amplified too much. We use it as a second pass when the first pass found fewer than three tags.

**Q: Why HSV for colours instead of RGB?**
A: HSV separates the colour itself, the hue, from brightness, so a colour stays recognisable when the lighting changes. Red needs two ranges, because its hue wraps around zero.

**Q: Why calibrate colours in the pool?**
A: Water absorbs red light first and adds a blue-green tint, so colours measured in air don't match underwater. We click on each pole in the live video to set its range.

**Q: What are morphological operations?**
A: Simple shape filters on binary or grey images. Opening removes small specks, closing fills small holes. For the line we use a large closing to estimate the floor brightness around the line.

**Q: What does solvePnP do?**
A: It finds an object's position and angle in 3D from where its known points appear in the image. We give it the four tag corners and the real tag size, 16.2 cm, and get the distance and offset of the tag.

**Q: How do you handle the camera underwater?**
A: The flat window refracts light, so the field of view shrinks by about 1.33, the refractive index of water. We correct the camera model for that, so 70° in air becomes about 55°.

---

## 9. Missions

**Q: How does Mission 1 work?**
A: The ESP32 itself joins the tower's Wi-Fi in station mode and does the HTTP GET. SSID, password and URL are typed into our GUI on site and sent at runtime. Joining is non-blocking; the GET blocks, so the thrusters stop first. Each line of the answer comes back to the laptop, where we show it full-screen with the ESP32's own IP address as proof.

**Q: What if the tower's Wi-Fi is 5 GHz?**
A: The ESP32 only supports 2.4 GHz. Our scan button lists the networks the ESP32 can hear, so we'd see immediately that the tower isn't there and tell the organisers.

**Q: How do you make sure the AprilTag ID is correct?**
A: At most one corrected bit, a decision margin of at least 10, and an ID only counts after five frames. The final answer only appears with exactly three tags confirmed, and Undo removes a wrong one.

**Q: How does the AprilTag detector work?**
A: It thresholds the grayscale image, finds four-sided shapes, corrects the perspective with a homography, reads the 6×6 grid of cells as 36 bits, and matches them against the 587 valid tag36h11 codes in all rotations. The codes differ in at least 11 bits, so a few misread bits can be corrected.

**Q: What is Hamming distance?**
A: The number of bits that differ between two codes. In our case it's the number of bits the detector had to correct to match a valid tag; we accept at most one.

**Q: How does docking guidance work?**
A: We estimate the target tag's position with solvePnP and show the pilot what to do in order: turn until it's centred within 5°, adjust height within 8 cm, then go forward, slowly when closer than 1 m.

**Q: How do you detect the line underwater?**
A: We look for "darker than the local floor" rather than "black", because underwater black looks blue-green and the light varies. A morphological closing estimates the floor brightness, and we compare each pixel to it. Dark pieces are fitted into one straight line with PCA, which gives its angle and offset, and from those a steering hint.

**Q: How do you count the checkpoints?**
A: White tapes appear as gaps in the dark line, or as bright bands at its ends. A tape counts when it crosses a line on the screen, with a short debounce so it isn't counted twice. The pilot can correct with ±1, since the referee decides.

**Q: Is any mission autonomous?**
A: No. All guidance is visual hints; the pilot always drives. The rules require manual piloting for the line and object missions anyway.

**Q: How does the hook mission use software?**
A: A reticle marks where the hook is in the camera image, and a timer measures the three-second hold. Once a continuous hold reaches three seconds it shows "20 points secured", which stays even if the object drops later, as the rules say.

**Q: How do you handle the pole order?**
A: The pilot enters the referee's order, like R-B-Y. The software highlights the next pole in the video with a hint which way to turn, and after each ball drops the pilot marks it and the next colour becomes the target.

---

## 10. Testing

**Q: How did you test without a pool?**
A: Around 900 automated tests: the firmware parser and math compiled and tested on the laptop, the Python bridge and vision tested on synthetic images with noise, blur and haze, and the browser logic tested with Node. We also have an ESP32 emulator, so the whole system runs without hardware, a built-in simulator for practising the missions, and the pin self-check for the real board.

**Q: How do you know the emulator behaves like the real firmware?**
A: The same 20,000 random command lines go through the firmware's C++ parser and the emulator's Python parser, and they must agree on every line.

**Q: What bugs did testing find?**
A: For example, an HTTPS request could crash the board because an object was deleted too early; a code review caught it and we fixed it. Earlier, the ESP32Servo library bug and the ESCs' drifting neutral were found on the bench.

**Q: Have you tested in the water?**
A: Answer honestly. "The software is tested on the bench and in simulation; the vision thresholds and colour ranges are calibrated in the pool, and the GUI lets us adjust them without reflashing."

---

## 11. Design choices, limitations, improvements

**Q: Why not a Raspberry Pi on the ROV?**
A: A microcontroller boots instantly, has real-time hardware PWM, can't crash an operating system mid-dive, and the safety logic stays simple. The heavy processing is on the laptop, which is far more powerful anyway.

**Q: Why an ESP32-S3?**
A: Built-in 2.4 GHz Wi-Fi for Mission 1, hardware PWM on almost any pin, dual-core 240 MHz, plenty of memory, cheap, and well supported by Arduino and PlatformIO.

**Q: Why open-loop control?**
A: We have no IMU or depth sensor. The pilot closes the loop by watching the camera, and our software helps with visual hints.

**Q: What are the limitations of your system?**
A: No depth or heading feedback; vision thresholds need calibration in real water; the power is limited to 30% until we've tested in the pool; and everything depends on the tether.

**Q: What would you improve next?**
A: Add an IMU and a depth sensor for automatic depth and heading hold; raise the power limit after pool testing; calibrate the camera underwater for more accurate distances; and possibly add semi-automatic assistance for line following, within the rules.

**Q: What was the hardest problem?**
A: Debugging the motors: one pin drove two motors and a thruster moved by itself. It turned out to be a library bug and ESC neutral offsets, not the wiring. That's why we built the pin self-check and the per-ESC trim.

**Q: What did you learn?**
A: Separate what must be safe from what must be smart: the microcontroller keeps safety simple and independent, the laptop does the complex work. And test every layer, because problems that look like wiring can be software, and the other way round.
