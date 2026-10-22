// Serial protocol parsing and pulse math (see docs/PROTOCOL.md).
// Pure C++, no Arduino dependencies: unit-tested natively in tests/firmware/.
#pragma once

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"

namespace proto {

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

enum class ReportMode : int8_t { Once = -1, StreamOff = 0, StreamOn = 1 };

struct Command {
  Cmd type = Cmd::Invalid;
  float value[NUM_ESC] = {0.0f, 0.0f, 0.0f};
  ReportMode report = ReportMode::Once;
  char ssid[SSID_MAX_CHARS + 1] = {0};
  char password[PASSWORD_MAX_CHARS + 1] = {0};
  char url[MAX_LINE + 1] = {0};
};

inline bool isSpace(char c) { return c == ' ' || c == '\t'; }
inline bool isDigit(char c) { return c >= '0' && c <= '9'; }

// Strict decimal number: [+-]? digits [. digits] | [+-]? . digits
// No exponent, no hex, no nan/inf. Token ends at whitespace or end of line.
// On success advances *p past the token and stores the value.
inline bool parseNumber(const char** p, float* out) {
  const char* s = *p;
  const char* q = s;
  if (*q == '+' || *q == '-') q++;
  int digits = 0;
  while (isDigit(*q)) { q++; digits++; }
  if (*q == '.') {
    q++;
    while (isDigit(*q)) { q++; digits++; }
  }
  if (digits == 0) return false;
  if (*q != '\0' && !isSpace(*q)) return false;
  float v = strtof(s, nullptr);  // reads exactly the validated characters
  if (!isfinite(v)) return false;
  *out = v;
  *p = q;
  return true;
}

inline const char* skipSpaces(const char* p) {
  while (isSpace(*p)) p++;
  return p;
}

// Copies one whitespace-free token into dst (capacity cap incl. NUL).
// Returns false if the token is empty or too long.
inline bool copyToken(const char** p, char* dst, size_t cap) {
  const char* s = *p;
  size_t n = 0;
  while (s[n] != '\0' && !isSpace(s[n])) n++;
  if (n == 0 || n >= cap) return false;
  memcpy(dst, s, n);
  dst[n] = '\0';
  *p = s + n;
  return true;
}

// Parses one line (without '\n'). The caller guarantees the line holds only
// printable ASCII and tabs and is at most MAX_LINE characters long.
inline Command parseLineRaw(const char* line) {
  Command cmd;
  const char* p = skipSpaces(line);

  // Trim trailing whitespace by computing the effective end.
  const char* end = p + strlen(p);
  while (end > p && isSpace(end[-1])) end--;
  if (end == p) {
    cmd.type = Cmd::Empty;
    return cmd;
  }

  // Work on a trimmed, NUL-terminated copy so "end of token" is simple.
  char buf[MAX_LINE + 1];
  size_t len = (size_t)(end - p);
  if (len > MAX_LINE) return cmd;  // Invalid
  memcpy(buf, p, len);
  buf[len] = '\0';

  const char letter = buf[0];
  if (buf[1] != '\0' && !isSpace(buf[1])) return cmd;  // command is one letter
  const char* a = skipSpaces(buf + 1);                 // start of arguments

  switch (letter) {
    case 'D': {
      for (size_t i = 0; i < NUM_ESC; i++) {
        a = skipSpaces(a);
        float v;
        if (!parseNumber(&a, &v)) return cmd;
        if (v < -1.0f || v > 1.0f) return cmd;
        cmd.value[i] = v;
      }
      if (*skipSpaces(a) != '\0') return cmd;  // nothing after 3 numbers
      cmd.type = Cmd::Drive;
      return cmd;
    }
    case 'S':
      if (*a != '\0') return cmd;
      cmd.type = Cmd::Stop;
      return cmd;
    case 'P':
      if (*a != '\0') return cmd;
      cmd.type = Cmd::Ping;
      return cmd;
    case 'G':
      if (*a != '\0') return cmd;
      cmd.type = Cmd::Get;
      return cmd;
    case 'L':
      if (*a != '\0') return cmd;
      cmd.type = Cmd::Scan;
      return cmd;
    case 'R':
      if (*a == '\0') {
        cmd.report = ReportMode::Once;
      } else if (strcmp(a, "1") == 0) {
        cmd.report = ReportMode::StreamOn;
      } else if (strcmp(a, "0") == 0) {
        cmd.report = ReportMode::StreamOff;
      } else {
        return cmd;
      }
      cmd.type = Cmd::Report;
      return cmd;
    case 'M': {
      // SSID: one token (no spaces). Password: rest of the line, may contain
      // spaces, may be empty (open network).
      if (!copyToken(&a, cmd.ssid, sizeof(cmd.ssid))) return cmd;
      a = skipSpaces(a);
      size_t plen = strlen(a);
      if (plen > PASSWORD_MAX_CHARS) return cmd;
      memcpy(cmd.password, a, plen + 1);
      cmd.type = Cmd::WifiJoin;
      return cmd;
    }
    case 'U': {
      if (!copyToken(&a, cmd.url, sizeof(cmd.url))) return cmd;
      if (*skipSpaces(a) != '\0') return cmd;  // URL must not contain spaces
      if (strncmp(cmd.url, "http://", 7) != 0 && strncmp(cmd.url, "https://", 8) != 0) {
        return cmd;
      }
      cmd.type = Cmd::SetUrl;
      return cmd;
    }
    default:
      return cmd;
  }
}

// Public entry point: a malformed line yields a clean Command with no
// leftover fields from a partial parse (never half-applied).
inline Command parseLine(const char* line) {
  Command cmd = parseLineRaw(line);
  if (cmd.type == Cmd::Invalid) return Command{};
  return cmd;
}

inline int clampUs(long us) {
  if (us < MIN_US) return MIN_US;
  if (us > MAX_US) return MAX_US;
  return (int)us;
}

// value -1..1 (fraction of the full ESC range) -> pulse width, hard-clamped.
inline int valueToUs(float v) {
  if (!(v >= -1.0f && v <= 1.0f)) v = 0.0f;  // also catches NaN
  if (!ESC_BIDIRECTIONAL && v < 0.0f) v = 0.0f;
  return clampUs(NEUTRAL_US + lroundf(v * (float)US_PER_UNIT));
}

// Pulse width -> LEDC duty (rounded): duty = us * 2^bits / period_us.
inline uint32_t usToDuty(int us) {
  const uint64_t num = (uint64_t)us * (1ULL << PWM_BITS) * PWM_FREQ_HZ;
  return (uint32_t)((num + 500000ULL) / 1000000ULL);
}

}  // namespace proto
