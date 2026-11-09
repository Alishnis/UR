# Judge questions from our documents: EE and CS

These are technical questions that judges could ask after reading our Technical Document, the
Team 8 poster and the DISROVER slides. Only **electrical (EE)** and **software (CS)** questions
are here. Part choices are left out, because the token list fixed them. More firmware detail is in
`QA_BANK.md`.

Answers marked **[CHECK]** depend on something only the team knows. Agree on one answer before the
presentation.

---

## 0. Settle these first: the documents disagree

| # | What a judge will see | What to agree on |
|---|---|---|
| 1 | The circuit diagram says **IO1 → ESC 1, IO42 → ESC 2, IO40 → ESC 3** | The firmware uses left = IO1, right = IO40, vertical = IO42. So: **ESC 1 left, ESC 2 vertical, ESC 3 right.** |
| 2 | Slide 8 and the diagram say the ESP32 is powered **only from USB**, but an **LM2596** buck converter is in the parts list | [CHECK] Either say what the LM2596 powers, or: "It's an alternative 12 V → 5 V supply for the ESP32. We use USB instead, so motor power can never reach the controller." |
| 3 | The poster says "**added the kill switch**". Slide 8 says the kill switch is in the **organiser** power box | [CHECK] Where is the switch that cuts 12 V to the ESCs, and who reaches it? |
| 4 | Splices: Tech Doc says **epoxy potting cups**, slide 10 says **heat-shrink**, and the poster says wiring was **"not waterproofed enough"** | Tell it as one story: soldered, then heat-shrink, then potted in epoxy. One joint failed in the first pool test and was redone. |
| 5 | Slide 10 says the **ESP32** is in the dry box. In the photo of the open box the ESP32 isn't clearly visible, and the ESC signal leads leave the box | [CHECK] Know exactly where the ESP32 is. If it's topside, the PWM runs 5 m down the tether (see Q2.6). |
| 6 | The circuit diagram shows **no fuse, kill switch or XT60** | "The diagram shows signal and power topology. Fuse and kill switch are in the 12 V supply, before the XT60." |
| 7 | Tech Doc says the supply is "current-limited **or** fused" | [CHECK] Say which one, and the rating if known. |

---

## 1. Power

**Q1.1 Walk us through your circuit diagram.**
One 12 V DC supply feeds three ESCs in parallel. Each ESC turns the DC into three-phase AC for its
brushless thruster. The ESP32-S3 sends each ESC its own 50 Hz PWM signal: IO1 for left, IO40 for
right and IO42 for vertical. The laptop powers the ESP32 over USB and talks to it on the same
cable. The camera has its own USB cable to the laptop. All grounds are joined.

**Q1.2 Why are the ESCs in parallel and not in series?**
In parallel, every ESC gets the full 12 V and draws its own current. In series, the voltage would
be split between them and change with load, and if one failed it would cut off the others. The
total current is the sum of the three ESC currents.

**Q1.3 What did you solder for the power, and why that way?**
I soldered the three ESC power leads (+ and −) in parallel to one main power cable. Then one cable
in the tether carries 12 V for all three, and each ESC still gets the full voltage. The joint has
to carry the current of all three motors, so it must be soldered well and insulated.

**Q1.4 Why are the ESCs' 5 V outputs (the BEC red wire) left unconnected?**
The ESP32 already gets 5 V from USB. Connecting the BEC too would put two supplies against each
other. That can push current back into the laptop's USB port or between the BECs, and motor noise
would reach the controller. So only signal and ground go to the ESP32.

**Q1.5 Why must the grounds be joined if the ESP32 has its own power?**
A PWM signal is a voltage measured relative to ground. If the ESC's ground and the ESP32's ground
aren't connected, the ESC can't tell what "3.3 V high" means, so the signal is undefined and the
motor can twitch or not arm.

**Q1.6 The ESP32 outputs 3.3 V, but ESCs are often called "5 V signal". Does that work?**
Yes. The ESC input treats anything above about 2 V as high, so 3.3 V is read reliably. We
confirmed it: all three ESCs arm and respond.

**Q1.7 What is an XT60 connector?**
A polarised power connector rated about 60 A. It can't be plugged in backwards, which protects the
ESCs from reverse polarity, and it unplugs fast.

