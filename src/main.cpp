// ROV firmware: serial text commands -> 3 ESC pulses (LEDC), with arming,
// watchdog, hard clamp, DRY_RUN and a pin readback self-check.
// Protocol: docs/PROTOCOL.md. Configuration: src/config.h.
//
// Pulses are generated with the LEDC peripheral directly (ledcAttach/ledcWrite).
// Do NOT switch to ESP32Servo: v3.2.1 on the S3 maps the 3rd servo onto the
// 1st one's output, so one pin drives two ESCs and another drives none.

#include <Arduino.h>       // Arduino core for ESP32: Serial, millis(), pinMode(), ledcAttach() ...
#include <esp_system.h>    // esp_reset_reason(): why the chip restarted
#include <esp_timer.h>     // esp_timer_get_time(): microsecond clock (safe inside interrupts)
#include <soc/gpio_reg.h>  // GPIO input registers, for the fast pin read inside the interrupt

#include "config.h"    // pins, limits, timings
#include "mission1.h"  // m1::connect / setUrl / get / scan / poll
#include "protocol.h"  // proto::parseLine, valueToUs, usToDuty, clampUs
#include "timing.h"    // elapsedAtLeast / elapsedMoreThan (wrap-safe time checks)

static const char* FW_VERSION = "0.2.1";  // printed in the boot banner

// ---------------------------------------------------------------------------
// Thruster outputs
// ---------------------------------------------------------------------------

static int g_us[NUM_ESC];        // commanded width, NEUTRAL_US-based (telemetry shows this)
static bool g_pwmOk[NUM_ESC];    // LEDC attached successfully

// Width really on the pin (or that would be, in DRY_RUN): commanded + the ESC's trim.
static int outUs(size_t i) { return g_us[i] + NEUTRAL_TRIM_US[i]; }

// Set output i to a pulse width (us): clamp, remember, then send to the hardware.
static void writeUs(size_t i, int us) {
  us = proto::clampUs(us);         // never outside 1200..1800 us, whatever the caller asked
  g_us[i] = us;                    // remember it (telemetry and the self-check use it)
  if (DRY_RUN || !g_pwmOk[i]) return;  // DRY_RUN or PWM setup failed: do not touch the pin
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(ESC_PINS[i], proto::usToDuty(outUs(i)));  // core 3.x: address the PWM by pin number
#else
  ledcWrite(i, proto::usToDuty(outUs(i)));  // core 2.x: channel i
#endif
}

// All three thrusters to stop (1500 us + each ESC's trim on the pin).
static void allNeutral() {
  for (size_t i = 0; i < NUM_ESC; i++) writeUs(i, NEUTRAL_US);
}

// Prepare the three ESC outputs; called first thing in setup().
static void setupOutputs() {
  for (size_t i = 0; i < NUM_ESC; i++) {   // each thruster
    g_us[i] = NEUTRAL_US;                  // start value: stop
    if (DRY_RUN) {
      // Solid LOW = "no signal" for the ESC; never a floating pin.
      pinMode(ESC_PINS[i], OUTPUT);
      digitalWrite(ESC_PINS[i], LOW);
      g_pwmOk[i] = false;                  // no PWM in DRY_RUN
      continue;                            // next pin
    }
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    g_pwmOk[i] = ledcAttach(ESC_PINS[i], PWM_FREQ_HZ, PWM_BITS);  // hardware PWM: 50 Hz, 14 bit
#else
    g_pwmOk[i] = ledcSetup(i, PWM_FREQ_HZ, PWM_BITS) != 0;        // core 2.x: set up channel i...
    if (g_pwmOk[i]) ledcAttachPin(ESC_PINS[i], i);                 // ...and connect it to the pin
#endif
    writeUs(i, NEUTRAL_US);                // output the stop pulse right away
  }
}

// ---------------------------------------------------------------------------
// Readback self-check: each ESC pin is jumpered to a readback input.
// A CHANGE interrupt measures pulse width (rise->fall) and period (rise->rise).
// ---------------------------------------------------------------------------

