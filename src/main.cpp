#include <Arduino.h>
#include <ESP32Servo.h>

const int ESC_PIN = 8;
const int NEUTRAL = 1500;               // stop for a bidirectional ESC
const int MAX_DELTA = 150;              // first-test limit: 1350..1650
const int STEP = 50;                    // each key press, in microseconds
const unsigned long TIMEOUT_MS = 15000; // no key for 15 s = stop

Servo esc;
int current = NEUTRAL;
unsigned long lastCmd = 0;

void setThrottle(int us) {
  current = constrain(us, NEUTRAL - MAX_DELTA, NEUTRAL + MAX_DELTA);
  esc.writeMicroseconds(current);
  Serial.print("throttle us = ");
  Serial.println(current);
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("BOOT OK");

  esc.setPeriodHertz(50);
  esc.attach(ESC_PIN, 1000, 2000);
  esc.writeMicroseconds(NEUTRAL);

  Serial.println("Arming 4 s, listen for ESC beeps...");
  delay(4000);
  Serial.println("Keys: w = forward, x = reverse, space or 0 = stop");
  lastCmd = millis();
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'w') setThrottle(current + STEP);
    else if (c == 'x') setThrottle(current - STEP);
    else if (c == ' ' || c == '0') setThrottle(NEUTRAL);
    lastCmd = millis();
  }

  if (current != NEUTRAL && millis() - lastCmd > TIMEOUT_MS) {
    setThrottle(NEUTRAL);
    Serial.println("timeout, stopped");
  }
}