**Q1.8 What would happen with reverse polarity on the 12 V?**
Most ESCs have no reverse-polarity protection, so their MOSFETs and capacitors could be destroyed
at once. The polarised XT60 prevents that.

**Q1.9 How much current does the robot draw?** [CHECK]
The organiser box has an ammeter, so give the number you saw. Rough reasoning: we limit throttle
to about 30 %, so the current is a small fraction of the thrusters' maximum.

**Q1.10 What does the fuse protect?**
The wires and the power source. If a short circuit happens, for example from water in a joint, the
current spikes and the fuse blows before the wire overheats or burns.

**Q1.11 If you used the LM2596, how would it work?**
It's a switching buck converter. It switches the 12 V on and off very fast and smooths the result
with an inductor and capacitor, to get a lower voltage like 5 V. It's efficient (about 80–90 %), so
it stays cool, unlike a linear regulator, which burns the extra 7 V as heat. You must set its
output with a multimeter before you connect the ESP32.

**Q1.12 What is brownout, and could it happen?**
When the supply voltage dips too low, the ESP32 resets. Powering the ESP32 from USB, separate from
the motors, prevents motor current spikes from dipping its voltage. Our firmware prints the reset
reason at startup, so a brownout would show up as "BROWNOUT" in the log.

---

## 2. Signals and wiring

**Q2.1 What is the 3-phase connection between the ESC and the thruster?**
A brushless motor has three coil groups. The ESC energises them in sequence with its MOSFETs,
which creates a rotating magnetic field that pulls the magnet rotor around. Swapping any two of
the three wires reverses the motor direction.

**Q2.2 How does the ESC know how fast to spin?**
From the pulse width of the 50 Hz signal: 1500 µs means stop, 2000 µs full forward and 1000 µs
full reverse. We use 1350–1650 µs. The ESP32's LEDC hardware creates these pulses.

**Q2.3 What did you find when a thruster spun by itself?**
That ESC's "stop" point wasn't exactly 1500 µs. Each ESC has a small dead band around neutral, and
it drifts. We tested pulses around 1500 µs, found the middle of the stop zone, and added a per-ESC
trim: 0 µs left, −22 µs right and −5 µs vertical. Now "stop" really stops.

**Q2.4 Does the trim reduce motor power?**
No. It only shifts the centre point by a few microseconds. The range around it stays the same.

**Q2.5 Why is a USB tether of exactly 5 m sensitive?**
5 m is the limit of the USB 2.0 spec. Signal quality drops with length, so bending or touching
the cable can drop the camera. We used a USB 2.0 extension cable and added automatic camera
reconnect in the GUI. If the stream drops, it finds the camera again by itself.

**Q2.6 If the ESC signal runs 5 m down the tether, is that okay?**
Yes. 50 Hz PWM is very slow compared to USB, so 5 m of wire doesn't distort it. The important
thing is to run the ground wire right alongside the signal, so noise affects both equally.

**Q2.7 How do you check each ESC signal without a scope?**
Our firmware self-check. Each output pin is connected by a jumper to an input pin (IO1 → IO4,
IO40 → IO6, IO42 → IO5). At startup the ESP32 measures its own pulses with interrupts and prints
them, so we see that each output is really producing the right width.

**Q2.8 What was your biggest electrical failure, and what did you learn?**
A soldered joint on the 5 m tether broke. The cable had been pulled at the joint, so the force
went into the solder. We re-stripped, re-soldered, re-insulated it and added strain relief: the
tether is clamped to the frame, so a pull loads the frame, not the wires. Lesson: solder is an
electrical connection, not a mechanical one.

**Q2.9 After the pool test showed weak waterproofing, how did you check the electrics?**
[CHECK what you did.] Typical answer: "We measured 12 V at each ESC with a multimeter, checked
each ESC arms and spins, and used the firmware self-check for the signal pins."

---

## 3. Electrical in water

**Q3.1 Why is "no bare copper" so important?**
With 12 V in water, bare copper conducts a current through the water. That corrodes the metal
(electrolysis), wastes power and can eventually short the circuit. Every joint is soldered,
heat-shrunk and potted in epoxy.

