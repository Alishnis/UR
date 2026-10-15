// Mission 1: the ESP32 joins the Wi-Fi tower (station mode) and fetches a text string over HTTP.
// Commands M / U / G arrive over serial (see docs/PROTOCOL.md); results leave as `N ...` lines.
#pragma once

#include <stdint.h>

namespace m1 {

void connect(const char* ssid, const char* password);  // M: start joining, returns at once
void setUrl(const char* url);                          // U
void get();                                            // G: blocking, at most ~15 s
void poll(uint32_t nowMs);                             // call from loop(): connection progress

}  // namespace m1

// Implemented in main.cpp.
void stopAllThrusters();  // called before every blocking Wi-Fi / HTTP call
void afterBlockingGet();  // drop stale serial input, keep the watchdog from tripping
