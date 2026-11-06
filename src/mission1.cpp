// Mission 1: Wi-Fi join, HTTP GET and Wi-Fi scan, done by the ESP32 itself (see docs/PROTOCOL.md).
// Every result is printed to the laptop as an `N ...` line.
#include "mission1.h"  // our own declarations (m1::connect, m1::get, ...)

#include <Arduino.h>           // Serial, millis(), delay()
#include <HTTPClient.h>        // HTTP GET client
#include <WiFi.h>              // Wi-Fi station mode, scanning
#include <WiFiClientSecure.h>  // TLS client for https:// URLs
#include <esp_wifi.h>          // esp_wifi_scan_stop(), disconnect reason codes

#include <memory>  // std::unique_ptr (deletes the TLS client automatically)

#include "config.h"         // timeouts and limits
#include "mission1_text.h"  // body buffer, chunked decoder, line splitting, scan list helpers
#include "timing.h"         // elapsedMoreThan()

namespace {  // anonymous namespace: everything below is private to this file

// Where the Wi-Fi join is.
enum class WifiState : uint8_t { Idle, Connecting, Connected, Failed };

char g_ssid[SSID_MAX_CHARS + 1];          // network name from the last M command
char g_password[PASSWORD_MAX_CHARS + 1];  // its password (never printed)
char g_url[MAX_LINE + 1];                 // URL from the last U command

WifiState g_state = WifiState::Idle;  // current join state
uint32_t g_startMs = 0;               // when the join started (for the 15 s timeout)
bool g_reportedNoSsid = false;        // "SSID not found" already printed for this attempt
bool g_scanning = false;              // a scan (L) is running
uint32_t g_scanStartMs = 0;           // when it started (for the scan timeout)
// Disconnects while joining that mean "the key is wrong" (set from the Wi-Fi task, read in poll()).
// A wrong WPA2 password shows up as a handshake timeout, rarely as AUTH_FAIL; one alone can also be
// a bad radio moment, so two in a row are needed.
volatile uint8_t g_authFails = 0;  // volatile: written by another task, so always re-read it
constexpr uint8_t AUTH_FAILS_WRONG_PASSWORD = 2;

// Called by the Wi-Fi driver every time the station disconnects; counts key-related failures.
void onDisconnect(arduino_event_id_t, arduino_event_info_t info) {
  const uint8_t r = info.wifi_sta_disconnected.reason;  // why it disconnected
  if (r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || r == WIFI_REASON_AUTH_FAIL || r == WIFI_REASON_HANDSHAKE_TIMEOUT ||
      r == WIFI_REASON_802_1X_AUTH_FAILED) {             // all of these point to a wrong key
    if (g_authFails < 255) g_authFails = g_authFails + 1;  // count, without overflowing
  }
}

// Switch the radio on in station (client) mode with our transmit power.
void radioOn() {
  WiFi.persistent(false);  // do not wear out flash with credentials
  WiFi.mode(WIFI_STA);                                // station = join someone else's network
  WiFi.setTxPower((wifi_power_t)WIFI_TX_POWER_QDBM);  // transmit power from config.h
}

// Abort a running scan and free its results.
void stopScan() {
  esp_wifi_scan_stop();  // tell the Wi-Fi driver to stop scanning
  WiFi.scanDelete();     // free the result list
  g_scanning = false;
}

// Called from poll() while a scan runs: prints the result once it is there.
void pollScan(uint32_t nowMs) {
  const int16_t n = WiFi.scanComplete();  // number of networks, or "still running", or an error
  if (n == WIFI_SCAN_RUNNING) {                                        // not finished yet
    if (elapsedMoreThan(nowMs, g_scanStartMs, WIFI_SCAN_TIMEOUT_MS)) {  // taking far too long
      stopScan();
      Serial.print("N scan: failed (timeout)\n");
    }
    return;                                                            // check again next loop
  }
  g_scanning = false;               // finished, one way or the other
  if (n < 0) {                      // negative = the scan failed
    WiFi.scanDelete();
    Serial.print("N scan: failed\n");
    return;
  }
  static int rssi[64];                               // signal strength of each network (dBm)
  const size_t count = n < 64 ? (size_t)n : 64;      // look at no more than 64 results
  for (size_t i = 0; i < count; i++) rssi[i] = WiFi.RSSI(i);  // read each one's strength
  size_t order[MAX_SCAN_SHOWN];                      // indexes of the strongest ones
  const size_t shown = m1text::strongestFirst(rssi, count, order, MAX_SCAN_SHOWN);  // sort
  Serial.printf("N scan: %d networks\n", (int)n);    // header line with the total
  char line[80];                                     // one formatted network line
  for (size_t k = 0; k < shown; k++) {               // strongest first
    const size_t i = order[k];                       // index into the scan results
    m1text::formatNet(line, sizeof(line), rssi[i], (int)WiFi.channel(i),
                      WiFi.encryptionType(i) == WIFI_AUTH_OPEN, WiFi.SSID(i).c_str());
    Serial.printf("N net: %s\n", line);              // e.g. "N net: -48 dBm ch 6 secured UR_Field"
  }
  if ((size_t)n > shown) Serial.printf("N scan: (%u more not shown)\n", (unsigned)((size_t)n - shown));
  WiFi.scanDelete();                                 // free the result list
}

// Human-readable name of a Wi-Fi status, used in the timeout message.
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
  WiFiClient* stream = http.getStreamPtr();  // the TCP/TLS connection with the body bytes
  *streamError = false;                      // no chunked format error yet
  if (stream == nullptr) return false;       // no connection: nothing to read