// Measurements for one readback input, written by the interrupt.
struct Readback {
  uint8_t pin;           // the input pin
  uint32_t lastRiseUs;   // time of the last LOW->HIGH edge
  uint32_t lastEdgeUs;   // time of the last edge of any kind
  uint32_t widthUs;      // last pulse width = fall time - rise time
  uint32_t periodUs;     // last period = rise time - previous rise time (20000 us at 50 Hz)
  bool seenRise;         // at least one rising edge seen
  bool seenEdge;         // at least one edge seen
  bool haveWidth;        // widthUs is valid
  bool havePeriod;       // periodUs is valid
};

static Readback g_rb[NUM_ESC];                                  // one per thruster
static portMUX_TYPE g_rbMux = portMUX_INITIALIZER_UNLOCKED;     // lock shared by interrupt and code

static inline uint32_t nowUs() { return (uint32_t)esp_timer_get_time(); }  // microseconds since boot

// Read a pin's level straight from the GPIO registers (fast and safe inside an interrupt).
// IRAM_ATTR = keep this code in internal RAM, so it can run while flash is busy.
static inline bool IRAM_ATTR readPinFast(uint8_t pin) {
  return pin < 32 ? (REG_READ(GPIO_IN_REG) >> pin) & 1u           // pins 0..31: first register
                  : (REG_READ(GPIO_IN1_REG) >> (pin - 32)) & 1u;  // pins 32..: second register
}

// Interrupt handler: runs on EVERY level change of a readback pin. Must be short.
static void IRAM_ATTR onReadbackEdge(void* arg) {
  Readback* s = static_cast<Readback*>(arg);         // which input this is
  const uint32_t t = (uint32_t)esp_timer_get_time();  // IRAM-safe
  const bool high = readPinFast(s->pin);             // did it go HIGH (rise) or LOW (fall)?
  portENTER_CRITICAL_ISR(&g_rbMux);                  // lock: main code must not read half an update
  if (high) {                                        // rising edge: a pulse starts
    if (s->seenRise) {
      s->periodUs = t - s->lastRiseUs;               // time since the previous pulse start
      s->havePeriod = true;
    }
    s->lastRiseUs = t;
    s->seenRise = true;
  } else if (s->seenRise) {                          // falling edge after a rise: pulse ends
    s->widthUs = t - s->lastRiseUs;                  // pulse width
    s->haveWidth = true;
  }
  s->lastEdgeUs = t;                                 // any edge = the signal is alive
  s->seenEdge = true;
  portEXIT_CRITICAL_ISR(&g_rbMux);                   // unlock
}

// Prepare the three readback inputs and their interrupts.
static void setupReadback() {
  for (size_t i = 0; i < NUM_ESC; i++) {
    g_rb[i] = Readback{};                  // clear all measurements
    g_rb[i].pin = READBACK_PINS[i];
    // Pulldown: an open jumper reads "no signal (LOW)" instead of noise.
    pinMode(READBACK_PINS[i], INPUT_PULLDOWN);
    attachInterruptArg(READBACK_PINS[i], onReadbackEdge, &g_rb[i], CHANGE);  // call on every edge
  }
}

