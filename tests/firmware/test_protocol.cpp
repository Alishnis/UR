// Native (laptop) unit tests for src/protocol.h. No board needed.
// Run:  sh tests/firmware/run.sh

#include <stdio.h>
#include <string>

#include "../../src/protocol.h"

static int g_failed = 0;
static int g_passed = 0;

#define CHECK(cond)                                                    \
  do {                                                                 \
    if (cond) {                                                        \
      g_passed++;                                                      \
    } else {                                                           \
      g_failed++;                                                      \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);           \
    }                                                                  \
  } while (0)

using proto::Cmd;
using proto::parseLine;

static Cmd typeOf(const char* line) { return parseLine(line).type; }

static void testDrive() {
  proto::Command c = parseLine("D 0.100 -0.250 1.000");
  CHECK(c.type == Cmd::Drive);
  CHECK(c.value[0] == 0.1f);
  CHECK(c.value[1] == -0.25f);
  CHECK(c.value[2] == 1.0f);

  CHECK(typeOf("D 0 0 0") == Cmd::Drive);
  CHECK(typeOf("D -1 1 -0") == Cmd::Drive);
  CHECK(typeOf("D +.5 -.5 1.") == Cmd::Drive);
  CHECK(typeOf("  D\t0  0 0  ") == Cmd::Drive);  // extra whitespace is fine

  // Malformed: never applied.
  CHECK(typeOf("D") == Cmd::Invalid);
  CHECK(typeOf("D 0 0") == Cmd::Invalid);           // too few
  CHECK(typeOf("D 0 0 0 0") == Cmd::Invalid);       // too many
  CHECK(typeOf("D 0 0 x") == Cmd::Invalid);
  CHECK(typeOf("D 0 0 0x") == Cmd::Invalid);
  CHECK(typeOf("D 1.001 0 0") == Cmd::Invalid);     // out of range
  CHECK(typeOf("D 0 -1.0001 0") == Cmd::Invalid);
  CHECK(typeOf("D 2 0 0") == Cmd::Invalid);
  CHECK(typeOf("D nan 0 0") == Cmd::Invalid);
  CHECK(typeOf("D inf 0 0") == Cmd::Invalid);
  CHECK(typeOf("D 1e0 0 0") == Cmd::Invalid);       // no exponent
  CHECK(typeOf("D 0x1 0 0") == Cmd::Invalid);       // no hex
  CHECK(typeOf("D . 0 0") == Cmd::Invalid);
  CHECK(typeOf("D - 0 0") == Cmd::Invalid);
  CHECK(typeOf("D 0,5 0 0") == Cmd::Invalid);
  CHECK(typeOf("D 0 0 0 junk") == Cmd::Invalid);
  CHECK(typeOf("DD 0 0 0") == Cmd::Invalid);
  CHECK(typeOf("D0 0 0") == Cmd::Invalid);
  CHECK(typeOf("d 0 0 0") == Cmd::Invalid);         // case-sensitive
  CHECK(typeOf("D 99999999999999999999999 0 0") == Cmd::Invalid);
}

static void testSimpleCommands() {
  CHECK(typeOf("") == Cmd::Empty);
  CHECK(typeOf("   \t ") == Cmd::Empty);
  CHECK(typeOf("S") == Cmd::Stop);
  CHECK(typeOf(" S ") == Cmd::Stop);
  CHECK(typeOf("S 1") == Cmd::Invalid);
  CHECK(typeOf("P") == Cmd::Ping);
  CHECK(typeOf("P x") == Cmd::Invalid);
  CHECK(typeOf("PING") == Cmd::Invalid);
  CHECK(typeOf("G") == Cmd::Get);
  CHECK(typeOf("G now") == Cmd::Invalid);
  CHECK(typeOf("L") == Cmd::Scan);
  CHECK(typeOf("  L \t") == Cmd::Scan);
  CHECK(typeOf("L 1") == Cmd::Invalid);
  CHECK(typeOf("LL") == Cmd::Invalid);
  CHECK(typeOf("l") == Cmd::Invalid);
  CHECK(typeOf("X") == Cmd::Invalid);
  CHECK(typeOf("T 1500 1500 1500") == Cmd::Invalid);  // our own output echoed back

  CHECK(parseLine("R").report == proto::ReportMode::Once);
  CHECK(parseLine("R 1").report == proto::ReportMode::StreamOn);
  CHECK(parseLine("R 0").report == proto::ReportMode::StreamOff);
  CHECK(typeOf("R 1") == Cmd::Report);
  CHECK(typeOf("R 2") == Cmd::Invalid);
  CHECK(typeOf("R 1 1") == Cmd::Invalid);
}

