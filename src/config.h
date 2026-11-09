// Firmware configuration: every tunable value lives here.
// Pure constants, no Arduino includes, so native unit tests can use it too.
// `constexpr` = a constant known at compile time: costs no RAM and can be checked by static_assert.
#pragma once  // include only once per file

#include <stddef.h>  // size_t (unsigned type for sizes and array indexes)
#include <stdint.h>  // uint8_t, uint32_t (fixed-size integers)

// ---------------------------------------------------------------------------
// Safety mode
// ---------------------------------------------------------------------------

// true: ESC pins are held LOW (no pulses at all), everything else works.
// Telemetry then reports the widths that WOULD be sent.
constexpr bool DRY_RUN = false;  // false = LIVE: real pulses go to the ESCs

// ---------------------------------------------------------------------------
// Pins (firmware output order: index 0, 1, 2)
// ---------------------------------------------------------------------------

constexpr size_t NUM_ESC = 3;  // three thrusters: left, right, vertical
// Wiring checked in the lab 2026-10-21: io1 left, io40 right, io42 vertical.
constexpr uint8_t ESC_PINS[NUM_ESC] = {1, 40, 42};      // left, right, vertical
constexpr uint8_t READBACK_PINS[NUM_ESC] = {4, 6, 5};   // jumpers: io1-io4, io40-io6, io42-io5
constexpr const char* ESC_NAMES[NUM_ESC] = {"left", "right", "vert"};  // names used in messages

// ---------------------------------------------------------------------------
// ESC pulse mapping
// ---------------------------------------------------------------------------

// UNCONFIRMED HARDWARE FACT (see docs/HARDWARE_QUESTIONS.md, Q1).
// true:  1500 us = stop, below = reverse, above = forward (bidirectional ESC).
// false: 1000 us = stop, forward only, negative commands are treated as 0.
constexpr bool ESC_BIDIRECTIONAL = true;  // our ESCs drive forward and reverse

constexpr int NEUTRAL_US = ESC_BIDIRECTIONAL ? 1500 : 1000;  // stop pulse
constexpr int US_PER_UNIT = ESC_BIDIRECTIONAL ? 500 : 1000;  // us for value 1.0

// Hard clamp, cannot be bypassed from the laptop: NEUTRAL_US +/- MAX_DELTA_US.
// 300 us = 60 % of the bidirectional range (it was 150 us = 30 %). More thrust, more current and a
// harder-to-steer robot: keep an eye on battery voltage / ESC heat. Lower it if the board resets.
constexpr int MAX_DELTA_US = 300;  // -> pulses always stay within 1200..1800 us

// Per-ESC stop correction, added to every pulse of that output (ESC_PINS order).
// An ESC whose real stop is not at NEUTRAL_US slowly spins or twitches at "neutral".
// Found by sending pulses around 1500 us and taking the middle of the range where the motor is
// still (the standalone drive_test sketch did this; it is in git history, commit af4f8e0).
// right (io40): still at 1460..1495 us (lab, 2026-10-21) -> 1478 us.
// vert (io42): spun by itself at 1500 (2026-10-22) -> 1495 us.
// Telemetry (T) and the GUI keep showing NEUTRAL_US-based widths; R shows the real pulse.
constexpr int NEUTRAL_TRIM_US[NUM_ESC] = {0, -22, -5};  // left, right, vertical (us)

// Lowest / highest pulse the clamp allows (forward-only ESCs never go below their stop).
constexpr int MIN_US = ESC_BIDIRECTIONAL ? NEUTRAL_US - MAX_DELTA_US : NEUTRAL_US;  // 1200
constexpr int MAX_US = NEUTRAL_US + MAX_DELTA_US;                                    // 1800

constexpr uint32_t PWM_FREQ_HZ = 50;   // standard servo/ESC frame, 20 ms
constexpr uint8_t PWM_BITS = 14;       // 20000 us / 16384 = 1.22 us per step

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

constexpr uint32_t ARM_MS = 4000;             // neutral hold at boot, input dropped
constexpr uint32_t WATCHDOG_MS = 500;         // no valid D/S/P -> neutral
constexpr uint32_t TELEMETRY_MS = 200;        // T line, 5 Hz
constexpr uint32_t READBACK_STREAM_MS = 500;  // "R 1" report period
constexpr uint32_t BAD_LINE_WARN_MS = 1000;   // rate limit for "W ignored ..." lines

// ---------------------------------------------------------------------------
// Serial protocol limits
// ---------------------------------------------------------------------------

constexpr uint32_t SERIAL_BAUD = 115200;   // serial speed; the bridge uses the same value
constexpr size_t MAX_LINE = 160;           // longer lines are dropped entirely
constexpr size_t SSID_MAX_CHARS = 32;      // 802.11 limit
constexpr size_t PASSWORD_MAX_CHARS = 63;  // WPA2 passphrase limit

