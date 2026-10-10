#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test_binary=$(mktemp /tmp/nucode-tests.XXXXXX)
trap 'rm -f "$test_binary"' EXIT HUP INT TERM
c++ -std=c++11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -fno-omit-frame-pointer -Itest/native -Isrc \
  test/native/test_firmware.cpp src/sensors/nmea_parser.cpp \
  src/sensors/pulse_sensor.cpp src/sensors/tmp36.cpp src/comm/i2c_bus.cpp \
  -o "$test_binary"
"$test_binary"
python3 -m unittest discover -s test -p 'test_*.py' -v
