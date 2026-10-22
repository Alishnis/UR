// Reads lines from stdin, prints how the firmware parser sees each one.
// Used by host/tests/test_protocol_twin.py to prove the Python mock parses
// exactly like the firmware. Output per line:
//   type|v0|v1|v2|report|ssid|password|url|us0|us1|us2

#include <stdio.h>
#include <string.h>

#include "../../src/protocol.h"

static const char* typeName(proto::Cmd t) {
  switch (t) {
    case proto::Cmd::Empty: return "empty";
    case proto::Cmd::Invalid: return "invalid";
    case proto::Cmd::Drive: return "drive";
    case proto::Cmd::Stop: return "stop";
    case proto::Cmd::Ping: return "ping";
    case proto::Cmd::Report: return "report";
    case proto::Cmd::WifiJoin: return "wifi";
    case proto::Cmd::SetUrl: return "url";
    case proto::Cmd::Get: return "get";
    case proto::Cmd::Scan: return "scan";
  }
  return "?";
}

int main() {
  static char buf[4096];
  while (fgets(buf, sizeof(buf), stdin)) {
    size_t n = strlen(buf);
    if (n && buf[n - 1] == '\n') buf[--n] = '\0';
    const proto::Command c = proto::parseLine(buf);
    const bool drive = c.type == proto::Cmd::Drive;
    printf("%s|%.9g|%.9g|%.9g|%d|%s|%s|%s|%d|%d|%d\n", typeName(c.type),
           drive ? c.value[0] : 0.0, drive ? c.value[1] : 0.0, drive ? c.value[2] : 0.0,
           c.type == proto::Cmd::Report ? (int)c.report : -1, c.ssid, c.password, c.url,
           drive ? proto::valueToUs(c.value[0]) : 0, drive ? proto::valueToUs(c.value[1]) : 0,
           drive ? proto::valueToUs(c.value[2]) : 0);
  }
  return 0;
}
