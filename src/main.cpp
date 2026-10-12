// ROV firmware (Phase 1): three ESCs driven by text commands from the laptop, plus Mission 1 Wi-Fi.
// Protocol: docs/PROTOCOL.md. Build / upload:  pio run -t upload  (stop the bridge first, it holds the port)
//
//   D <left> <right> <vert>   thruster commands -1.000..1.000, sent at 20 Hz by the GUI
//   S                         all neutral          P  -> PONG
//   M <ssid> <password>       join Wi-Fi           U <url>   G  -> HTTP GET, reply "N got: ..."
// Replies: T <us> <us> <us> (5 Hz), N <network text>, W <warning>
//
// SAFETY: neutral at boot and while the ESCs arm, hard limit MAX_DELTA_US, watchdog: no valid line for 500 ms
// -> neutral. For any spin test: motor clamped, hand on the power box e-stop.
#include <Arduino.h>
#include <ESP32Servo.h>
#include <HTTPClient.h>
#include <WiFi.h>

// ---------------- config (UNCONFIRMED values marked) ----------------
const bool DRY_RUN = false;  // true = ESCs get NO signal (motors cannot spin), everything else works.
                            // Set false for the first real motor test.
const int NUM_THRUSTERS = 3;
const int ESC_PINS[NUM_THRUSTERS] = {4, 5, 6};  // left, right, vertical - UNCONFIRMED: check with the GUI PIN TEST
const char *NAMES[NUM_THRUSTERS] = {"left", "right", "vert"};
const int NEUTRAL_US = 1500;                // stop for a bidirectional ESC - UNCONFIRMED
const int MAX_DELTA_US = 150;               // hard limit: 1350..1650 us, whatever the laptop sends
const unsigned long ARM_MS = 4000;          // neutral this long after boot so the ESCs arm
const unsigned long WATCHDOG_MS = 500;
const unsigned long TELEMETRY_MS = 200;
const unsigned long WIFI_TIMEOUT_MS = 15000;
const uint16_t HTTP_TIMEOUT_MS = 5000;
const size_t MAX_LINE_LEN = 160;

// ---------------- state ----------------
Servo esc[NUM_THRUSTERS];
int currentUs[NUM_THRUSTERS];
unsigned long lastValidMs = 0;
bool watchdogTripped = true;  // nothing commanded yet
unsigned long lastTelemetryMs = 0;
char line[MAX_LINE_LEN + 1];
size_t lineLen = 0;
bool lineOverflow = false;

String wifiSsid;
bool wifiConnecting = false;
unsigned long wifiStartMs = 0;
String httpUrl;

// ---------------- thrusters ----------------
void writeThruster(int i, int us) {
  currentUs[i] = constrain(us, NEUTRAL_US - MAX_DELTA_US, NEUTRAL_US + MAX_DELTA_US);
  if (!DRY_RUN) esc[i].writeMicroseconds(currentUs[i]);
}

void stopAll() {
  for (int i = 0; i < NUM_THRUSTERS; i++) writeThruster(i, NEUTRAL_US);
}

void commandReceived() {
  lastValidMs = millis();
  watchdogTripped = false;
}

// "D l r v": all three numbers must parse and be in -1..1, otherwise the line is ignored (never half-applied)
void handleDrive(const char *args) {
  float v[NUM_THRUSTERS];
  const char *p = args;
  for (int i = 0; i < NUM_THRUSTERS; i++) {
    char *end;
    v[i] = strtof(p, &end);
    if (end == p || v[i] < -1.0f || v[i] > 1.0f) return;
    p = end;
  }
  while (*p == ' ') p++;
  if (*p != '\0') return;  // trailing garbage
  for (int i = 0; i < NUM_THRUSTERS; i++) writeThruster(i, NEUTRAL_US + (int)lroundf(v[i] * 500.0f));
  commandReceived();
}

// ---------------- Mission 1 ----------------
void startWifi(const char *args) {
  stopAll();  // Mission 1 is done at the surface; never leave thrusters running while blocking on the network
  String a(args);
  a.trim();
  int sp = a.indexOf(' ');
  wifiSsid = sp < 0 ? a : a.substring(0, sp);
  String pass = sp < 0 ? "" : a.substring(sp + 1);
  if (wifiSsid.isEmpty()) {
    Serial.println("N wifi error: no ssid");
    return;
  }
  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), pass.c_str());
  wifiConnecting = true;
  wifiStartMs = millis();
  Serial.printf("N connecting to \"%s\"...\n", wifiSsid.c_str());
}

