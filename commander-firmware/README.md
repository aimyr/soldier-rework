# Commander Firmware

Gateway on a NUCODE NU-87 Tiny DK (RTL8720DF), plugged into the commander laptop. It listens for soldier-node BLE advertisements and prints each new packet over USB serial for `commander-hq` (`C2_SOURCE=serial`):

```
PKT:11030700d007018d800d02d204c8ff0c0147,RSSI:-63
```

The gateway never transmits. Packet and radio format: [docs/DATA_SPEC.md](../docs/DATA_SPEC.md) sections 5–6.

## Behaviour

- Scans continuously: passive, 100 ms interval and window, controller duplicate filter off.
- Accepts only manufacturer data with company ID `0xFFFF`, exactly 18 bytes, protocol version 1 and a valid CRC-8.
- Forwards the first copy of each `(soldier_id, seq)` within 30 s. Nodes repeat each packet in a burst and the backend does not deduplicate.
- Prints `GW,uptime_s=…,adverts=…,forwarded=…,duplicates=…,queue_drops=…` every 10 s. The backend ignores these lines. A rising `adverts` count means the scanner is running.

The BLE callback only validates and queues packets. Printing happens in `loop()`.

## Build and run

```sh
sh build.sh setup                 # once: installs Realtek AmebaD 3.1.9 core
sh build.sh build
sh build.sh upload /dev/ttyUSB0   # Windows: COM3
sh build.sh monitor /dev/ttyUSB0  # 115200 baud
```

Requires Arduino CLI on `PATH`, at `~/.local/bin/arduino-cli`, or set in `ARDUINO_CLI`. On Windows, use Git Bash, or open `commander-firmware.ino` in the Arduino IDE with the Realtek AmebaD 3.1.9 package and board AMB26.

Close the monitor before starting the backend; only one program can open the port.

If upload cannot enter the bootloader: hold BOOT, press and release RESET, release BOOT.

## LED

| Pattern | Meaning |
|---|---|
| Steady blue | BLE starting |
| Green pulse every 2 s | Scanning |
| Blue flash | Packet forwarded |
| Steady red | Startup failed |

## Tests

```sh
sh build.sh test
```

Native C++ tests (ASan/UBSan) cover CRC, advertisement parsing including malformed input, deduplication and line format. The output lines are then parsed by `commander-hq/backend/app/protocol.py`.

Not yet done: compiling against the Realtek core and running on hardware.