  const int declared = http.getSize();  // -1: unknown (chunked or until close)
  if (declared == 0 && !chunked) return true;  // "Content-Length: 0": nothing to wait for
  m1text::ChunkedDecoder dec;                                // decoder for chunked bodies
  const uint32_t deadline = millis() + HTTP_BODY_TIMEOUT_MS; // give up after 5 s
  uint8_t buf[128];                                          // read in 128-byte pieces
  size_t rawGot = 0;                                         // bytes received (non-chunked)

  while ((int32_t)(deadline - millis()) > 0) {   // until the deadline (wrap-safe signed compare)
    int avail = stream->available();             // bytes waiting right now
    if (avail > 0) {
      const int got = stream->read(buf, avail < (int)sizeof(buf) ? (size_t)avail : sizeof(buf));
      if (got <= 0) continue;  // TLS can still say "nothing / error" after available() > 0
      const size_t n = (size_t)got;              // bytes really read
      if (chunked) {
        dec.feed(buf, n, [&](uint8_t b) { body.add(b); });  // decode, store payload bytes
        if (dec.error()) {                       // broken chunked format
          *streamError = true;
          return false;
        }
        if (dec.done()) return true;             // last chunk received: complete
      } else {
        for (size_t i = 0; i < n; i++) body.add(buf[i]);    // store the plain bytes
        rawGot += n;
        if (declared >= 0 && rawGot >= (size_t)declared) return true;  // got Content-Length bytes
      }
      if (body.seen > MAX_BODY_BYTES * 4) return true;  // enormous reply: stop reading, show the start
      continue;                                  // read more without waiting
    }
    if (!stream->connected()) {
      // Peer closed. Fine for "until close" bodies; a truncated declared/chunked body is not.
      return !chunked && (declared < 0 || rawGot >= (size_t)declared);
    }
    delay(2);                                    // nothing yet: wait 2 ms and look again
  }
  return false;  // deadline
}

}  // namespace

