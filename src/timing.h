// Elapsed-time checks on millis() timestamps. Pure, unit-tested in tests/firmware/test_timing.cpp.
//
// Plain `now - since > limit` on uint32_t breaks when `since` is a little newer than `now`
// (e.g. `since` was taken with millis() inside a command handler, after loop() had already
// read `now`): the subtraction wraps to ~4 billion and the timeout fires at once. The Wi-Fi
// "timeout after 15 s" that came instantly was exactly this. Compare as signed instead.
#pragma once  // include this header only once per file, even if #included twice

#include <stdint.h>  // fixed-size integer types: uint32_t (unsigned 32-bit), int32_t (signed 32-bit)

// Milliseconds from `since` to `now`; negative if `since` is (slightly) in the future.
// The unsigned subtraction wraps around correctly; casting the result to signed turns
// "a few ms in the future" into a small negative number instead of ~4 billion.
inline int32_t elapsedMs(uint32_t now, uint32_t since) { return (int32_t)(now - since); }

// True once at least `ms` have passed. Safe across the 49-day millis() wrap.
inline bool elapsedAtLeast(uint32_t now, uint32_t since, uint32_t ms) {
  const int32_t d = elapsedMs(now, since);  // time passed, may be negative (see above)
  return d >= 0 && (uint32_t)d >= ms;       // not in the future AND at least ms passed
}

// True once MORE than `ms` have passed.
inline bool elapsedMoreThan(uint32_t now, uint32_t since, uint32_t ms) {
  const int32_t d = elapsedMs(now, since);  // time passed, may be negative
  return d >= 0 && (uint32_t)d > ms;        // not in the future AND strictly more than ms
}
