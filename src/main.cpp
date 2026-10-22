// ROV firmware: serial text commands -> 3 ESC pulses (LEDC), with arming,
// watchdog, hard clamp, DRY_RUN and a pin readback self-check.
// Protocol: docs/PROTOCOL.md. Configuration: src/config.h.
//
// Pulses are generated with the LEDC peripheral directly (ledcAttach/ledcWrite).
// Do NOT switch to ESP32Servo: v3.2.1 on the S3 maps the 3rd servo onto the
// 1st one's output, so one pin drives two ESCs and another drives none.

#include <Arduino.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <soc/gpio_reg.h>

#include "config.h"
#include "mission1.h"
#include "protocol.h"
#include "timing.h"

static const char* FW_VERSION = "0.2.1";

// ---------------------------------------------------------------------------
// Thruster outputs
// ---------------------------------------------------------------------------

static int g_us[NUM_ESC];        // commanded width, NEUTRAL_US-based (telemetry shows this)
static bool g_pwmOk[NUM_ESC];    // LEDC attached successfully

// Width really on the pin (or that would be, in DRY_RUN): commanded + the ESC's trim.
static int outUs(size_t i) { return g_us[i] + NEUTRAL_TRIM_US[i]; }

static void writeUs(size_t i, int us) {
  us = proto::clampUs(us);
  g_us[i] = us;
  if (DRY_RUN || !g_pwmOk[i]) return;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(ESC_PINS[i], proto::usToDuty(outUs(i)));
#else
  ledcWrite(i, proto::usToDuty(outUs(i)));  // core 2.x: channel i
#endif
}

static void allNeutral() {
  for (size_t i = 0; i < NUM_ESC; i++) writeUs(i, NEUTRAL_US);
}

static void setupOutputs() {
  for (size_t i = 0; i < NUM_ESC; i++) {
    g_us[i] = NEUTRAL_US;
    if (DRY_RUN) {
      // Solid LOW = "no signal" for the ESC; never a floating pin.
      pinMode(ESC_PINS[i], OUTPUT);
      digitalWrite(ESC_PINS[i], LOW);
      g_pwmOk[i] = false;
      continue;
    }
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    g_pwmOk[i] = ledcAttach(ESC_PINS[i], PWM_FREQ_HZ, PWM_BITS);
#else
    g_pwmOk[i] = ledcSetup(i, PWM_FREQ_HZ, PWM_BITS) != 0;
    if (g_pwmOk[i]) ledcAttachPin(ESC_PINS[i], i);
#endif
    writeUs(i, NEUTRAL_US);
  }
}

// ---------------------------------------------------------------------------
// Readback self-check: each ESC pin is jumpered to a readback input.
// A CHANGE interrupt measures pulse width (rise->fall) and period (rise->rise).
// ---------------------------------------------------------------------------

struct Readback {
  uint8_t pin;
  uint32_t lastRiseUs;
  uint32_t lastEdgeUs;
  uint32_t widthUs;
  uint32_t periodUs;
  bool seenRise;
  bool seenEdge;
  bool haveWidth;
  bool havePeriod;
};

static Readback g_rb[NUM_ESC];
static portMUX_TYPE g_rbMux = portMUX_INITIALIZER_UNLOCKED;

static inline uint32_t nowUs() { return (uint32_t)esp_timer_get_time(); }

static inline bool IRAM_ATTR readPinFast(uint8_t pin) {
  return pin < 32 ? (REG_READ(GPIO_IN_REG) >> pin) & 1u
                  : (REG_READ(GPIO_IN1_REG) >> (pin - 32)) & 1u;
}

static void IRAM_ATTR onReadbackEdge(void* arg) {
  Readback* s = static_cast<Readback*>(arg);
  const uint32_t t = (uint32_t)esp_timer_get_time();  // IRAM-safe
  const bool high = readPinFast(s->pin);
  portENTER_CRITICAL_ISR(&g_rbMux);
  if (high) {
    if (s->seenRise) {
      s->periodUs = t - s->lastRiseUs;
      s->havePeriod = true;
    }
    s->lastRiseUs = t;
    s->seenRise = true;
  } else if (s->seenRise) {
    s->widthUs = t - s->lastRiseUs;
    s->haveWidth = true;
  }
  s->lastEdgeUs = t;
  s->seenEdge = true;
  portEXIT_CRITICAL_ISR(&g_rbMux);
}

