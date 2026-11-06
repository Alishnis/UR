// Mission 1 helpers that need no Arduino: HTTP body handling and text cleanup.
// Unit-tested natively in tests/firmware/test_mission1_text.cpp.
#pragma once  // include only once per file

#include <stddef.h>  // size_t
#include <stdint.h>  // uint8_t
#include <stdio.h>   // snprintf()
#include <string.h>  // strnlen()

namespace m1text {  // used as m1text::Body, m1text::ChunkedDecoder, ...

// Fixed-capacity body buffer. Bytes beyond the capacity are counted, never stored.
// (A template: CAP is chosen where it is used, e.g. Body<2048>.)
template <size_t CAP>
struct Body {
  char data[CAP + 1];               // the stored bytes, +1 for the closing '\0'
  size_t len = 0;                   // how many bytes are stored
  size_t seen = 0;  // all bytes offered, including dropped ones
  Body() { data[0] = '\0'; }        // start as an empty string
  void add(uint8_t b) {             // offer one byte
    seen++;                         // always count it
    if (len < CAP) {                // store it only while there is room
      data[len++] = (char)b;
      data[len] = '\0';             // keep it a valid C string
    }
  }
  bool truncated() const { return seen > len; }  // some bytes did not fit
};

// Incremental decoder for "Transfer-Encoding: chunked". Feed raw bytes as they arrive
// (any split, even one byte at a time); payload bytes go to emit(uint8_t).
// Chunked format: "<hex size>\r\n<that many bytes>\r\n" repeated, ended by "0\r\n\r\n".
class ChunkedDecoder {
 public:
  bool done() const { return state_ == State::Done; }    // the final 0-size chunk was read
  bool error() const { return state_ == State::Error; }  // the data broke the format

  template <typename Emit>
  void feed(const uint8_t* p, size_t n, Emit emit) {     // process n received bytes
    for (size_t i = 0; i < n && state_ != State::Done && state_ != State::Error; i++) {
      step(p[i], emit);                                  // one byte at a time
    }
  }

 private:
  // Where we are inside the chunked stream.
  enum class State : uint8_t { SizeLine, Data, DataEnd, Trailer, Done, Error };
  static constexpr size_t kMaxSizeLine = 24;  // hex size + optional ";extension"

  template <typename Emit>
  void step(uint8_t c, Emit emit) {
    switch (state_) {
      case State::SizeLine:                     // reading "<hex size>\r\n"
        if (c == '\n') {                        // end of the size line
          finishSizeLine();
        } else if (c != '\r') {                 // collect the characters, skip '\r'
          if (lineLen_ >= kMaxSizeLine) { state_ = State::Error; return; }  // absurdly long
          line_[lineLen_++] = (char)c;
        }
        return;
      case State::Data:                         // inside a chunk: pass bytes on
        emit(c);
        if (--remaining_ == 0) state_ = State::DataEnd;  // chunk finished
        return;
      case State::DataEnd:  // the CRLF after the data
        if (c == '\n') { lineLen_ = 0; state_ = State::SizeLine; }  // next chunk's size
        else if (c != '\r') state_ = State::Error;                  // anything else is broken
        return;
      case State::Trailer:  // ignore trailer lines until the empty one
        if (c == '\n') {
          if (lineLen_ == 0) state_ = State::Done;  // empty line: the end
          lineLen_ = 0;
        } else if (c != '\r') {
          lineLen_++;                               // count trailer characters, ignore them
        }
        return;
      default:                                      // Done or Error: nothing more to do
        return;
    }
  }

  // Turns the collected hex size line into a number and picks the next state.
  void finishSizeLine() {
    size_t size = 0;                                // the chunk size
    size_t digits = 0;                              // hex digits seen
    for (size_t i = 0; i < lineLen_; i++) {
      char c = line_[i];
      int v;                                        // value of this hex digit
      if (c >= '0' && c <= '9') v = c - '0';
      else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
      else if (c == ';' || c == ' ' || c == '\t') break;  // extension / padding: ignore the rest
      else { state_ = State::Error; return; }              // not hex: broken
      if (++digits > 7) { state_ = State::Error; return; }  // bigger than 256 MB: nonsense
      size = size * 16 + (size_t)v;                        // add the digit (base 16)
    }
    if (digits == 0) { state_ = State::Error; return; }   // empty size line
    lineLen_ = 0;
    if (size == 0) {                // size 0 = last chunk, then optional trailer lines
      state_ = State::Trailer;
    } else {                        // read "size" data bytes next
      remaining_ = size;
      state_ = State::Data;
    }
  }