**Q3.2 What happens electrically if the box leaks?**
Water bridges the 12 V and ground on the ESCs, causing a short circuit. The fuse should blow or
the pilot hits the kill switch. The ESP32 stops getting good commands, and the watchdog stops the
thrusters. The ROV is slightly buoyant, so it floats up.

**Q3.3 How are cable entries into the box sealed?**
Each cable enters through a short PVC sleeve on the box. The sleeve is filled with epoxy in two
stages: fast-set first to close the gaps, then slow-set epoxy that flows around every wire before
hardening. That makes a solid plug with no air path.

**Q3.4 The ESCs are inside a sealed box. Do they overheat?**
ESCs heat up with current, and the heat has nowhere to go except through the box walls into the
water. At 30 % throttle and in short bursts the current is low, so it's manageable. [CHECK: if you
felt the ESCs after a run, mention it.] An improvement would be mounting them on an aluminium
plate touching the box wall.

---

## 4. Software: control and safety

**Q4.1 How does a key press become thruster motion?**
The browser reads W/S, A/D and R/F (plus on-screen buttons for one thruster alone). The mixer turns them into three values from −1 to 1 (left =
surge + yaw, right = surge − yaw, vertical = heave), applies the speed limit and ramp, and sends
`D left right vert` to the bridge 20 times a second over WebSocket. The bridge forwards it over USB
serial. The ESP32 checks the line, converts each value to a pulse width, clamps it, adds the trim
and sets the LEDC output.

**Q4.2 What is the ±150 µs clamp, and why is it in the firmware?**
Pulses can never leave 1350–1650 µs, which is about 30 % of the range. It's in the firmware
because that's the last step before the motors: no bug in the GUI or bridge can make the thrusters
go faster. It can be raised in one constant after pool tests.

**Q4.3 What happens at startup?**
The ESP32 prints why it reset (power-on, brownout, crash) and its pin map. It sets all three
outputs to neutral (1500 µs plus trim) and turns on the self-check inputs. Then it holds neutral
for 4 seconds while the ESCs arm, ignoring any commands that arrive. After that it starts
accepting commands.

**Q4.4 How does the 500 ms watchdog work?**
Each valid drive, stop or ping command records the time. In every `loop()` pass the ESP32 checks
the time since the last one. If it's more than 500 ms, all thrusters go to neutral. So if the
laptop freezes or the cable is pulled, the robot stops within half a second.

**Q4.5 Why does the GUI send "Stop" 20 times a second when disarmed?**
To keep the watchdog fed with a safe command. The ESP32 always gets a fresh command, and while
disarmed it's always zero. Sending nothing would also stop the motors, but sending stop means we
also see the link is alive.

**Q4.6 What does the ESP32 do with a corrupted command?**
The parser is strict. The command letter must be known, the number of values must be exact, and
each value must be a valid number in range. Otherwise the whole line is ignored and an error is
reported. A broken line can never move a motor; the watchdog then stops it if good commands don't
arrive.

**Q4.7 What's the difference between the E-STOP key and the kill switch?**
E-STOP is software: the GUI sends stop immediately, with no ramp, and disarms. The kill switch is
hardware: it cuts 12 V, so it works even if all the software has crashed.

---

## 5. Software: vision

**Q5.1 Why process video on the laptop and not on the ESP32?**
The ESP32 has a 240 MHz processor and 8 MB of RAM. AprilTag detection and OpenCV need far more
computing power. The camera already goes to the laptop over USB, so we process there with Python
and OpenCV.

**Q5.2 How does a frame get from the camera to the detector?**
The browser shows the camera, takes a frame, compresses it to JPEG and sends it over a WebSocket
to the vision service on the laptop. That service decodes it, runs the detector and sends back
results as JSON, which the GUI draws over the video. Only one frame is processed at a time, so it
never lags behind.

**Q5.3 How does AprilTag detection work?**
Convert to grayscale, find edges and fit four-sided shapes (quads), then read the black-and-white
grid inside each square as bits. The 36h11 family has codes that differ by many bits, so one or
two wrong bits are corrected, and a random pattern is rejected. We only accept codes with at most
1 corrected bit and a good decision margin, and the GUI confirms an ID over 5 frames.