static void setupReadback() {
  for (size_t i = 0; i < NUM_ESC; i++) {
    g_rb[i] = Readback{};
    g_rb[i].pin = READBACK_PINS[i];
    // Pulldown: an open jumper reads "no signal (LOW)" instead of noise.
    pinMode(READBACK_PINS[i], INPUT_PULLDOWN);
    attachInterruptArg(READBACK_PINS[i], onReadbackEdge, &g_rb[i], CHANGE);
  }
}

static void printReadbackReport() {
  Readback snap[NUM_ESC];
  portENTER_CRITICAL(&g_rbMux);
  memcpy(snap, g_rb, sizeof(snap));
  portEXIT_CRITICAL(&g_rbMux);
  const uint32_t t = nowUs();

  char out[320];
  size_t n = (size_t)snprintf(out, sizeof(out), "R %s", DRY_RUN ? "[DRY RUN] " : "");
  for (size_t i = 0; i < NUM_ESC && n < sizeof(out); i++) {
    const Readback& s = snap[i];
    const char* sep = i == 0 ? "" : " | ";
    n += (size_t)snprintf(out + n, sizeof(out) - n, "%s%s io%u->io%u: ", sep, ESC_NAMES[i],
                          ESC_PINS[i], READBACK_PINS[i]);
    if (n >= sizeof(out)) break;

    if (!s.seenEdge || (t - s.lastEdgeUs) > READBACK_SIGNAL_TIMEOUT_US) {
      const bool high = digitalRead(s.pin) == HIGH;
      n += (size_t)snprintf(out + n, sizeof(out) - n, "%s sent %d",
                            high ? "stuck HIGH" : "no signal (LOW)", outUs(i));
    } else if (!s.haveWidth || !s.havePeriod || s.periodUs == 0) {
      n += (size_t)snprintf(out + n, sizeof(out) - n, "measuring sent %d", outUs(i));
    } else {
      const uint32_t hz = (1000000u + s.periodUs / 2) / s.periodUs;
      const int diff = (int)s.widthUs - outUs(i);
      const bool ok = abs(diff) <= READBACK_TOLERANCE_US && hz >= READBACK_MIN_HZ &&
                      hz <= READBACK_MAX_HZ;
      n += (size_t)snprintf(out + n, sizeof(out) - n, "%luus %luHz sent %d %s",
                            (unsigned long)s.widthUs, (unsigned long)hz, outUs(i),
                            ok ? "ok" : "MISMATCH");
    }
  }
  Serial.printf("%s\n", out);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

static bool g_armed = false;         // false during the boot neutral hold
static uint32_t g_bootMs = 0;
static uint32_t g_lastCmdMs = 0;     // last valid D / S / P
static bool g_wdTripped = true;      // starts tripped: outputs already neutral
static uint32_t g_lastTelemetryMs = 0;
static bool g_rbStream = false;
static uint32_t g_lastRbMs = 0;
static bool g_badWarned = false;
static uint32_t g_lastBadWarnMs = 0;

// Serial line assembly
static char g_line[MAX_LINE + 1];
static size_t g_len = 0;
static bool g_overflow = false;   // current line is longer than MAX_LINE
static bool g_badChar = false;    // current line has a non-printable byte
static bool g_discard = false;    // drop the rest of a line cut by the arming phase
static bool g_midLine = false;    // last byte dropped during arming was not '\n'
static bool g_flushed = false;    // serial input was flushed after a blocking GET

static void refreshWatchdog(uint32_t nowMs) {
  g_lastCmdMs = nowMs;
  g_wdTripped = false;
}

static void warnBadLine(uint32_t nowMs, const char* what, const char* line) {
  if (g_badWarned && !elapsedAtLeast(nowMs, g_lastBadWarnMs, BAD_LINE_WARN_MS)) return;
  g_badWarned = true;
  g_lastBadWarnMs = nowMs;
  if (line) {
    Serial.printf("W ignored %s: \"%.40s%s\"\n", what, line, strlen(line) > 40 ? "..." : "");
  } else {
    Serial.printf("W ignored %s\n", what);
  }
}

static void handleLine(const char* line, uint32_t nowMs) {
  const proto::Command cmd = proto::parseLine(line);
  switch (cmd.type) {
    case proto::Cmd::Empty:
      return;
    case proto::Cmd::Invalid:
      warnBadLine(nowMs, "malformed line", line);
      return;
    case proto::Cmd::Drive:
      for (size_t i = 0; i < NUM_ESC; i++) writeUs(i, proto::valueToUs(cmd.value[i]));
      refreshWatchdog(nowMs);
      return;
    case proto::Cmd::Stop:
      allNeutral();
      refreshWatchdog(nowMs);
      return;
    case proto::Cmd::Ping:
      Serial.print("PONG\n");
      refreshWatchdog(nowMs);
      return;
    case proto::Cmd::Report:
      if (cmd.report == proto::ReportMode::StreamOff) {
        g_rbStream = false;
        return;
      }
      g_rbStream = cmd.report == proto::ReportMode::StreamOn;
      g_lastRbMs = nowMs;
      printReadbackReport();
      return;
    case proto::Cmd::WifiJoin:
      m1::connect(cmd.ssid, cmd.password);
      return;
    case proto::Cmd::SetUrl:
      m1::setUrl(cmd.url);
      return;
    case proto::Cmd::Get:
      m1::get();
      return;
    case proto::Cmd::Scan:
      m1::scan();
      return;
  }
}

// Hooks for mission1.cpp ------------------------------------------------------

void stopAllThrusters() { allNeutral(); }

// A GET can block for seconds. Whatever the laptop sent meanwhile is stale (old D lines!)
// and may be cut in the middle, so drop it. Do not let the GET itself trip the watchdog.
void afterBlockingGet() {
  const bool pending = Serial.available() > 0;  // something was queued, the last line may be cut
  while (Serial.available() > 0) Serial.read();
  g_flushed = pending;
  if (!g_wdTripped) g_lastCmdMs = millis();
}

static void pollSerial(uint32_t nowMs) {
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c < 0) break;

    if (!g_armed) {  // arming phase: drop everything
      g_midLine = c != '\n';
      continue;
    }
    if (c == '\r') continue;
    if (c == '\n') {
      if (g_discard) {
        // tail of a line that started during arming: drop silently
      } else if (g_overflow) {
        warnBadLine(nowMs, "overlong line", nullptr);
      } else if (g_badChar) {
        warnBadLine(nowMs, "line with non-printable bytes", nullptr);
      } else {
        g_line[g_len] = '\0';
        handleLine(g_line, nowMs);
      }
      g_len = 0;
      g_overflow = g_badChar = g_discard = false;
      if (g_flushed) {  // the next bytes may be the tail of a line cut by the flush
        g_discard = true;
        g_flushed = false;
      }
      continue;
    }
    if (g_discard || g_overflow) continue;
    if (g_len >= MAX_LINE) {
      g_overflow = true;
      continue;
    }
    if (!((c >= 0x20 && c <= 0x7E) || c == '\t')) g_badChar = true;
    g_line[g_len++] = (char)c;
  }
}

