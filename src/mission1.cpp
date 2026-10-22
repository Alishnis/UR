#include "mission1.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_wifi.h>

#include <memory>

#include "config.h"
#include "mission1_text.h"
#include "timing.h"

namespace {

enum class WifiState : uint8_t { Idle, Connecting, Connected, Failed };

char g_ssid[SSID_MAX_CHARS + 1];
char g_password[PASSWORD_MAX_CHARS + 1];
char g_url[MAX_LINE + 1];

WifiState g_state = WifiState::Idle;
uint32_t g_startMs = 0;
bool g_reportedNoSsid = false;
bool g_scanning = false;
uint32_t g_scanStartMs = 0;
// Disconnects while joining that mean "the key is wrong" (set from the Wi-Fi task, read in poll()).
// A wrong WPA2 password shows up as a handshake timeout, rarely as AUTH_FAIL; one alone can also be
// a bad radio moment, so two in a row are needed.
volatile uint8_t g_authFails = 0;
constexpr uint8_t AUTH_FAILS_WRONG_PASSWORD = 2;

void onDisconnect(arduino_event_id_t, arduino_event_info_t info) {
  const uint8_t r = info.wifi_sta_disconnected.reason;
  if (r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || r == WIFI_REASON_AUTH_FAIL || r == WIFI_REASON_HANDSHAKE_TIMEOUT ||
      r == WIFI_REASON_802_1X_AUTH_FAILED) {
    if (g_authFails < 255) g_authFails = g_authFails + 1;
  }
}

void radioOn() {
  WiFi.persistent(false);  // do not wear out flash with credentials
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower((wifi_power_t)WIFI_TX_POWER_QDBM);
}

void stopScan() {
  esp_wifi_scan_stop();
  WiFi.scanDelete();
  g_scanning = false;
}

// Called from poll() while a scan runs: prints the result once it is there.
void pollScan(uint32_t nowMs) {
  const int16_t n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) {
    if (elapsedMoreThan(nowMs, g_scanStartMs, WIFI_SCAN_TIMEOUT_MS)) {
      stopScan();
      Serial.print("N scan: failed (timeout)\n");
    }
    return;
  }
  g_scanning = false;
  if (n < 0) {
    WiFi.scanDelete();
    Serial.print("N scan: failed\n");
    return;
  }
  static int rssi[64];
  const size_t count = n < 64 ? (size_t)n : 64;
  for (size_t i = 0; i < count; i++) rssi[i] = WiFi.RSSI(i);
  size_t order[MAX_SCAN_SHOWN];
  const size_t shown = m1text::strongestFirst(rssi, count, order, MAX_SCAN_SHOWN);
  Serial.printf("N scan: %d networks\n", (int)n);
  char line[80];
  for (size_t k = 0; k < shown; k++) {
    const size_t i = order[k];
    m1text::formatNet(line, sizeof(line), rssi[i], (int)WiFi.channel(i),
                      WiFi.encryptionType(i) == WIFI_AUTH_OPEN, WiFi.SSID(i).c_str());
    Serial.printf("N net: %s\n", line);
  }
  if ((size_t)n > shown) Serial.printf("N scan: (%u more not shown)\n", (unsigned)((size_t)n - shown));
  WiFi.scanDelete();
}

const char* statusName(wl_status_t s) {
  switch (s) {
    case WL_IDLE_STATUS: return "idle";
    case WL_NO_SSID_AVAIL: return "SSID not found";
    case WL_CONNECT_FAILED: return "connect failed";
    case WL_CONNECTION_LOST: return "connection lost";
    case WL_DISCONNECTED: return "disconnected";
    case WL_CONNECTED: return "connected";
    default: return "unknown";
  }
}

