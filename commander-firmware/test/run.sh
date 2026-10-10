#!/bin/sh
# Native tests for the gateway logic, then an end-to-end check that the
# backend's own parser accepts the lines the gateway prints.
set -eu
cd "$(dirname "$0")"
binary=$(mktemp "${TMPDIR:-/tmp}/gateway-tests.XXXXXX")
trap 'rm -f "$binary"' EXIT HUP INT TERM
c++ -std=c++11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -fno-omit-frame-pointer test_gateway_core.cpp -o "$binary"
"$binary"
"$binary" --emit | (cd ../../commander-hq/backend && python3 -c '
import sys
from app.protocol import parse_gateway_line
lines = sys.stdin.read().splitlines()
packets = [parse_gateway_line(line) for line in lines]
assert len(packets) == 2 and all(packets), packets
spec, edge = packets
assert (spec.soldier_id, spec.seq, spec.code, spec.hr_bpm, spec.hops, spec.rssi) == (3, 7, 1, 141, 1, -63), spec
assert (spec.skin_temp_c, spec.x_m, spec.y_m) == (34.56, 123.4, -5.6), spec
assert (edge.soldier_id, edge.seq, edge.skin_temp_c, edge.x_m, edge.rssi) == (255, 65535, -1.5, -0.1, -128), edge
print("backend parser: accepted gateway output")
')