// Why the chip started. Every restart drops the ESC pulses for a moment, so a board that keeps
// restarting (weak supply, motor noise) makes the motors twitch. CRASH / BROWNOUT / GLITCH are
// shown as a warning by the GUI, keep those words in the texts.
static const char* resetReasonName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "power-on";
    case ESP_RST_EXT: return "reset pin";
    case ESP_RST_SW: return "software";
    case ESP_RST_USB: return "USB";
    case ESP_RST_DEEPSLEEP: return "deep sleep";
    case ESP_RST_BROWNOUT: return "BROWNOUT (supply voltage dropped)";
    case ESP_RST_PWR_GLITCH: return "POWER GLITCH";
    case ESP_RST_PANIC: return "CRASH (panic)";
    case ESP_RST_INT_WDT: return "CRASH (interrupt watchdog)";
    case ESP_RST_TASK_WDT: return "CRASH (task watchdog)";
    case ESP_RST_WDT: return "CRASH (watchdog)";
    case ESP_RST_CPU_LOCKUP: return "CRASH (CPU lockup)";
    default: return "unknown";
  }
}

static void printBanner() {
  Serial.print("\n");
  Serial.printf("ROV firmware %s\n", FW_VERSION);
  Serial.printf("ROV reset reason: %s\n", resetReasonName(esp_reset_reason()));
  Serial.printf("ROV mode: %s\n", DRY_RUN ? "DRY RUN (ESC pins held LOW, no pulses)" : "LIVE");
  Serial.printf("ROV ESC pins: %s=io%u %s=io%u %s=io%u | readback: io%u io%u io%u\n",
                ESC_NAMES[0], ESC_PINS[0], ESC_NAMES[1], ESC_PINS[1], ESC_NAMES[2], ESC_PINS[2],
                READBACK_PINS[0], READBACK_PINS[1], READBACK_PINS[2]);
  Serial.printf("ROV ESC: %s, neutral %d us, clamp %d..%d us, %lu Hz, %u-bit LEDC\n",
                ESC_BIDIRECTIONAL ? "bidirectional" : "forward-only", NEUTRAL_US, MIN_US, MAX_US,
                (unsigned long)PWM_FREQ_HZ, PWM_BITS);
  Serial.printf("ROV ESC neutral trim: %s %+d, %s %+d, %s %+d us\n", ESC_NAMES[0],
                NEUTRAL_TRIM_US[0], ESC_NAMES[1], NEUTRAL_TRIM_US[1], ESC_NAMES[2], NEUTRAL_TRIM_US[2]);
  Serial.printf("ROV watchdog %lu ms, arming: neutral for %lu ms, input ignored\n",
                (unsigned long)WATCHDOG_MS, (unsigned long)ARM_MS);
  for (size_t i = 0; i < NUM_ESC; i++) {
    if (!DRY_RUN && !g_pwmOk[i]) Serial.printf("W pwm: LEDC attach failed on io%u\n", ESC_PINS[i]);
  }
}