void pollWifi() {
  if (!wifiConnecting) return;
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnecting = false;
    Serial.printf("N connected to \"%s\", ip %s\n", wifiSsid.c_str(), WiFi.localIP().toString().c_str());
  } else if (millis() - wifiStartMs > WIFI_TIMEOUT_MS) {
    wifiConnecting = false;
    WiFi.disconnect(true);
    Serial.printf("N wifi failed for \"%s\" (status %d) - wrong password, or 5 GHz only?\n", wifiSsid.c_str(),
                  (int)WiFi.status());
  }
}

void httpGet() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("N http error: wifi not connected");
    return;
  }
  if (httpUrl.isEmpty()) {
    Serial.println("N http error: no url (send U <url> first)");
    return;
  }
  stopAll();
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(httpUrl)) {
    Serial.println("N http error: bad url");
    return;
  }
  int code = http.GET();
  if (code <= 0) {
    Serial.printf("N http error: %s\n", http.errorToString(code).c_str());
  } else {
    Serial.printf("N GET %s -> %d\n", httpUrl.c_str(), code);
    String body = http.getString();
    int start = 0;
    while (start < (int)body.length() && start < 2000) {  // one "N got:" line per text line
      int end = body.indexOf('\n', start);
      if (end < 0) end = body.length();
      String part = body.substring(start, end);
      part.trim();
      if (!part.isEmpty()) Serial.printf("N got: %s\n", part.c_str());
      start = end + 1;
    }
  }
  http.end();
  commandReceived();  // the GET may have taken seconds: do not trip the watchdog because of it
}

// ---------------- serial lines ----------------
void handleLine(char *s) {
  while (*s == ' ') s++;
  if (*s == '\0') return;
  char op = s[0];
  const char *args = s[1] == ' ' ? s + 2 : s + 1;
  if (s[1] != ' ' && s[1] != '\0') return;  // ops are one letter
  switch (op) {
    case 'D': handleDrive(args); break;
    case 'S': stopAll(); commandReceived(); break;
    case 'P': commandReceived(); Serial.println("PONG"); break;
    case 'M': startWifi(args); break;
    case 'U':
      httpUrl = String(args);
      httpUrl.trim();
      Serial.printf("N url set: %s\n", httpUrl.c_str());
      break;
    case 'G': httpGet(); break;
    default: break;  // unknown: ignored
  }
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (!lineOverflow) {
        line[lineLen] = '\0';
        handleLine(line);
      }
      lineLen = 0;
      lineOverflow = false;
    } else if (lineLen < MAX_LINE_LEN) {
      line[lineLen++] = c;
    } else {
      lineOverflow = true;  // too long: drop the whole line
    }
  }
}

// ---------------- main ----------------
void setup() {
  Serial.begin(115200);
  delay(500);
  for (int i = 0; i < NUM_THRUSTERS; i++) {
    currentUs[i] = NEUTRAL_US;
    if (!DRY_RUN) {
      esc[i].setPeriodHertz(50);
      esc[i].attach(ESC_PINS[i], 1000, 2000);
      esc[i].writeMicroseconds(NEUTRAL_US);
    }
  }
  Serial.printf("N ROV firmware %s - arming ESCs at neutral for %lu s\n", DRY_RUN ? "DRY RUN (no ESC signal)" : "LIVE",
                ARM_MS / 1000);
  delay(ARM_MS);
  while (Serial.available()) Serial.read();  // drop what the GUI sent while we were arming
  Serial.printf("N ready%s. Pins left %d right %d vert %d, limit +-%d us\n", DRY_RUN ? " (DRY RUN)" : "",
                ESC_PINS[0], ESC_PINS[1], ESC_PINS[2], MAX_DELTA_US);
}

void loop() {
  readSerial();
  pollWifi();
  unsigned long now = millis();
  if (!watchdogTripped && now - lastValidMs > WATCHDOG_MS) {
    stopAll();
    watchdogTripped = true;
    Serial.println("W watchdog: no command for 500 ms, thrusters neutral");
  }
  if (now - lastTelemetryMs >= TELEMETRY_MS) {
    lastTelemetryMs = now;
    Serial.printf("T %d %d %d\n", currentUs[0], currentUs[1], currentUs[2]);
  }
}
