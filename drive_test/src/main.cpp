// Standalone drive test for the ROV: no bridge, no GUI, just a serial monitor.
// Independent of ../src: everything it needs is in this file.
//
//   cd drive_test && pio run -t upload && pio device monitor
//
// Keys (pio device monitor sends each key at once; in the Arduino IDE type it and press Enter):
//   w / s     forward / backward   (left + right)
//   a / d     turn left / right    (left and right in opposite directions)
//   r / f     up / down            (vertical)
//   1 2 3     only left / right / vertical, forward
//   4 5 6     only left / right / vertical, backward
//   + / -     power up / down by 10 us
//   space, 0  stop everything
//   n         choose the motor whose neutral [ ] adjusts (starts with vert)
//   [ / ]     its neutral -5 / +5 us: find where a twitching motor is really still
//   h         help
// A command runs for RUN_MS after the last key. Holding a key keeps it running
// (keyboard auto-repeat); letting go stops it within RUN_MS.
// The Russian layout works too (ц ы ф в к а р т х ъ = w s a d r f h n [ ]).

#include <Arduino.h>

// ---- settings: change here --------------------------------------------------
const uint8_t PINS[3] = {1, 40, 42};           // ESC signal wires: left, right, vertical
const char* const NAMES[3] = {"left", "right", "vert"};
const bool INVERT[3] = {false, false, false};  // true = this motor turns the wrong way
const int NEUTRAL_US = 1500;                   // stop, bidirectional ESC
const int NEUTRAL_TRIM_US[3] = {0, -22, 0};    // per-ESC stop correction, found with [ ]
                                               // right still at 1460..1495 us -> 1478
const int MAX_TRIM_US = 50;
const int MAX_POWER_US = 150;                  // hard limit around neutral (1350..1650 us)
const int START_POWER_US = 100;                // power after boot
const int POWER_STEP_US = 10;                  // + / - step
const uint32_t RUN_MS = 1000;                  // a command lasts this long after the last key
const uint32_t ARM_MS = 4000;                  // neutral at boot so the ESCs arm

const uint32_t PWM_HZ = 50;                    // 20 ms frame
const uint8_t PWM_BITS = 14;
// -----------------------------------------------------------------------------

struct Move {
  char key;
  const char* name;
  int8_t dir[3];  // left, right, vertical: +1 forward / up, -1 backward / down, 0 stop
};

const Move MOVES[] = {
    {'w', "FORWARD", {+1, +1, 0}},
    {'s', "BACKWARD", {-1, -1, 0}},
    {'d', "TURN RIGHT", {+1, -1, 0}},
    {'a', "TURN LEFT", {-1, +1, 0}},
    {'r', "UP", {0, 0, +1}},
    {'f', "DOWN", {0, 0, -1}},
    {'1', "LEFT only, forward", {+1, 0, 0}},
    {'2', "RIGHT only, forward", {0, +1, 0}},
    {'3', "VERT only, up", {0, 0, +1}},
    {'4', "LEFT only, backward", {-1, 0, 0}},
    {'5', "RIGHT only, backward", {0, -1, 0}},
    {'6', "VERT only, down", {0, 0, -1}},
};

const Move* g_move = nullptr;  // running command, nullptr = stopped
uint32_t g_lastKeyMs = 0;
int g_power = START_POWER_US;
int g_us[3];
int g_trim[3] = {NEUTRAL_TRIM_US[0], NEUTRAL_TRIM_US[1], NEUTRAL_TRIM_US[2]};
int g_trimMotor = 2;  // vert
bool g_ready = false;
uint32_t g_bootMs = 0;

void writeUs(int i, int us) {
  us = constrain(us, NEUTRAL_US - MAX_POWER_US, NEUTRAL_US + MAX_POWER_US);
  g_us[i] = us;
  const uint32_t period = 1000000UL / PWM_HZ;
  ledcWrite(PINS[i], ((uint32_t)us * (1UL << PWM_BITS) + period / 2) / period);
}

void apply() {
  for (int i = 0; i < 3; i++) {
    const int dir = g_move ? g_move->dir[i] * (INVERT[i] ? -1 : 1) : 0;
    writeUs(i, NEUTRAL_US + g_trim[i] + dir * g_power);
  }
}

void changeTrim(int delta) {
  int& t = g_trim[g_trimMotor];
  t = constrain(t + delta, -MAX_TRIM_US, MAX_TRIM_US);
  apply();
  Serial.printf("%s neutral %d us (trim %+d)\n", NAMES[g_trimMotor], NEUTRAL_US + t, t);
}

void printOutputs() {
  Serial.printf("  left %d  right %d  vert %d us\n", g_us[0], g_us[1], g_us[2]);
}

void stopAll(const char* why) {
  const bool wasMoving = g_move != nullptr;
  g_move = nullptr;
  apply();
  if (wasMoving) Serial.printf("%s -> stop\n", why);
}

