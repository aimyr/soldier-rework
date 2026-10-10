#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test_binary=$(mktemp /tmp/nucode-tests.XXXXXX)
dmp_binary="${test_binary}.dmp"
node_binary="${test_binary}.node"
trap 'rm -f "$test_binary" "$dmp_binary" "$node_binary"' EXIT HUP INT TERM
flags="-std=c++11 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -DSOLDIER_ID=1 -Itest/native -Isrc"
c++ $flags \
  test/native/test_firmware.cpp src/sensors/nmea_parser.cpp \
  src/sensors/pulse_sensor.cpp src/sensors/tmp36.cpp src/comm/i2c_bus.cpp \
  -o "$test_binary"
"$test_binary"
c++ $flags test/native/test_dmp.cpp src/sensors/imu.cpp -o "$dmp_binary"
"$dmp_binary"
c++ $flags test/native/test_node.cpp src/node/rules.cpp src/node/motion.cpp \
  src/node/position.cpp -o "$node_binary"
"$node_binary"
NODE_BINARY="$node_binary" python3 -m unittest discover -s test -p 'test_*.py' -v
