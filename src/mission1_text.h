// Mission 1 helpers that need no Arduino: HTTP body handling and text cleanup.
// Unit-tested natively in tests/firmware/test_mission1_text.cpp.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace m1text {

// Fixed-capacity body buffer. Bytes beyond the capacity are counted, never stored.
template <size_t CAP>
struct Body {
  char data[CAP + 1];
  size_t len = 0;
  size_t seen = 0;  // all bytes offered, including dropped ones
  Body() { data[0] = '\0'; }
  void add(uint8_t b) {
    seen++;
    if (len < CAP) {
      data[len++] = (char)b;
      data[len] = '\0';
    }
  }
  bool truncated() const { return seen > len; }
};

// Incremental decoder for "Transfer-Encoding: chunked". Feed raw bytes as they arrive
// (any split, even one byte at a time); payload bytes go to emit(uint8_t).
class ChunkedDecoder {
 public:
  bool done() const { return state_ == State::Done; }
  bool error() const { return state_ == State::Error; }

  template <typename Emit>
  void feed(const uint8_t* p, size_t n, Emit emit) {
    for (size_t i = 0; i < n && state_ != State::Done && state_ != State::Error; i++) {
      step(p[i], emit);
    }
  }

 private:
  enum class State : uint8_t { SizeLine, Data, DataEnd, Trailer, Done, Error };
  static constexpr size_t kMaxSizeLine = 24;  // hex size + optional ";extension"

  template <typename Emit>
  void step(uint8_t c, Emit emit) {
    switch (state_) {
      case State::SizeLine:
        if (c == '\n') {
          finishSizeLine();
        } else if (c != '\r') {
          if (lineLen_ >= kMaxSizeLine) { state_ = State::Error; return; }
          line_[lineLen_++] = (char)c;
        }
        return;
      case State::Data:
        emit(c);
        if (--remaining_ == 0) state_ = State::DataEnd;
        return;
      case State::DataEnd:  // the CRLF after the data
        if (c == '\n') { lineLen_ = 0; state_ = State::SizeLine; }
        else if (c != '\r') state_ = State::Error;
        return;
      case State::Trailer:  // ignore trailer lines until the empty one
        if (c == '\n') {
          if (lineLen_ == 0) state_ = State::Done;
          lineLen_ = 0;
        } else if (c != '\r') {
          lineLen_++;
        }
        return;
      default:
        return;
    }
  }

  void finishSizeLine() {
    size_t size = 0;
    size_t digits = 0;
    for (size_t i = 0; i < lineLen_; i++) {
      char c = line_[i];
      int v;
      if (c >= '0' && c <= '9') v = c - '0';
      else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
      else if (c == ';' || c == ' ' || c == '\t') break;  // extension / padding: ignore the rest
      else { state_ = State::Error; return; }
      if (++digits > 7) { state_ = State::Error; return; }  // bigger than 256 MB: nonsense
      size = size * 16 + (size_t)v;
    }
    if (digits == 0) { state_ = State::Error; return; }
    lineLen_ = 0;
    if (size == 0) {
      state_ = State::Trailer;
    } else {
      remaining_ = size;
      state_ = State::Data;
    }
  }

  State state_ = State::SizeLine;
  char line_[kMaxSizeLine];
  size_t lineLen_ = 0;
  size_t remaining_ = 0;
};

// Printable ASCII only; everything else becomes '?'. Writes at most cap-1 chars + NUL.
inline void sanitize(char* dst, size_t cap, const char* src, size_t n) {
  if (cap == 0) return;
  size_t o = 0;
  for (size_t i = 0; i < n && o + 1 < cap; i++) {
    unsigned char c = (unsigned char)src[i];
    dst[o++] = (c >= 0x20 && c <= 0x7E) ? (char)c : '?';
  }
  dst[o] = '\0';
}

struct LineStats {
  size_t emitted = 0;  // lines passed to emit
  size_t dropped = 0;  // non-empty lines beyond maxLines
};

// Splits body on \n, strips \r and surrounding blanks, skips empty lines, cuts lines
// to maxLen, sanitizes, and calls emit(const char* line) for at most maxLines lines.
template <typename Emit>
LineStats forEachBodyLine(const char* body, size_t len, size_t maxLines, size_t maxLen, Emit emit) {
  LineStats st;
  size_t i = 0;
  char out[512];
  const size_t cap = (maxLen + 1 < sizeof(out)) ? maxLen + 1 : sizeof(out);
  while (i < len) {
    size_t j = i;
    while (j < len && body[j] != '\n') j++;
    size_t a = i, b = j;
    while (a < b && (body[a] == ' ' || body[a] == '\t' || body[a] == '\r')) a++;
    while (b > a && (body[b - 1] == ' ' || body[b - 1] == '\t' || body[b - 1] == '\r')) b--;
    if (b > a) {
      if (st.emitted < maxLines) {
        sanitize(out, cap, body + a, b - a);
        emit((const char*)out);
        st.emitted++;
      } else {
        st.dropped++;
      }
    }
    i = j + 1;
  }
  return st;
}

// Wi-Fi scan list: indexes of the strongest networks first (stable for equal RSSI), at most cap.
// Returns how many were written to order[].
inline size_t strongestFirst(const int* rssi, size_t n, size_t* order, size_t cap) {
  size_t k = 0;
  for (size_t i = 0; i < n; i++) {
    // insertion into the sorted prefix; an entry weaker than all kept ones is dropped once full
    size_t pos = k;
    while (pos > 0 && rssi[order[pos - 1]] < rssi[i]) pos--;
    if (pos >= cap) continue;
    const size_t last = k < cap ? k : cap - 1;
    for (size_t j = last; j > pos; j--) order[j] = order[j - 1];
    order[pos] = i;
    if (k < cap) k++;
  }
  return k;
}

// Text of one "N net:" line: "-48 dBm ch 6 secured UR_Field". The SSID goes last (it may contain
// spaces) and is cleaned like body text; a hidden network shows as "(hidden)".
inline void formatNet(char* out, size_t cap, int rssi, int channel, bool open, const char* ssid) {
  char name[33];
  const size_t n = strnlen(ssid, 32);
  sanitize(name, sizeof(name), ssid, n);
  snprintf(out, cap, "%d dBm ch %d %s %s", rssi, channel, open ? "open" : "secured",
           n ? name : "(hidden)");
}

}  // namespace m1text