// Collects the response body into a fixed buffer, with chunked decoding and a deadline.
// Returns true if the whole body arrived (or the cap was reached) before the deadline.
bool readBody(HTTPClient& http, bool chunked, m1text::Body<MAX_BODY_BYTES>& body, bool* streamError) {
  WiFiClient* stream = http.getStreamPtr();
  *streamError = false;
  if (stream == nullptr) return false;

  const int declared = http.getSize();  // -1: unknown (chunked or until close)
  if (declared == 0 && !chunked) return true;  // "Content-Length: 0": nothing to wait for
  m1text::ChunkedDecoder dec;
  const uint32_t deadline = millis() + HTTP_BODY_TIMEOUT_MS;
  uint8_t buf[128];
  size_t rawGot = 0;

  while ((int32_t)(deadline - millis()) > 0) {
    int avail = stream->available();
    if (avail > 0) {
      const int got = stream->read(buf, avail < (int)sizeof(buf) ? (size_t)avail : sizeof(buf));
      if (got <= 0) continue;  // TLS can still say "nothing / error" after available() > 0
      const size_t n = (size_t)got;
      if (chunked) {
        dec.feed(buf, n, [&](uint8_t b) { body.add(b); });
        if (dec.error()) {
          *streamError = true;
          return false;
        }
        if (dec.done()) return true;
      } else {
        for (size_t i = 0; i < n; i++) body.add(buf[i]);
        rawGot += n;
        if (declared >= 0 && rawGot >= (size_t)declared) return true;
      }
      if (body.seen > MAX_BODY_BYTES * 4) return true;  // enormous reply: stop reading, show the start
      continue;
    }
    if (!stream->connected()) {
      // Peer closed. Fine for "until close" bodies; a truncated declared/chunked body is not.
      return !chunked && (declared < 0 || rawGot >= (size_t)declared);
    }
    delay(2);
  }
  return false;  // deadline
}

}  // namespace