// ---------------------------------------------------------------------------

void setup() {
  setupOutputs();  // neutral (or LOW in DRY_RUN) as early as possible
  Serial.begin(SERIAL_BAUD);
  setupReadback();
  g_bootMs = millis();
  printBanner();
}

void loop() {
  const uint32_t nowMs = millis();

  pollSerial(nowMs);
  m1::poll(millis());  // fresh time: a command handled above may have taken some

  if (!g_armed && elapsedAtLeast(nowMs, g_bootMs, ARM_MS)) {
    g_armed = true;
    g_discard = g_midLine;
    refreshWatchdog(nowMs);
    g_wdTripped = true;  // nothing commanded yet: no watchdog warning at boot
    Serial.print("ROV ready, accepting commands\n");
  }

  if (g_armed && !g_wdTripped && elapsedMoreThan(nowMs, g_lastCmdMs, WATCHDOG_MS)) {
    allNeutral();
    g_wdTripped = true;
    Serial.printf("W watchdog: no command for %lu ms, thrusters neutral\n",
                  (unsigned long)WATCHDOG_MS);
  }

  if (elapsedAtLeast(nowMs, g_lastTelemetryMs, TELEMETRY_MS)) {
    g_lastTelemetryMs = nowMs;
    Serial.printf("T %d %d %d\n", g_us[0], g_us[1], g_us[2]);
  }

  if (g_rbStream && elapsedAtLeast(nowMs, g_lastRbMs, READBACK_STREAM_MS)) {
    g_lastRbMs = nowMs;
    printReadbackReport();
  }
}