**Q5.4 What do you do when tags are hard to see?**
If the plain pass finds fewer than 3 tags, we run a second pass with CLAHE, which boosts contrast
locally, so dim or hazy tags show up. Results from both passes are merged.

**Q5.5 How do you measure the distance to a tag?**
With `solvePnP`. We know the real tag size and the camera's field of view, and we have the four
corner positions in the image. From those it computes where the tag is in 3D. Underwater we divide
the horizontal FOV by 1.333 because water narrows the view.

**Q5.6 Why does the GUI show the tag yaw as "(unsure)"?**
For a flat square seen nearly face-on, two different 3D poses can give almost the same image.
This is planar pose ambiguity. When both solutions fit about equally well, we mark the angle unsure
instead of guessing. The distance is still reliable.

**Q5.7 How does line following work with a tilted camera?**
The bottom part of the image sees the floor. We find pixels darker than their local surroundings
(morphological closing), keep the biggest connected region, and fit a line through it with PCA.
Steering is the line's offset from the centre plus its angle, and the GUI shows "LEFT", "RIGHT" or
"STRAIGHT".

**Q5.8 How do you detect the pole colours?**
First balance the picture against the water: in every row the median colour is the water, and each
channel is scaled so the water becomes neutral grey. Then convert to HSV, because hue separates colour
from brightness. Use a hue range per colour; red needs two ranges because it wraps around 0. Then
clean the mask with morphology, find connected blobs, and prefer tall, narrow shapes. A click on the
pole in the pool video can widen a range if our paint differs.

**Q5.9 Why HSV and not RGB?**
In RGB, a shadow changes all three numbers. In HSV mostly the "V" (brightness) changes, and the
hue stays almost the same, so detection survives changing light underwater.

**Q5.10 Red looks like another colour under water. Does your detector still find the red pole?**
Yes, and we measured it. Water absorbs red ~35× faster than blue (0.34 /m vs 0.009 /m, Pope & Fry)
and adds a blue-green haze, so in the raw picture our red pole went pink-brown at 1.5 m, magenta at
3 m and blue-ish at 5 m. The water-colour balance removes exactly the colour the water added, so red
stays at hue 2–9 out to 3 m. On a physics-based simulator (144 pool conditions × 7 distances) every
pole was found out to 2 m, and no pole was ever called another colour (before: 192 mix-ups). Further
away a pole may be missed, and then the pilot comes closer. Details: `docs/MISSION5_COLOURS_UNDERWATER.md`.

**Q5.11 Any weakness left?**
Grey, black or white things close to the camera look warm after the balance, so a grey pipe can
look orange-red. Red stops at hue 8 and needs brightness ≥ 130, which keeps out most of them (9 % of
worst-case frames left). The pilot checks the box on the video. We verify the masks in the pool
during the adjustment period.

---

## 6. Software: Mission 1 and Wi-Fi

**Q6.1 Wi-Fi doesn't go through water. How does Mission 1 work?**
Correct: water absorbs 2.4 GHz within a few centimetres. We do Mission 1 at the surface, disarmed,
before we dive. The ESP32 itself joins the tower's network, does the HTTP GET and shows the text
with its own IP address as proof.

**Q6.2 What if the tower network was 5 GHz?**
The ESP32-S3 only supports 2.4 GHz, so it couldn't connect. Our scan command shows which networks
the ESP32 actually hears, so we'd know immediately.

**Q6.3 Joining Wi-Fi takes seconds. Why don't the thrusters freeze during it?**
The join is non-blocking. `WiFi.begin()` starts it, and every `loop()` pass just checks the status,
so the watchdog and commands keep working. Only the short HTTP request blocks, and before it we put
the thrusters in neutral, set strict timeouts and then throw away any commands that queued up.

**Q6.4 How do you know the password was wrong and not just a weak signal?**
The ESP32 reports a reason code when it disconnects. We count the reasons that mean
authentication failed. Two in a row gives "wrong password?"; otherwise it's a timeout or a missing
network.

---

## How to use this file

1. Go through **section 0** with the team and fill every **[CHECK]** with one agreed answer.
2. Split the questions: you and Nat take sections 4–6, the electrical team takes 1–3.
3. Practise each answer out loud in your own words, in 20–30 seconds.