static void testMission1Commands() {
  proto::Command c = parseLine("M UR_Field 12345678");
  CHECK(c.type == Cmd::WifiJoin);
  CHECK(std::string(c.ssid) == "UR_Field");
  CHECK(std::string(c.password) == "12345678");

  c = parseLine("M Net pass with spaces ");  // password = rest of line, trimmed
  CHECK(c.type == Cmd::WifiJoin);
  CHECK(std::string(c.password) == "pass with spaces");

  c = parseLine("M OpenNet");  // open network
  CHECK(c.type == Cmd::WifiJoin);
  CHECK(std::string(c.password).empty());

  CHECK(typeOf("M") == Cmd::Invalid);
  CHECK(typeOf("M 123456789012345678901234567890123 pw") == Cmd::Invalid);  // SSID 33
  CHECK(typeOf("M 12345678901234567890123456789012 pw") == Cmd::WifiJoin);  // SSID 32
  std::string longPw = "M n " + std::string(64, 'p');
  CHECK(typeOf(longPw.c_str()) == Cmd::Invalid);
  std::string maxPw = "M n " + std::string(63, 'p');
  CHECK(typeOf(maxPw.c_str()) == Cmd::WifiJoin);

  c = parseLine("U http://192.168.4.1/token.txt");
  CHECK(c.type == Cmd::SetUrl);
  CHECK(std::string(c.url) == "http://192.168.4.1/token.txt");
  CHECK(typeOf("U https://x.y/") == Cmd::SetUrl);
  CHECK(typeOf("U") == Cmd::Invalid);
  CHECK(typeOf("U ftp://x") == Cmd::Invalid);
  CHECK(typeOf("U http://a b") == Cmd::Invalid);
}

static void testPulseMath() {
  // Bidirectional defaults: 1500 +/- 150 us clamp.
  static_assert(ESC_BIDIRECTIONAL, "tests below assume the bidirectional default");
  static_assert(MAX_DELTA_US == 150, "tests below assume the 150 us default clamp");
  CHECK(proto::valueToUs(0.0f) == 1500);
  CHECK(proto::valueToUs(0.1f) == 1550);
  CHECK(proto::valueToUs(-0.1f) == 1450);
  CHECK(proto::valueToUs(0.3f) == 1650);
  CHECK(proto::valueToUs(0.31f) == 1650);   // clamped
  CHECK(proto::valueToUs(1.0f) == 1650);
  CHECK(proto::valueToUs(-1.0f) == 1350);
  CHECK(proto::valueToUs(0.001f) == 1501);  // 0.5 us rounds away from zero
  CHECK(proto::valueToUs(-0.001f) == 1499);
  CHECK(proto::valueToUs(NAN) == 1500);
  CHECK(proto::valueToUs(5.0f) == 1500);    // invalid input -> neutral

  CHECK(proto::clampUs(0) == 1350);
  CHECK(proto::clampUs(99999) == 1650);

  // 50 Hz, 14 bit: duty = us * 16384 / 20000
  CHECK(proto::usToDuty(1500) == 1229);
  CHECK(proto::usToDuty(1000) == 819);
  CHECK(proto::usToDuty(2000) == 1638);
  CHECK(proto::usToDuty(1350) == 1106);
  CHECK(proto::usToDuty(1650) == 1352);
  // Quantization error must stay far below the 10 us readback tolerance.
  for (int us = MIN_US; us <= MAX_US; us++) {
    double back = proto::usToDuty(us) * 20000.0 / 16384.0;
    double err = back - us;
    if (err < 0) err = -err;
    CHECK(err <= 0.62);
  }
}

static void testPinTable() {
  CHECK(pinsValid());
  CHECK(pinsDistinct());
  CHECK(isForbiddenPin(0) && isForbiddenPin(3) && isForbiddenPin(45) && isForbiddenPin(46));
  CHECK(isForbiddenPin(19) && isForbiddenPin(20));
  CHECK(isForbiddenPin(26) && isForbiddenPin(37));
  CHECK(isForbiddenPin(43) && isForbiddenPin(44));
  CHECK(!isForbiddenPin(1) && !isForbiddenPin(42) && !isForbiddenPin(40));
  CHECK(isPwmPin(1) && isPwmPin(21) && isPwmPin(48) && !isPwmPin(22) && !isPwmPin(46));
}

int main() {
  testDrive();
  testSimpleCommands();
  testMission1Commands();
  testPulseMath();
  testPinTable();
  printf("%d passed, %d failed\n", g_passed, g_failed);
  return g_failed == 0 ? 0 : 1;
}
