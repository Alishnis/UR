// Serial protocol parsing and pulse math (see docs/PROTOCOL.md).
// Pure C++, no Arduino dependencies: unit-tested natively in tests/firmware/.
#pragma once  // include only once per file

#include <math.h>    // isfinite(), lroundf()
#include <stdint.h>  // uint8_t, uint32_t, uint64_t
#include <stdlib.h>  // strtof(): text -> float
#include <string.h>  // strlen(), memcpy(), strcmp(), strncmp()

#include "config.h"  // NUM_ESC, MAX_LINE, NEUTRAL_US, MIN_US / MAX_US, PWM settings

namespace proto {  // everything here is used as proto::parseLine, proto::valueToUs, ...

// Every kind of line the laptop can send.
enum class Cmd : uint8_t {
  Empty,     // blank line: ignored silently
  Invalid,   // malformed: ignored, never half-applied
  Drive,     // D <a> <b> <c>
  Stop,      // S
  Ping,      // P
  Report,    // R / R 1 / R 0
  WifiJoin,  // M <ssid> [password]
  SetUrl,    // U <url>
  Get,       // G
  Scan,      // L: list the Wi-Fi networks the ESP32 can see
};

// What "R" asks for: one report now (R), start streaming (R 1), stop streaming (R 0).
enum class ReportMode : int8_t { Once = -1, StreamOff = 0, StreamOn = 1 };

// The result of parsing one line: the type plus the fields that type uses.
struct Command {
  Cmd type = Cmd::Invalid;                     // starts as Invalid until proven correct
  float value[NUM_ESC] = {0.0f, 0.0f, 0.0f};   // D: the three thruster values, -1..1
  ReportMode report = ReportMode::Once;        // R: once / stream on / stream off
  char ssid[SSID_MAX_CHARS + 1] = {0};         // M: network name (+1 for the closing '\0')
  char password[PASSWORD_MAX_CHARS + 1] = {0}; // M: password, may be empty
  char url[MAX_LINE + 1] = {0};                // U: the URL for the GET
};

inline bool isSpace(char c) { return c == ' ' || c == '\t'; }  // separator = space or tab
inline bool isDigit(char c) { return c >= '0' && c <= '9'; }   // '0'..'9'

// Strict decimal number: [+-]? digits [. digits] | [+-]? . digits
// No exponent, no hex, no nan/inf. Token ends at whitespace or end of line.
// On success advances *p past the token and stores the value.
inline bool parseNumber(const char** p, float* out) {
  const char* s = *p;                       // start of the number
  const char* q = s;                        // q walks over the characters
  if (*q == '+' || *q == '-') q++;          // optional sign
  int digits = 0;                           // how many digits we saw in total
  while (isDigit(*q)) { q++; digits++; }    // digits before the point
  if (*q == '.') {                          // optional decimal point...
    q++;
    while (isDigit(*q)) { q++; digits++; }  // ...and digits after it
  }
  if (digits == 0) return false;                  // "+", "-", "." alone are not numbers
  if (*q != '\0' && !isSpace(*q)) return false;   // garbage glued to the number ("1x", "1e5")
  float v = strtof(s, nullptr);  // reads exactly the validated characters
  if (!isfinite(v)) return false;                 // overflow to infinity: reject
  *out = v;                                       // give the value back
  *p = q;                                         // move the caller's pointer past the number
  return true;
}

// Moves past spaces and tabs, returns the first other character.
inline const char* skipSpaces(const char* p) {
  while (isSpace(*p)) p++;
  return p;
}

// Copies one whitespace-free token into dst (capacity cap incl. NUL).
// Returns false if the token is empty or too long.
inline bool copyToken(const char** p, char* dst, size_t cap) {
  const char* s = *p;                                // token start
  size_t n = 0;                                      // token length
  while (s[n] != '\0' && !isSpace(s[n])) n++;        // count until space or end
  if (n == 0 || n >= cap) return false;              // empty, or does not fit with its '\0'
  memcpy(dst, s, n);                                 // copy the characters
  dst[n] = '\0';                                     // end the C string
  *p = s + n;                                        // caller continues after the token
  return true;
}

// Parses one line (without '\n'). The caller guarantees the line holds only
// printable ASCII and tabs and is at most MAX_LINE characters long.
inline Command parseLineRaw(const char* line) {
  Command cmd;                       // type = Invalid until a case below sets it
  const char* p = skipSpaces(line);  // ignore leading spaces

  // Trim trailing whitespace by computing the effective end.
  const char* end = p + strlen(p);               // one past the last character
  while (end > p && isSpace(end[-1])) end--;     // step back over trailing spaces
  if (end == p) {                                // nothing left: blank line
    cmd.type = Cmd::Empty;
    return cmd;
  }

  // Work on a trimmed, NUL-terminated copy so "end of token" is simple.
  char buf[MAX_LINE + 1];               // local copy on the stack
  size_t len = (size_t)(end - p);       // trimmed length
  if (len > MAX_LINE) return cmd;  // Invalid
  memcpy(buf, p, len);                  // copy the trimmed text
  buf[len] = '\0';                      // and end it

  const char letter = buf[0];                          // the command letter
  if (buf[1] != '\0' && !isSpace(buf[1])) return cmd;  // command is one letter
  const char* a = skipSpaces(buf + 1);                 // start of arguments

  switch (letter) {
    case 'D': {                                  // D <left> <right> <vert>
      for (size_t i = 0; i < NUM_ESC; i++) {     // exactly three numbers
        a = skipSpaces(a);                       // spaces between numbers
        float v;
        if (!parseNumber(&a, &v)) return cmd;    // not a valid number -> Invalid
        if (v < -1.0f || v > 1.0f) return cmd;   // outside -1..1 -> Invalid
        cmd.value[i] = v;                        // store this thruster's value
      }
      if (*skipSpaces(a) != '\0') return cmd;  // nothing after 3 numbers
      cmd.type = Cmd::Drive;                     // all good
      return cmd;
    }
    case 'S':                         // S: stop
      if (*a != '\0') return cmd;     // no arguments allowed
      cmd.type = Cmd::Stop;
      return cmd;
    case 'P':                         // P: ping
      if (*a != '\0') return cmd;
      cmd.type = Cmd::Ping;
      return cmd;
    case 'G':                         // G: HTTP GET
      if (*a != '\0') return cmd;
      cmd.type = Cmd::Get;
      return cmd;
    case 'L':                         // L: Wi-Fi scan
      if (*a != '\0') return cmd;
      cmd.type = Cmd::Scan;
      return cmd;
    case 'R':                                    // R, R 1 or R 0
      if (*a == '\0') {                          // "R": one report
        cmd.report = ReportMode::Once;
      } else if (strcmp(a, "1") == 0) {          // "R 1": stream every 500 ms
        cmd.report = ReportMode::StreamOn;
      } else if (strcmp(a, "0") == 0) {          // "R 0": stop streaming
        cmd.report = ReportMode::StreamOff;
      } else {                                   // anything else is malformed
        return cmd;
      }
      cmd.type = Cmd::Report;
      return cmd;
    case 'M': {
      // SSID: one token (no spaces). Password: rest of the line, may contain
      // spaces, may be empty (open network).
      if (!copyToken(&a, cmd.ssid, sizeof(cmd.ssid))) return cmd;  // SSID missing or too long
      a = skipSpaces(a);                                           // gap before the password
      size_t plen = strlen(a);                                     // password length
      if (plen > PASSWORD_MAX_CHARS) return cmd;                   // too long for WPA2
      memcpy(cmd.password, a, plen + 1);                           // copy incl. the '\0'
      cmd.type = Cmd::WifiJoin;
      return cmd;
    }
    case 'U': {
      if (!copyToken(&a, cmd.url, sizeof(cmd.url))) return cmd;  // URL missing or too long
      if (*skipSpaces(a) != '\0') return cmd;  // URL must not contain spaces
      if (strncmp(cmd.url, "http://", 7) != 0 && strncmp(cmd.url, "https://", 8) != 0) {
        return cmd;                                              // only http:// or https://
      }
      cmd.type = Cmd::SetUrl;
      return cmd;
    }
    default:          // unknown letter
      return cmd;     // -> Invalid
  }
}

// Public entry point: a malformed line yields a clean Command with no
// leftover fields from a partial parse (never half-applied).
inline Command parseLine(const char* line) {
  Command cmd = parseLineRaw(line);              // try to parse
  if (cmd.type == Cmd::Invalid) return Command{};  // failed: return an all-default Command
  return cmd;
}

// Keep a pulse width inside the hard clamp MIN_US..MAX_US (1350..1650 us).
inline int clampUs(long us) {
  if (us < MIN_US) return MIN_US;
  if (us > MAX_US) return MAX_US;
  return (int)us;
}

// value -1..1 (fraction of the full ESC range) -> pulse width, hard-clamped.
inline int valueToUs(float v) {
  if (!(v >= -1.0f && v <= 1.0f)) v = 0.0f;  // also catches NaN
  if (!ESC_BIDIRECTIONAL && v < 0.0f) v = 0.0f;  // forward-only ESC: no reverse
  return clampUs(NEUTRAL_US + lroundf(v * (float)US_PER_UNIT));  // 1500 + v*500, rounded, clamped
}

// Pulse width -> LEDC duty (rounded): duty = us * 2^bits / period_us.
// period_us = 1e6 / PWM_FREQ_HZ, so duty = us * 2^bits * freq / 1e6 (64-bit to avoid overflow).
inline uint32_t usToDuty(int us) {
  const uint64_t num = (uint64_t)us * (1ULL << PWM_BITS) * PWM_FREQ_HZ;  // e.g. 1500*16384*50
  return (uint32_t)((num + 500000ULL) / 1000000ULL);                     // /1e6, rounded: 1229
}

}  // namespace proto
