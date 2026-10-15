// Reads hex-encoded bodies from stdin (one per line), prints how the firmware splits them into
// "N got:" lines. Used by host/tests/test_mission1_twin.py.
// Output per body: line1<TAB>line2...|emitted|dropped   (lines are printable ASCII, never contain TAB)

#include <stdio.h>
#include <string.h>
#include <string>
#include <vector>

#include "../../src/config.h"
#include "../../src/mission1_text.h"

int main() {
  static char buf[1 << 16];
  while (fgets(buf, sizeof(buf), stdin)) {
    size_t n = strlen(buf);
    while (n && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) buf[--n] = '\0';
    std::string body;
    for (size_t i = 0; i + 1 < n; i += 2) {
      unsigned v;
      sscanf(buf + i, "%2x", &v);
      body.push_back((char)v);
    }
    std::string joined;
    bool first = true;
    m1text::LineStats st = m1text::forEachBodyLine(
        body.data(), body.size(), MAX_GOT_LINES, MAX_GOT_LINE_LEN, [&](const char* l) {
          if (!first) joined += '\t';
          first = false;
          joined += l;
        });
    printf("%s|%zu|%zu\n", joined.c_str(), st.emitted, st.dropped);
  }
  return 0;
}