  State state_ = State::SizeLine;   // start by reading a size line
  char line_[kMaxSizeLine];         // the size line being collected
  size_t lineLen_ = 0;              // its length so far
  size_t remaining_ = 0;            // data bytes left in the current chunk
};

// Printable ASCII only; everything else becomes '?'. Writes at most cap-1 chars + NUL.
inline void sanitize(char* dst, size_t cap, const char* src, size_t n) {
  if (cap == 0) return;                                  // no room at all
  size_t o = 0;                                          // write position
  for (size_t i = 0; i < n && o + 1 < cap; i++) {        // leave room for the '\0'
    unsigned char c = (unsigned char)src[i];
    dst[o++] = (c >= 0x20 && c <= 0x7E) ? (char)c : '?'; // keep printable, replace the rest
  }
  dst[o] = '\0';                                         // end the string
}

// How many lines forEachBodyLine() printed and how many it skipped.
struct LineStats {
  size_t emitted = 0;  // lines passed to emit
  size_t dropped = 0;  // non-empty lines beyond maxLines
};

// Splits body on \n, strips \r and surrounding blanks, skips empty lines, cuts lines
// to maxLen, sanitizes, and calls emit(const char* line) for at most maxLines lines.
template <typename Emit>
LineStats forEachBodyLine(const char* body, size_t len, size_t maxLines, size_t maxLen, Emit emit) {
  LineStats st;
  size_t i = 0;                                       // start of the current line
  char out[512];                                      // cleaned line buffer
  const size_t cap = (maxLen + 1 < sizeof(out)) ? maxLen + 1 : sizeof(out);  // cut length
  while (i < len) {
    size_t j = i;                                     // find the end of this line
    while (j < len && body[j] != '\n') j++;
    size_t a = i, b = j;                              // trim spaces / tabs / '\r' on both ends
    while (a < b && (body[a] == ' ' || body[a] == '\t' || body[a] == '\r')) a++;
    while (b > a && (body[b - 1] == ' ' || body[b - 1] == '\t' || body[b - 1] == '\r')) b--;
    if (b > a) {                                      // skip empty lines
      if (st.emitted < maxLines) {                    // still allowed to print
        sanitize(out, cap, body + a, b - a);          // clean and cut
        emit((const char*)out);                       // hand it to the caller (prints "N got:")
        st.emitted++;
      } else {
        st.dropped++;                                 // over the limit: only count
      }
    }
    i = j + 1;                                        // next line starts after '\n'
  }
  return st;
}

// Wi-Fi scan list: indexes of the strongest networks first (stable for equal RSSI), at most cap.
// Returns how many were written to order[].
inline size_t strongestFirst(const int* rssi, size_t n, size_t* order, size_t cap) {
  size_t k = 0;                                       // entries kept so far
  for (size_t i = 0; i < n; i++) {                    // every network found
    // insertion into the sorted prefix; an entry weaker than all kept ones is dropped once full
    size_t pos = k;                                   // where network i belongs
    while (pos > 0 && rssi[order[pos - 1]] < rssi[i]) pos--;   // move up past weaker ones
    if (pos >= cap) continue;                         // list full and i is the weakest: skip
    const size_t last = k < cap ? k : cap - 1;        // last slot to shift into
    for (size_t j = last; j > pos; j--) order[j] = order[j - 1];  // make room at pos
    order[pos] = i;                                   // insert
    if (k < cap) k++;                                 // list grew (until it is full)
  }
  return k;
}

// Text of one "N net:" line: "-48 dBm ch 6 secured UR_Field". The SSID goes last (it may contain
// spaces) and is cleaned like body text; a hidden network shows as "(hidden)".
inline void formatNet(char* out, size_t cap, int rssi, int channel, bool open, const char* ssid) {
  char name[33];                                      // up to 32 chars + '\0'
  const size_t n = strnlen(ssid, 32);                 // SSID length, at most 32
  sanitize(name, sizeof(name), ssid, n);              // printable characters only
  snprintf(out, cap, "%d dBm ch %d %s %s", rssi, channel, open ? "open" : "secured",
           n ? name : "(hidden)");                    // empty SSID = hidden network
}

}  // namespace m1text