// ---------------------------------------------------------------------------
// Mission 1: Wi-Fi + HTTP GET
// ---------------------------------------------------------------------------

constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;  // then "N wifi: timeout ..."
constexpr uint32_t HTTP_CONNECT_TIMEOUT_MS = 5000;   // TCP connect (also the TLS handshake limit)
constexpr uint32_t HTTP_RESPONSE_TIMEOUT_MS = 5000;  // waiting for the answer
constexpr uint32_t HTTP_BODY_TIMEOUT_MS = 5000;      // reading the body after the headers
constexpr size_t MAX_BODY_BYTES = 2048;              // more is cut off, never stored
constexpr size_t MAX_GOT_LINES = 20;                 // "N got:" lines printed per GET
constexpr size_t MAX_GOT_LINE_LEN = 300;             // longer lines are cut
// Wi-Fi transmit power in quarter dBm (78 = 19.5 dBm, the default). Lower it (e.g. 44 = 11 dBm)
// if the board resets when Wi-Fi starts: weak USB supply / long cable (brownout).
constexpr int WIFI_TX_POWER_QDBM = 78;
constexpr uint32_t WIFI_SCAN_TIMEOUT_MS = 10000;     // L: a scan normally takes 2-4 s
constexpr size_t MAX_SCAN_SHOWN = 15;                // "N net:" lines per scan, strongest first

// ---------------------------------------------------------------------------
// Readback self-check
// ---------------------------------------------------------------------------

constexpr uint32_t READBACK_SIGNAL_TIMEOUT_US = 100000;  // no edge for 100 ms -> "no signal"
constexpr int READBACK_TOLERANCE_US = 10;                // |measured - sent| for "ok"
constexpr uint32_t READBACK_MIN_HZ = 45;                 // frequency window for "ok" (50 Hz nominal)
constexpr uint32_t READBACK_MAX_HZ = 55;

// ---------------------------------------------------------------------------
// Compile-time sanity checks (a bad pin choice fails the build, not the dive)
// ---------------------------------------------------------------------------

// Pins that must not be used on ESP32-S3-DevKitC-1 N8R8.
constexpr bool isForbiddenPin(uint8_t p) {
  return p == 0 || p == 3 || p == 45 || p == 46   // strapping pins
      || p == 19 || p == 20                       // native USB D-/D+
      || (p >= 26 && p <= 37)                     // flash / octal PSRAM
      || p == 43 || p == 44                       // UART0 TX/RX = Serial
      || p > 48 || (p >= 22 && p <= 25);          // do not exist on the S3
}

// LEDC-capable output pins on the S3: 1-21, 35-45, 47-48.
constexpr bool isPwmPin(uint8_t p) {
  return (p >= 1 && p <= 21) || (p >= 35 && p <= 45) || p == 47 || p == 48;
}

// Every ESC pin must be allowed and PWM-capable; every readback pin must be allowed.
constexpr bool pinsValid() {
  for (size_t i = 0; i < NUM_ESC; i++) {                                     // each output
    if (isForbiddenPin(ESC_PINS[i]) || !isPwmPin(ESC_PINS[i])) return false;  // bad ESC pin
    if (isForbiddenPin(READBACK_PINS[i])) return false;                       // bad readback pin
  }
  return true;  // all pins fine
}

// No pin may be used twice (all 3 ESC pins + 3 readback pins are different).
constexpr bool pinsDistinct() {
  for (size_t i = 0; i < 2 * NUM_ESC; i++) {                                  // all 6 pins
    uint8_t a = i < NUM_ESC ? ESC_PINS[i] : READBACK_PINS[i - NUM_ESC];       // pin number i
    for (size_t j = i + 1; j < 2 * NUM_ESC; j++) {                            // every later pin
      uint8_t b = j < NUM_ESC ? ESC_PINS[j] : READBACK_PINS[j - NUM_ESC];     // pin number j
      if (a == b) return false;                                               // duplicate found
    }
  }
  return true;  // all different
}

// static_assert: if the condition is false, compilation STOPS with this message.
static_assert(pinsValid(), "ESC_PINS / READBACK_PINS contain a forbidden or non-PWM pin");
static_assert(pinsDistinct(), "every ESC and readback pin must be different");
static_assert(MAX_DELTA_US > 0 && MAX_DELTA_US <= 500, "MAX_DELTA_US out of range");

// A trim bigger than 50 us would mean something else is wrong (wiring, ESC calibration).
constexpr bool trimsValid() {
  for (size_t i = 0; i < NUM_ESC; i++) {                                     // each ESC
    if (NEUTRAL_TRIM_US[i] < -50 || NEUTRAL_TRIM_US[i] > 50) return false;   // out of range
  }
  return true;  // all trims reasonable
}
static_assert(trimsValid(), "NEUTRAL_TRIM_US must be within +-50 us");
static_assert(MAX_LINE >= 40 && MAX_LINE <= 250, "MAX_LINE out of range");
