// Simple ESC test: spin each thruster on its own from the serial monitor.
// No bridge, no GUI. Motor clamped, propeller area clear, hand on the e-stop.
//
// Keys (type in the monitor, no Enter needed):
//   1 2 3   select motor (GPIO 1 / 42 / 40)
//   f       selected motor forward  for 2 s (1500 + STEP_US)
//   b       selected motor backward for 2 s (1500 - STEP_US)
//   + -     raise / lower the test step by 10 us
//   a       auto: every motor forward 2 s, pause, backward 2 s
//   0 / space  stop everything immediately
//   w / s   hold-to-run forward / backward: the motor runs only while 'w' / 's'
//           keep arriving; HOLD_TIMEOUT_MS without one stops it. Sent by
//           host/tools/esc_keys.py while the key is held down.

#include <Arduino.h>

const uint8_t PINS[3] = {1, 42, 40};
const char* NAMES[3] = {"motor 1 (GPIO 1)", "motor 2 (GPIO 42)", "motor 3 (GPIO 40)"};

const int NEUTRAL_US = 1500;
const int MAX_STEP_US = 150;   // same clamp as the ROV firmware
const uint32_t RUN_MS = 2000;
const uint32_t ARM_MS = 4000;
const uint32_t HOLD_TIMEOUT_MS = 250;

bool holding = false;
uint32_t lastHoldMs = 0;

int stepUs = 80;
int selected = 0;

void writeUs(int i, int us) {
  us = constrain(us, NEUTRAL_US - MAX_STEP_US, NEUTRAL_US + MAX_STEP_US);
  ledcWrite(PINS[i], (uint32_t)us * 16384 / 20000);  // 50 Hz, 14 bit
}

void stopAll() {
  for (int i = 0; i < 3; i++) writeUs(i, NEUTRAL_US);
}

// Wait, but stop at once if 0 or space arrives. Returns false if stopped.
bool waitOrAbort(uint32_t ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    if (Serial.available()) {
      char c = Serial.read();
      if (c == '0' || c == ' ') { stopAll(); Serial.println("STOP"); return false; }
    }
    delay(5);
  }
  return true;
}

bool pulse(int i, int us) {
  Serial.printf("%s -> %d us\n", NAMES[i], us);
  writeUs(i, us);
  bool ok = waitOrAbort(RUN_MS);
  writeUs(i, NEUTRAL_US);
  Serial.printf("%s -> stop\n", NAMES[i]);
  return ok;
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 3; i++) ledcAttach(PINS[i], 50, 14);
  stopAll();
  delay(500);
  Serial.println("\nESC test. Arming: holding 1500 us for 4 s ...");
  delay(ARM_MS);
  Serial.println("Ready. Keys: 1 2 3 select, f fwd, b back, + - step, a auto, 0 stop");
  Serial.printf("Selected %s, step %d us\n", NAMES[selected], stepUs);
}

void hold(int us) {
  if (!holding) Serial.printf("%s -> %d us (hold)\n", NAMES[selected], us);
  writeUs(selected, us);
  holding = true;
  lastHoldMs = millis();
}

void loop() {
  if (holding && millis() - lastHoldMs > HOLD_TIMEOUT_MS) {
    stopAll();
    holding = false;
    Serial.println("released -> stop");
  }
  if (!Serial.available()) return;
  char c = Serial.read();
  switch (c) {
    case 'w': hold(NEUTRAL_US + stepUs); break;
    case 's': hold(NEUTRAL_US - stepUs); break;
    case '1': case '2': case '3':
      stopAll();
      holding = false;
      selected = c - '1';
      Serial.printf("Selected %s\n", NAMES[selected]);
      break;
    case 'f': pulse(selected, NEUTRAL_US + stepUs); break;
    case 'b': pulse(selected, NEUTRAL_US - stepUs); break;
    case '+': stepUs = min(stepUs + 10, MAX_STEP_US); Serial.printf("step %d us\n", stepUs); break;
    case '-': stepUs = max(stepUs - 10, 10); Serial.printf("step %d us\n", stepUs); break;
    case 'a':
      for (int i = 0; i < 3; i++) {
        if (!pulse(i, NEUTRAL_US + stepUs)) break;
        if (!waitOrAbort(1000)) break;
        if (!pulse(i, NEUTRAL_US - stepUs)) break;
        if (!waitOrAbort(1000)) break;
      }
      Serial.println("auto done");
      break;
    case '0': case ' ': stopAll(); holding = false; Serial.println("STOP"); break;
  }
}