// Print one "R ..." line comparing the measured pulse of each output with what we sent.
static void printReadbackReport() {
  Readback snap[NUM_ESC];                       // a consistent copy of the measurements
  portENTER_CRITICAL(&g_rbMux);                 // lock so the interrupt cannot change them mid-copy
  memcpy(snap, g_rb, sizeof(snap));
  portEXIT_CRITICAL(&g_rbMux);
  const uint32_t t = nowUs();                   // now, to see how old the last edge is

  char out[320];                                // the whole report line
  size_t n = (size_t)snprintf(out, sizeof(out), "R %s", DRY_RUN ? "[DRY RUN] " : "");
  for (size_t i = 0; i < NUM_ESC && n < sizeof(out); i++) {   // one part per output
    const Readback& s = snap[i];
    const char* sep = i == 0 ? "" : " | ";                    // separator between outputs
    n += (size_t)snprintf(out + n, sizeof(out) - n, "%s%s io%u->io%u: ", sep, ESC_NAMES[i],
                          ESC_PINS[i], READBACK_PINS[i]);     // e.g. "left io1->io4: "
    if (n >= sizeof(out)) break;                              // buffer full: stop

    if (!s.seenEdge || (t - s.lastEdgeUs) > READBACK_SIGNAL_TIMEOUT_US) {  // no edge for 100 ms
      const bool high = digitalRead(s.pin) == HIGH;           // stuck at 1 or at 0?
      n += (size_t)snprintf(out + n, sizeof(out) - n, "%s sent %d",
                            high ? "stuck HIGH" : "no signal (LOW)", outUs(i));
    } else if (!s.haveWidth || !s.havePeriod || s.periodUs == 0) {         // edges, no full pulse yet
      n += (size_t)snprintf(out + n, sizeof(out) - n, "measuring sent %d", outUs(i));
    } else {                                                  // full measurement available
      const uint32_t hz = (1000000u + s.periodUs / 2) / s.periodUs;   // period -> frequency, rounded
      const int diff = (int)s.widthUs - outUs(i);                     // measured minus sent
      const bool ok = abs(diff) <= READBACK_TOLERANCE_US && hz >= READBACK_MIN_HZ &&
                      hz <= READBACK_MAX_HZ;                          // within 10 us and 45..55 Hz
      n += (size_t)snprintf(out + n, sizeof(out) - n, "%luus %luHz sent %d %s",
                            (unsigned long)s.widthUs, (unsigned long)hz, outUs(i),
                            ok ? "ok" : "MISMATCH");
    }
  }
  Serial.printf("%s\n", out);                   // send the report to the laptop
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

static bool g_armed = false;         // false during the boot neutral hold
static uint32_t g_bootMs = 0;        // millis() at boot (for the 4 s arming hold)
static uint32_t g_lastCmdMs = 0;     // last valid D / S / P
static bool g_wdTripped = true;      // starts tripped: outputs already neutral
static uint32_t g_lastTelemetryMs = 0;  // when the last T line was sent
static bool g_rbStream = false;      // "R 1": send a self-check report every 500 ms
static uint32_t g_lastRbMs = 0;      // when the last streamed report was sent
static bool g_badWarned = false;     // a "W ignored ..." warning was printed at least once
static uint32_t g_lastBadWarnMs = 0; // when (rate limit: one per second)

// Serial line assembly
static char g_line[MAX_LINE + 1];    // the line being received, +1 for '\0'
static size_t g_len = 0;             // characters in it so far
static bool g_overflow = false;   // current line is longer than MAX_LINE
static bool g_badChar = false;    // current line has a non-printable byte
static bool g_discard = false;    // drop the rest of a line cut by the arming phase
static bool g_midLine = false;    // last byte dropped during arming was not '\n'
static bool g_flushed = false;    // serial input was flushed after a blocking GET

// A valid D / S / P arrived: the laptop is alive, restart the 500 ms watchdog window.
static void refreshWatchdog(uint32_t nowMs) {
  g_lastCmdMs = nowMs;
  g_wdTripped = false;   // armed again: silence will trip it
}

// Print "W ignored <what>" for a bad line, at most once per second (no flooding).
static void warnBadLine(uint32_t nowMs, const char* what, const char* line) {
  if (g_badWarned && !elapsedAtLeast(nowMs, g_lastBadWarnMs, BAD_LINE_WARN_MS)) return;  // too soon
  g_badWarned = true;
  g_lastBadWarnMs = nowMs;
  if (line) {   // show the first 40 characters of the bad line
    Serial.printf("W ignored %s: \"%.40s%s\"\n", what, line, strlen(line) > 40 ? "..." : "");
  } else {      // no line text to show (overlong / binary)
    Serial.printf("W ignored %s\n", what);
  }
}

// One complete, clean line arrived: parse it and act on it.
static void handleLine(const char* line, uint32_t nowMs) {
  const proto::Command cmd = proto::parseLine(line);  // strict parse (protocol.h)
  switch (cmd.type) {
    case proto::Cmd::Empty:                            // blank line: nothing to do
      return;
    case proto::Cmd::Invalid:                          // malformed: ignore it completely
      warnBadLine(nowMs, "malformed line", line);
      return;
    case proto::Cmd::Drive:                            // D a b c: set all three thrusters
      for (size_t i = 0; i < NUM_ESC; i++) writeUs(i, proto::valueToUs(cmd.value[i]));
      refreshWatchdog(nowMs);
      return;
    case proto::Cmd::Stop:                             // S: all stop
      allNeutral();
      refreshWatchdog(nowMs);
      return;
    case proto::Cmd::Ping:                             // P: answer, proves we are alive
      Serial.print("PONG\n");
      refreshWatchdog(nowMs);
      return;
    case proto::Cmd::Report:                           // R / R 1 / R 0
      if (cmd.report == proto::ReportMode::StreamOff) {  // R 0: stop streaming
        g_rbStream = false;
        return;
      }
      g_rbStream = cmd.report == proto::ReportMode::StreamOn;  // R 1 streams, R reports once
      g_lastRbMs = nowMs;
      printReadbackReport();                           // one report right now
      return;
    case proto::Cmd::WifiJoin:                         // M: join Wi-Fi (Mission 1)
      m1::connect(cmd.ssid, cmd.password);
      return;
    case proto::Cmd::SetUrl:                           // U: set the URL
      m1::setUrl(cmd.url);
      return;
    case proto::Cmd::Get:                              // G: HTTP GET (blocks, thrusters stop)
      m1::get();
      return;
    case proto::Cmd::Scan:                             // L: Wi-Fi scan
      m1::scan();
      return;
  }
}

// Hooks for mission1.cpp ------------------------------------------------------

void stopAllThrusters() { allNeutral(); }  // mission1.cpp calls this before blocking calls

// A GET can block for seconds. Whatever the laptop sent meanwhile is stale (old D lines!)
// and may be cut in the middle, so drop it. Do not let the GET itself trip the watchdog.
void afterBlockingGet() {
  const bool pending = Serial.available() > 0;  // something was queued, the last line may be cut
  while (Serial.available() > 0) Serial.read(); // throw all queued bytes away
  g_flushed = pending;                          // if so, also drop the rest of the cut line
  if (!g_wdTripped) g_lastCmdMs = millis();     // the block itself must not count as silence
}

// Read all bytes that arrived on serial and assemble them into lines.
static void pollSerial(uint32_t nowMs) {
  while (Serial.available() > 0) {   // as long as bytes are waiting
    const int c = Serial.read();     // take one byte
    if (c < 0) break;                // nothing after all

    if (!g_armed) {  // arming phase: drop everything
      g_midLine = c != '\n';         // remember if we dropped part of a line
      continue;
    }
    if (c == '\r') continue;         // ignore CR, so both "\n" and "\r\n" line endings work
    if (c == '\n') {                 // end of a line
      if (g_discard) {
        // tail of a line that started during arming: drop silently
      } else if (g_overflow) {       // was longer than 160 characters
        warnBadLine(nowMs, "overlong line", nullptr);
      } else if (g_badChar) {        // contained a non-printable byte
        warnBadLine(nowMs, "line with non-printable bytes", nullptr);
      } else {                       // a clean line: handle it
        g_line[g_len] = '\0';        // end the C string
        handleLine(g_line, nowMs);
      }
      g_len = 0;                                       // start a new line
      g_overflow = g_badChar = g_discard = false;      // reset the per-line flags
      if (g_flushed) {  // the next bytes may be the tail of a line cut by the flush
        g_discard = true;
        g_flushed = false;
      }
      continue;
    }
    if (g_discard || g_overflow) continue;   // already doomed: don't store more of it
    if (g_len >= MAX_LINE) {                 // too long: mark, keep reading until '\n'
      g_overflow = true;
      continue;
    }
    if (!((c >= 0x20 && c <= 0x7E) || c == '\t')) g_badChar = true;  // not printable ASCII / tab
    g_line[g_len++] = (char)c;               // store the character
  }
}

// Why the chip started. Every restart drops the ESC pulses for a moment, so a board that keeps
// restarting (weak supply, motor noise) makes the motors twitch. CRASH / BROWNOUT / GLITCH are
// shown as a warning by the GUI, keep those words in the texts.
static const char* resetReasonName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "power-on";                            // normal power-up
    case ESP_RST_EXT: return "reset pin";                               // RST button
    case ESP_RST_SW: return "software";                                 // code asked to restart
    case ESP_RST_USB: return "USB";                                     // reset over USB (flashing)
    case ESP_RST_DEEPSLEEP: return "deep sleep";
    case ESP_RST_BROWNOUT: return "BROWNOUT (supply voltage dropped)";  // power problem!
    case ESP_RST_PWR_GLITCH: return "POWER GLITCH";                     // power problem!
    case ESP_RST_PANIC: return "CRASH (panic)";                         // program crashed
    case ESP_RST_INT_WDT: return "CRASH (interrupt watchdog)";
    case ESP_RST_TASK_WDT: return "CRASH (task watchdog)";
    case ESP_RST_WDT: return "CRASH (watchdog)";
    case ESP_RST_CPU_LOCKUP: return "CRASH (CPU lockup)";
    default: return "unknown";
  }
}