namespace m1 {

// M: start joining a Wi-Fi network. Returns at once; poll() reports the progress.
void connect(const char* ssid, const char* password) {
  stopAllThrusters();                                 // radio start can block: stop the motors
  strlcpy(g_ssid, ssid, sizeof(g_ssid));              // remember SSID (safe copy, never overflows)
  strlcpy(g_password, password, sizeof(g_password));  // remember the password

  if (g_scanning) {  // joining needs the radio: a scan in progress would make it fail
    stopScan();
    Serial.print("N scan: cancelled (joining Wi-Fi)\n");
  }
  static bool hooked = false;                         // register the disconnect callback only once
  if (!hooked) {
    WiFi.onEvent(onDisconnect, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    hooked = true;
  }
  radioOn();                    // station mode, transmit power
  WiFi.setAutoReconnect(true);  // if the link drops later, the driver rejoins by itself
  g_authFails = 0;              // fresh attempt: forget old key failures
  // no password = open network; begin() blocks up to ~1 s while the radio starts
  const wl_status_t started = WiFi.begin(g_ssid, g_password[0] ? g_password : nullptr);
  g_reportedNoSsid = false;     // may print "not found" once for this attempt
  g_startMs = millis();         // timeout clock starts now
  if (started == WL_CONNECT_FAILED) {                 // refused immediately (e.g. 1-7 char password)
    g_state = WifiState::Failed;
    Serial.print("N wifi: failed to start joining (a WPA2 password needs 8-63 characters)\n");
  } else {
    g_state = WifiState::Connecting;                  // poll() takes it from here
    Serial.printf("N wifi: connecting to %s\n", g_ssid);
  }
  afterBlockingGet();  // the radio start blocked: queued input is stale, the watchdog must not trip
}

// U: remember the URL for the next GET.
void setUrl(const char* url) {
  strlcpy(g_url, url, sizeof(g_url));       // safe copy
  Serial.printf("N url set: %s\n", g_url);  // confirm to the laptop
}

// L: start an asynchronous Wi-Fi scan. Returns at once; pollScan() prints the list.
void scan() {
  if (g_scanning) {                                  // one scan at a time
    Serial.print("N scan: already running\n");
    return;
  }
  if (g_state == WifiState::Connecting) {            // the radio is busy joining
    Serial.print("N scan: busy joining Wi-Fi, scan again when it is connected or failed\n");
    return;
  }
  if (WiFi.getMode() == WIFI_OFF) {  // first use: starting the radio blocks for a moment
    stopAllThrusters();              // so stop the motors first
    radioOn();
    afterBlockingGet();              // and drop input that queued up meanwhile
  }
  WiFi.scanDelete();                 // forget any old result list
  // async: loop() keeps running (watchdog, telemetry); show_hidden: a hidden tower still shows up
  if (WiFi.scanNetworks(true, true) == WIFI_SCAN_FAILED) {
    Serial.print("N scan: failed\n");
    return;
  }
  g_scanning = true;                 // pollScan() will check for the result
  g_scanStartMs = millis();
  Serial.print("N scan: started\n");
}

// Called from loop() every pass: scan progress and Wi-Fi join progress.
void poll(uint32_t nowMs) {
  if (g_scanning) pollScan(nowMs);                 // scan finished? print it
  if (g_state == WifiState::Connected) {           // already connected: watch for a drop
    if (WiFi.status() != WL_CONNECTED) {
      Serial.print("N wifi: connection lost, reconnecting\n");
      g_state = WifiState::Connecting;             // auto-reconnect is on: wait for it
      g_startMs = nowMs;                           // new timeout window
      g_reportedNoSsid = false;
    }
    return;
  }
  if (g_state != WifiState::Connecting) return;   // Idle or Failed: nothing to watch

  const wl_status_t s = WiFi.status();            // ask the driver how the join is going
  if (s == WL_CONNECTED) {                        // success
    g_state = WifiState::Connected;
    Serial.printf("N wifi: connected, ip %s, rssi %d dBm\n", WiFi.localIP().toString().c_str(),
                  (int)WiFi.RSSI());              // our IP address and signal strength
    return;
  }
  if (s == WL_CONNECT_FAILED || g_authFails >= AUTH_FAILS_WRONG_PASSWORD) {  // key rejected
    Serial.print("N wifi: failed, wrong password?\n");
    WiFi.disconnect();                            // stop retrying
    g_state = WifiState::Failed;
    return;
  }
  if (s == WL_NO_SSID_AVAIL && !g_reportedNoSsid) {  // network not visible (say it once)
    g_reportedNoSsid = true;
    Serial.printf("N wifi: SSID \"%s\" not found (still trying; 2.4 GHz only, check spelling)\n", g_ssid);
  }
  if (elapsedMoreThan(nowMs, g_startMs, WIFI_CONNECT_TIMEOUT_MS)) {  // 15 s without success
    Serial.printf("N wifi: timeout after %lu s (%s): check SSID, password, 2.4 GHz network\n",
                  (unsigned long)(WIFI_CONNECT_TIMEOUT_MS / 1000), statusName(s));
    WiFi.disconnect();
    g_state = WifiState::Failed;
  }
}

// G: HTTP GET the URL and print the body. BLOCKS for up to ~15 s, so the thrusters stop first.
void get() {
  stopAllThrusters();  // safety: nothing may be driving while the firmware is blocked
  if (g_scanning) {  // a scan hops channels: the request would likely time out
    stopScan();
    Serial.print("N scan: cancelled (GET)\n");
  }

  if (WiFi.status() != WL_CONNECTED) {                         // must join first
    Serial.print("N http error: wifi not connected (send M first)\n");
    return;
  }
  if (g_url[0] == '\0') {                                      // must set a URL first
    Serial.print("N http error: no URL set (send U first)\n");
    return;
  }
  Serial.printf("N get: %s\n", g_url);                         // tell the laptop it started

  const bool https = strncmp(g_url, "https://", 8) == 0;       // TLS needed?
  // Both clients are declared BEFORE http: ~HTTPClient() may still call stop() on its client, so the
  // client must outlive it (a deleted WiFiClientSecure there crashed the board).
  WiFiClient plain;                                            // plain TCP client for http://
  std::unique_ptr<WiFiClientSecure> secure;                    // TLS client, only for https://
  WiFiClient* client = &plain;                                 // the one we will use
  if (https) {
    secure.reset(new WiFiClientSecure());                      // create the TLS client
    secure->setInsecure();  // a competition tower has no certificate we could check
    secure->setHandshakeTimeout(HTTP_CONNECT_TIMEOUT_MS / 1000);  // seconds; the default is 120 s
    client = secure.get();                                     // use TLS
  }

  HTTPClient http;                                  // the HTTP request object
  http.setReuse(false);                             // one request, then close the connection
  http.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);  // max 5 s to connect
  http.setTimeout(HTTP_RESPONSE_TIMEOUT_MS);        // max 5 s waiting for the answer
  const char* wanted[] = {"Transfer-Encoding"};     // response header we need to look at
  http.collectHeaders(wanted, 1);

  if (!http.begin(*client, g_url)) {                // parse the URL, prepare the request
    Serial.print("N http error: bad URL\n");
  } else {
    const int code = http.GET();                    // send the request, wait for the status code
    if (code <= 0) {                                // negative = connection-level error
      Serial.printf("N http error: %s\n", HTTPClient::errorToString(code).c_str());
    } else if (code < 200 || code >= 300) {         // not 2xx (404, 500, a redirect, ...)
      Serial.printf("N http error %d\n", code);
    } else {                                        // 2xx: read the body
      const bool chunked = http.header("Transfer-Encoding").indexOf("chunked") >= 0;
      static m1text::Body<MAX_BODY_BYTES> body;  // static: keep 2 KB off the task stack
      body = m1text::Body<MAX_BODY_BYTES>();     // empty it for this request
      bool streamError = false;
      const bool complete = readBody(http, chunked, body, &streamError);  // read with a deadline

      if (!complete && body.len == 0) {          // nothing usable arrived
        Serial.printf("N http error: %s\n", streamError ? "bad chunked data" : "body read timeout");
      } else {
        Serial.printf("N http %d, %u bytes\n", code, (unsigned)body.seen);  // status + size
        const m1text::LineStats st = m1text::forEachBodyLine(               // one "N got:" per line
            body.data, body.len, MAX_GOT_LINES, MAX_GOT_LINE_LEN,
            [](const char* line) { Serial.printf("N got: %s\n", line); });
        if (st.emitted == 0) Serial.print("N got: (empty body)\n");
        if (st.dropped > 0) Serial.printf("N got: (%u more lines not shown)\n", (unsigned)st.dropped);
        if (!complete) Serial.print("N http error: body incomplete (timeout), text above may be cut\n");
        else if (body.truncated()) Serial.printf("N got: (cut at %u bytes)\n", (unsigned)MAX_BODY_BYTES);
      }
    }
    http.end();                                     // close the connection
  }
  afterBlockingGet();  // drop commands that queued up during the GET; keep the watchdog quiet
}

}  // namespace m1
