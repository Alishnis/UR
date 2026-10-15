// Native unit tests for src/mission1_text.h. Run: sh tests/firmware/run.sh

#include <stdio.h>
#include <string>
#include <vector>

#include "../../src/mission1_text.h"

static int g_failed = 0;
static int g_passed = 0;

#define CHECK(cond)                                          \
  do {                                                       \
    if (cond) {                                              \
      g_passed++;                                            \
    } else {                                                 \
      g_failed++;                                            \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
    }                                                        \
  } while (0)

using m1text::ChunkedDecoder;

// Decodes `raw` fed in pieces of `piece` bytes. Returns the payload; sets done/error.
static std::string decode(const std::string& raw, size_t piece, bool* done, bool* error) {
  ChunkedDecoder d;
  std::string out;
  for (size_t i = 0; i < raw.size(); i += piece) {
    size_t n = raw.size() - i < piece ? raw.size() - i : piece;
    d.feed((const uint8_t*)raw.data() + i, n, [&](uint8_t b) { out.push_back((char)b); });
  }
  *done = d.done();
  *error = d.error();
  return out;
}

static void testChunked() {
  const std::string basic = "5\r\nHello\r\n7\r\n, world\r\n0\r\n\r\n";
  for (size_t piece : {size_t(1), size_t(2), size_t(3), size_t(7), size_t(1000)}) {
    bool done, error;
    std::string out = decode(basic, piece, &done, &error);
    CHECK(out == "Hello, world");
    CHECK(done);
    CHECK(!error);
  }
  bool done, error;
  // hex sizes, upper/lower case, extension, trailer headers
  std::string out = decode("A;ext=1\r\n0123456789\r\nb\r\nabcdefghijk\r\n0\r\nX-Trailer: 1\r\n\r\n", 1, &done, &error);
  CHECK(out == "0123456789abcdefghijk");
  CHECK(done && !error);
  // bare LF line endings are tolerated
  out = decode("3\nabc\n0\n\n", 2, &done, &error);
  CHECK(out == "abc" && done && !error);
  // payload containing CR/LF bytes is not confused with framing
  out = decode("4\r\na\r\nb\r\n0\r\n\r\n", 1, &done, &error);
  CHECK(out == "a\r\nb" && done && !error);
  // incomplete stream: not done, no error
  out = decode("5\r\nHel", 1, &done, &error);
  CHECK(out == "Hel" && !done && !error);
  // bytes after the final chunk are ignored
  out = decode("1\r\nx\r\n0\r\n\r\nGARBAGE", 4, &done, &error);
  CHECK(out == "x" && done && !error);
  // errors
  decode("zz\r\n", 1, &done, &error);
  CHECK(error && !done);
  decode("\r\n", 1, &done, &error);  // no digits
  CHECK(error);
  decode("fffffffff\r\n", 1, &done, &error);  // absurd size
  CHECK(error);
  decode(std::string(40, '1') + "\r\n", 1, &done, &error);  // runaway size line
  CHECK(error);
  decode("1\r\nxZ", 1, &done, &error);  // missing CRLF after the data
  CHECK(error);
  // after an error nothing more is emitted
  out = decode("zz\r\n5\r\nHello\r\n0\r\n\r\n", 1, &done, &error);
  CHECK(out.empty() && error);
}

static void testBody() {
  m1text::Body<8> b;
  for (char c : std::string("0123456789")) b.add((uint8_t)c);
  CHECK(std::string(b.data) == "01234567");
  CHECK(b.len == 8 && b.seen == 10 && b.truncated());
  m1text::Body<8> small;
  small.add('a');
  CHECK(std::string(small.data) == "a" && !small.truncated());
}

static std::vector<std::string> lines(const std::string& body, size_t maxLines, size_t maxLen,
                                      m1text::LineStats* st = nullptr) {
  std::vector<std::string> out;
  m1text::LineStats s = m1text::forEachBodyLine(body.data(), body.size(), maxLines, maxLen,
                                                [&](const char* l) { out.push_back(l); });
  if (st) *st = s;
  return out;
}

static void testLines() {
  auto v = lines("Congratulations!!! This is the WiFi API task message for the fall training.", 20, 300);
  CHECK(v.size() == 1);
  CHECK(v[0] == "Congratulations!!! This is the WiFi API task message for the fall training.");

  v = lines("one\r\n\r\n  two  \n\n\nthree", 20, 300);
  CHECK((v == std::vector<std::string>{"one", "two", "three"}));

  v = lines("", 20, 300);
  CHECK(v.empty());
  v = lines("\n\r\n   \n", 20, 300);
  CHECK(v.empty());

  m1text::LineStats st;
  v = lines("a\nb\nc\nd\ne", 3, 300, &st);
  CHECK((v == std::vector<std::string>{"a", "b", "c"}));
  CHECK(st.emitted == 3 && st.dropped == 2);

  v = lines("abcdefghij", 20, 4);
  CHECK(v.size() == 1 && v[0] == "abcd");

  // non-ASCII / control bytes never reach the serial protocol as-is
  v = lines(std::string("caf\xc3\xa9 \x01ok"), 20, 300);
  CHECK(v.size() == 1 && v[0] == "caf?? ?ok");

  // very long maxLen is clamped to the internal buffer, never overflows
  v = lines(std::string(2000, 'x'), 20, 100000);
  CHECK(v.size() == 1 && v[0].size() == 511);
}

int main() {
  testChunked();
  testBody();
  testLines();
  printf("%d passed, %d failed\n", g_passed, g_failed);
  return g_failed == 0 ? 0 : 1;
}