// Boot banner: everything you need to know about this board's setup, printed at start-up.
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
  for (size_t i = 0; i < NUM_ESC; i++) {   // warn about any output whose PWM failed to start
    if (!DRY_RUN && !g_pwmOk[i]) Serial.printf("W pwm: LEDC attach failed on io%u\n", ESC_PINS[i]);
  }
}

// ---------------------------------------------------------------------------

// Runs ONCE at power-up / reset.
void setup() {
  setupOutputs();  // neutral (or LOW in DRY_RUN) as early as possible
  Serial.begin(SERIAL_BAUD);   // start the serial link to the laptop, 115200 baud
  setupReadback();             // readback inputs + interrupts for the self-check
  g_bootMs = millis();         // the 4 s arming hold starts now
  printBanner();               // tell the laptop who we are and how we are set up
}

// Runs again and again, thousands of times per second. Never blocks (except a Mission 1 GET).
void loop() {
  const uint32_t nowMs = millis();   // current time for this pass

  pollSerial(nowMs);                 // read commands and act on complete lines
  m1::poll(millis());  // fresh time: a command handled above may have taken some

  // End of the arming hold: start accepting commands.
  if (!g_armed && elapsedAtLeast(nowMs, g_bootMs, ARM_MS)) {
    g_armed = true;
    g_discard = g_midLine;           // a line that began during arming is dropped as a whole
    refreshWatchdog(nowMs);
    g_wdTripped = true;  // nothing commanded yet: no watchdog warning at boot
    Serial.print("ROV ready, accepting commands\n");
  }

  // Watchdog: no valid D / S / P for 500 ms -> all thrusters stop, warn once.
  if (g_armed && !g_wdTripped && elapsedMoreThan(nowMs, g_lastCmdMs, WATCHDOG_MS)) {
    allNeutral();
    g_wdTripped = true;              // warn only once until the next valid command
    Serial.printf("W watchdog: no command for %lu ms, thrusters neutral\n",
                  (unsigned long)WATCHDOG_MS);
  }

  // Telemetry: every 200 ms report the commanded pulse widths (1500 = stop, without trim).
  if (elapsedAtLeast(nowMs, g_lastTelemetryMs, TELEMETRY_MS)) {
    g_lastTelemetryMs = nowMs;
    Serial.printf("T %d %d %d\n", g_us[0], g_us[1], g_us[2]);
  }

  // "R 1" streaming: a self-check report every 500 ms.
  if (g_rbStream && elapsedAtLeast(nowMs, g_lastRbMs, READBACK_STREAM_MS)) {
    g_lastRbMs = nowMs;
    printReadbackReport();
  }
}
