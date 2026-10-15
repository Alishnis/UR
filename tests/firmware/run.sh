#!/bin/sh
# Builds and runs the native firmware tests on the laptop.
set -e
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/rov_test"
for t in test_protocol test_mission1_text test_timing; do
  c++ -std=c++17 -Wall -Wextra -Werror -o "$OUT.$t" "$t.cpp"
  echo "== $t"
  "$OUT.$t"
done
