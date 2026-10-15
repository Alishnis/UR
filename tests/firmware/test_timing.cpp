// Native unit tests for src/timing.h. Run: sh tests/firmware/run.sh
#include <stdio.h>

#include "../../src/timing.h"

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

int main() {
  // normal use
  CHECK(!elapsedAtLeast(1000, 0, 1001));
  CHECK(elapsedAtLeast(1000, 0, 1000));
  CHECK(!elapsedMoreThan(1000, 0, 1000));
  CHECK(elapsedMoreThan(1001, 0, 1000));
  CHECK(elapsedAtLeast(5, 5, 0));

  // THE BUG: `since` taken a few ms after `now` was read (command handler called millis()).
  // The old unsigned code saw ~4 billion ms elapsed and timed out immediately.
  const uint32_t now = 100000;
  const uint32_t startedLater = now + 7;
  CHECK((uint32_t)(now - startedLater) > 15000u);  // documents the old, broken behaviour
  CHECK(!elapsedMoreThan(now, startedLater, 15000));
  CHECK(!elapsedAtLeast(now, startedLater, 15000));
  CHECK(!elapsedAtLeast(now, startedLater, 1));  // not even 1 ms has passed
  CHECK(elapsedMs(now, startedLater) == -7);

  // ...and the timeout still fires at the right moment afterwards.
  CHECK(!elapsedMoreThan(startedLater + 15000, startedLater, 15000));
  CHECK(elapsedMoreThan(startedLater + 15001, startedLater, 15000));

  // across the millis() wrap (every 49.7 days)
  const uint32_t nearWrap = 0xFFFFFF00u;
  CHECK(!elapsedAtLeast(nearWrap + 100u, nearWrap, 500));
  CHECK(elapsedAtLeast(nearWrap + 500u, nearWrap, 500));  // wraps past zero
  // 0xFFFFFF00 + 500 wraps to 0xF4: exactly 500 ms later
  CHECK(elapsedAtLeast(0x000000F4u, nearWrap, 500));
  CHECK(!elapsedAtLeast(0x000000F3u, nearWrap, 500));  // 499 ms

  printf("%d passed, %d failed\n", g_passed, g_failed);
  return g_failed == 0 ? 0 : 1;
}