void start(const Move& m) {
  g_lastKeyMs = millis();
  if (g_move == &m) return;  // auto-repeat of the same key: just keep running
  g_move = &m;
  apply();
  Serial.printf("%s (power %d us)\n", m.name, g_power);
  printOutputs();
}

void changePower(int delta) {
  g_power = constrain(g_power + delta, POWER_STEP_US, MAX_POWER_US);
  Serial.printf("power %d us (max %d)\n", g_power, MAX_POWER_US);
  if (g_move) {
    apply();
    printOutputs();
  }
}

void printHelp() {
  Serial.println();
  Serial.println("w/s forward/back   a/d turn left/right   r/f up/down");
  Serial.println("1 2 3 only left/right/vert forward   4 5 6 same backward");
  Serial.println("+/- power   space or 0 stop   h help");
  Serial.printf("n choose motor (%s)   [ ] its neutral -5/+5 us: now %d %d %d\n",
                NAMES[g_trimMotor], NEUTRAL_US + g_trim[0], NEUTRAL_US + g_trim[1],
                NEUTRAL_US + g_trim[2]);
  Serial.printf("Hold a key to keep going; stops %lu ms after the last key. Power %d us.\n",
                (unsigned long)RUN_MS, g_power);
}

// Russian layout: the same physical keys send Cyrillic letters, 2 bytes in UTF-8.
// Returns the Latin key, or 0 while in the middle of a letter / for unknown bytes.
char keyFromByte(int b) {
  static int lead = 0;
  if (b < 0x80) {
    lead = 0;
    return (char)tolower(b);
  }
  if (b == 0xD0 || b == 0xD1) {
    lead = b;
    return 0;
  }
  if (!lead) return 0;
  uint16_t cp = ((lead & 0x1F) << 6) | (b & 0x3F);
  lead = 0;
  if (cp >= 0x410 && cp <= 0x42F) cp += 0x20;  // uppercase -> lowercase
  switch (cp) {
    case 0x446: return 'w';  // ц
    case 0x44B: return 's';  // ы
    case 0x444: return 'a';  // ф
    case 0x432: return 'd';  // в
    case 0x43A: return 'r';  // к
    case 0x430: return 'f';  // а
    case 0x440: return 'h';  // р
    case 0x442: return 'n';  // т
    case 0x445: return '[';  // х
    case 0x44A: return ']';  // ъ
    default: return '?';
  }
}

void handleKey(char k) {
  switch (k) {
    case 0: case '\r': case '\n':
      return;
    case ' ': case '0': case 'x':
      stopAll("STOP");
      return;
    case '+': case '=':
      changePower(+POWER_STEP_US);
      return;
    case '-': case '_':
      changePower(-POWER_STEP_US);
      return;
    case 'h':
      printHelp();
      return;
    case 'n':
      g_trimMotor = (g_trimMotor + 1) % 3;
      Serial.printf("[ ] now adjust %s, neutral %d us\n", NAMES[g_trimMotor],
                    NEUTRAL_US + g_trim[g_trimMotor]);
      return;
    case '[':
      changeTrim(-5);
      return;
    case ']':
      changeTrim(+5);
      return;
  }
  for (const Move& m : MOVES) {
    if (m.key == k) {
      start(m);
      return;
    }
  }
  stopAll("unknown key");  // a typo never leaves a motor running
  Serial.println("unknown key, h = help");
}

void setup() {
  // Neutral first, before anything slow, so the ESCs see a valid signal at once.
  bool pwmOk[3];
  for (int i = 0; i < 3; i++) {
    pwmOk[i] = ledcAttach(PINS[i], PWM_HZ, PWM_BITS);
    writeUs(i, NEUTRAL_US + g_trim[i]);
  }
  Serial.begin(115200);
  g_bootMs = millis();
  Serial.println();
  Serial.println("ROV drive test (standalone, no bridge)");
  for (int i = 0; i < 3; i++) {
    Serial.printf("  %s = GPIO %u%s%s\n", NAMES[i], PINS[i], INVERT[i] ? " (inverted)" : "",
                  pwmOk[i] ? "" : "  PWM FAILED!");
  }
  Serial.printf("Arming ESCs: neutral for %lu s, keys ignored...\n", (unsigned long)(ARM_MS / 1000));
}

void loop() {
  const uint32_t now = millis();

  if (!g_ready) {
    while (Serial.available() > 0) Serial.read();  // keys pressed while arming are dropped
    if (now - g_bootMs >= ARM_MS) {
      g_ready = true;
      Serial.println("READY");
      printHelp();
    }
    return;
  }

  while (Serial.available() > 0) handleKey(keyFromByte(Serial.read()));

  if (g_move && millis() - g_lastKeyMs > RUN_MS) stopAll("no key");
}