namespace m1 {

void connect(const char* ssid, const char* password) {
  stopAllThrusters();
  strlcpy(g_ssid, ssid, sizeof(g_ssid));
  strlcpy(g_password, password, sizeof(g_password));

  if (g_scanning) {  // joining needs the radio: a scan in progress would make it fail
    stopScan();
    Serial.print("N scan: cancelled (joining Wi-Fi)\n");
  }
  static bool hooked = false;
  if (!hooked) {
    WiFi.onEvent(onDisconnect, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    hooked = true;
  }
  radioOn();
  WiFi.setAutoReconnect(true);
  g_authFails = 0;
  // no password = open network; begin() blocks up to ~1 s while the radio starts
  const wl_status_t started = WiFi.begin(g_ssid, g_password[0] ? g_password : nullptr);
  g_reportedNoSsid = false;
  g_startMs = millis();
  if (started == WL_CONNECT_FAILED) {
    g_state = WifiState::Failed;
    Serial.print("N wifi: failed to start joining (a WPA2 password needs 8-63 characters)\n");
  } else {
    g_state = WifiState::Connecting;
    Serial.printf("N wifi: connecting to %s\n", g_ssid);
  }
  afterBlockingGet();  // the radio start blocked: queued input is stale, the watchdog must not trip
}

void setUrl(const char* url) {
  strlcpy(g_url, url, sizeof(g_url));
  Serial.printf("N url set: %s\n", g_url);
}

void scan() {
  if (g_scanning) {
    Serial.print("N scan: already running\n");
    return;
  }
  if (g_state == WifiState::Connecting) {
    Serial.print("N scan: busy joining Wi-Fi, scan again when it is connected or failed\n");
    return;
  }
  if (WiFi.getMode() == WIFI_OFF) {  // first use: starting the radio blocks for a moment
    stopAllThrusters();
    radioOn();
    afterBlockingGet();
  }
  WiFi.scanDelete();
  // async: loop() keeps running (watchdog, telemetry); show_hidden: a hidden tower still shows up
  if (WiFi.scanNetworks(true, true) == WIFI_SCAN_FAILED) {
    Serial.print("N scan: failed\n");
    return;
  }
  g_scanning = true;
  g_scanStartMs = millis();
  Serial.print("N scan: started\n");
}

void poll(uint32_t nowMs) {
  if (g_scanning) pollScan(nowMs);
  if (g_state == WifiState::Connected) {
    if (WiFi.status() != WL_CONNECTED) {
      Serial.print("N wifi: connection lost, reconnecting\n");
      g_state = WifiState::Connecting;
      g_startMs = nowMs;
      g_reportedNoSsid = false;
    }
    return;
  }
  if (g_state != WifiState::Connecting) return;

  const wl_status_t s = WiFi.status();
  if (s == WL_CONNECTED) {
    g_state = WifiState::Connected;
    Serial.printf("N wifi: connected, ip %s, rssi %d dBm\n", WiFi.localIP().toString().c_str(),
                  (int)WiFi.RSSI());
    return;
  }
  if (s == WL_CONNECT_FAILED || g_authFails >= AUTH_FAILS_WRONG_PASSWORD) {
    Serial.print("N wifi: failed, wrong password?\n");
    WiFi.disconnect();
    g_state = WifiState::Failed;
    return;
  }
  if (s == WL_NO_SSID_AVAIL && !g_reportedNoSsid) {
    g_reportedNoSsid = true;
    Serial.printf("N wifi: SSID \"%s\" not found (still trying; 2.4 GHz only, check spelling)\n", g_ssid);
  }
  if (elapsedMoreThan(nowMs, g_startMs, WIFI_CONNECT_TIMEOUT_MS)) {
    Serial.printf("N wifi: timeout after %lu s (%s): check SSID, password, 2.4 GHz network\n",
                  (unsigned long)(WIFI_CONNECT_TIMEOUT_MS / 1000), statusName(s));
    WiFi.disconnect();
    g_state = WifiState::Failed;
  }
}

void get() {
  stopAllThrusters();
  if (g_scanning) {  // a scan hops channels: the request would likely time out
    stopScan();
    Serial.print("N scan: cancelled (GET)\n");
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.print("N http error: wifi not connected (send M first)\n");
    return;
  }
  if (g_url[0] == '\0') {
    Serial.print("N http error: no URL set (send U first)\n");
    return;
  }
  Serial.printf("N get: %s\n", g_url);

  const bool https = strncmp(g_url, "https://", 8) == 0;
  // Both clients are declared BEFORE http: ~HTTPClient() may still call stop() on its client, so the
  // client must outlive it (a deleted WiFiClientSecure there crashed the board).
  WiFiClient plain;
  std::unique_ptr<WiFiClientSecure> secure;
  WiFiClient* client = &plain;
  if (https) {
    secure.reset(new WiFiClientSecure());
    secure->setInsecure();  // a competition tower has no certificate we could check
    secure->setHandshakeTimeout(HTTP_CONNECT_TIMEOUT_MS / 1000);  // seconds; the default is 120 s
    client = secure.get();
  }

  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
  http.setTimeout(HTTP_RESPONSE_TIMEOUT_MS);
  const char* wanted[] = {"Transfer-Encoding"};
  http.collectHeaders(wanted, 1);

  if (!http.begin(*client, g_url)) {
    Serial.print("N http error: bad URL\n");
  } else {
    const int code = http.GET();
    if (code <= 0) {
      Serial.printf("N http error: %s\n", HTTPClient::errorToString(code).c_str());
    } else if (code < 200 || code >= 300) {
      Serial.printf("N http error %d\n", code);
    } else {
      const bool chunked = http.header("Transfer-Encoding").indexOf("chunked") >= 0;
      static m1text::Body<MAX_BODY_BYTES> body;  // static: keep 2 KB off the task stack
      body = m1text::Body<MAX_BODY_BYTES>();
      bool streamError = false;
      const bool complete = readBody(http, chunked, body, &streamError);

      if (!complete && body.len == 0) {
        Serial.printf("N http error: %s\n", streamError ? "bad chunked data" : "body read timeout");
      } else {
        Serial.printf("N http %d, %u bytes\n", code, (unsigned)body.seen);
        const m1text::LineStats st = m1text::forEachBodyLine(
            body.data, body.len, MAX_GOT_LINES, MAX_GOT_LINE_LEN,
            [](const char* line) { Serial.printf("N got: %s\n", line); });
        if (st.emitted == 0) Serial.print("N got: (empty body)\n");
        if (st.dropped > 0) Serial.printf("N got: (%u more lines not shown)\n", (unsigned)st.dropped);
        if (!complete) Serial.print("N http error: body incomplete (timeout), text above may be cut\n");
        else if (body.truncated()) Serial.printf("N got: (cut at %u bytes)\n", (unsigned)MAX_BODY_BYTES);
      }
    }
    http.end();
  }
  afterBlockingGet();
}

}  // namespace m1
