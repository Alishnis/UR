// Firmware configuration: every tunable value lives here.
// Pure constants, no Arduino includes, so native unit tests can use it too.
#pragma once

#include <stddef.h>
#include <stdint.h>

// ---------------------------------------------------------------------------
// Safety mode
// ---------------------------------------------------------------------------

// true: ESC pins are held LOW (no pulses at all), everything else works.
// Telemetry then reports the widths that WOULD be sent.
constexpr bool DRY_RUN = false;

// ---------------------------------------------------------------------------
// Pins (firmware output order: index 0, 1, 2)
// ---------------------------------------------------------------------------

constexpr size_t NUM_ESC = 3;
constexpr uint8_t ESC_PINS[NUM_ESC] = {1, 42, 40};      // left, right, vertical
constexpr uint8_t READBACK_PINS[NUM_ESC] = {4, 5, 6};   // jumpered to ESC_PINS
constexpr const char* ESC_NAMES[NUM_ESC] = {"left", "right", "vert"};

// ---------------------------------------------------------------------------
// ESC pulse mapping
// ---------------------------------------------------------------------------

// UNCONFIRMED HARDWARE FACT (see docs/HARDWARE_QUESTIONS.md, Q1).
// true:  1500 us = stop, below = reverse, above = forward (bidirectional ESC).
// false: 1000 us = stop, forward only, negative commands are treated as 0.
constexpr bool ESC_BIDIRECTIONAL = true;

constexpr int NEUTRAL_US = ESC_BIDIRECTIONAL ? 1500 : 1000;  // stop pulse
constexpr int US_PER_UNIT = ESC_BIDIRECTIONAL ? 500 : 1000;  // us for value 1.0

// Hard clamp, cannot be bypassed from the laptop: NEUTRAL_US +/- MAX_DELTA_US.
// 150 us = 30 % of the bidirectional range. Raise only after pool tests.
constexpr int MAX_DELTA_US = 150;

constexpr int MIN_US = ESC_BIDIRECTIONAL ? NEUTRAL_US - MAX_DELTA_US : NEUTRAL_US;
constexpr int MAX_US = NEUTRAL_US + MAX_DELTA_US;

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

constexpr uint32_t SERIAL_BAUD = 115200;
constexpr size_t MAX_LINE = 160;       // longer lines are dropped entirely
constexpr size_t SSID_MAX_CHARS = 32;    // 802.11 limit
constexpr size_t PASSWORD_MAX_CHARS = 63;  // WPA2 passphrase limit

// ---------------------------------------------------------------------------
// Mission 1: Wi-Fi + HTTP GET
// ---------------------------------------------------------------------------

constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;  // then "N wifi: timeout ..."
constexpr uint32_t HTTP_CONNECT_TIMEOUT_MS = 5000;   // TCP connect
constexpr uint32_t HTTP_RESPONSE_TIMEOUT_MS = 5000;  // waiting for the answer
constexpr uint32_t HTTP_BODY_TIMEOUT_MS = 5000;      // reading the body after the headers
constexpr size_t MAX_BODY_BYTES = 2048;              // more is cut off, never stored
constexpr size_t MAX_GOT_LINES = 20;                 // "N got:" lines printed per GET
constexpr size_t MAX_GOT_LINE_LEN = 300;             // longer lines are cut
// Wi-Fi transmit power in quarter dBm (78 = 19.5 dBm, the default). Lower it (e.g. 44 = 11 dBm)
// if the board resets when Wi-Fi starts: weak USB supply / long cable (brownout).
constexpr int WIFI_TX_POWER_QDBM = 78;

// ---------------------------------------------------------------------------
// Readback self-check
// ---------------------------------------------------------------------------

constexpr uint32_t READBACK_SIGNAL_TIMEOUT_US = 100000;  // no edge -> "no signal"
constexpr int READBACK_TOLERANCE_US = 10;                // |measured - sent|
constexpr uint32_t READBACK_MIN_HZ = 45;
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

constexpr bool pinsValid() {
  for (size_t i = 0; i < NUM_ESC; i++) {
    if (isForbiddenPin(ESC_PINS[i]) || !isPwmPin(ESC_PINS[i])) return false;
    if (isForbiddenPin(READBACK_PINS[i])) return false;
  }
  return true;
}

constexpr bool pinsDistinct() {
  for (size_t i = 0; i < 2 * NUM_ESC; i++) {
    uint8_t a = i < NUM_ESC ? ESC_PINS[i] : READBACK_PINS[i - NUM_ESC];
    for (size_t j = i + 1; j < 2 * NUM_ESC; j++) {
      uint8_t b = j < NUM_ESC ? ESC_PINS[j] : READBACK_PINS[j - NUM_ESC];
      if (a == b) return false;
    }
  }
  return true;
}

static_assert(pinsValid(), "ESC_PINS / READBACK_PINS contain a forbidden or non-PWM pin");
static_assert(pinsDistinct(), "every ESC and readback pin must be different");
static_assert(MAX_DELTA_US > 0 && MAX_DELTA_US <= 500, "MAX_DELTA_US out of range");
static_assert(MAX_LINE >= 40 && MAX_LINE <= 250, "MAX_LINE out of range");
