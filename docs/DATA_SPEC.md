# Data Specification v1

Contract between `soldier-firmware/`, `commander-firmware/` and `commander-hq/`. All nodes and the gateway are NUCODE NU-87 (RTL8720DF).

Change all three together, and bump `PROTOCOL_VERSION` when the packet layout changes. Reference implementation: `commander-hq/backend/app/protocol.py`.

## 1. When a node transmits

Nodes are radio-silent except for:

| Trigger | Packet type | Notes |
|---|---|---|
| Alert rule fires (section 3) | `ALERT` (0x1) | Same code not repeated within 60 s |
| Report button pressed | `ALERT` (0x1) | `SITREP_CONTACT` or `SITREP_SOS` |
| Check-in timer expires | `CHECKIN` (0x2) | Every 120 s ± 30 s random jitter |
| Power-on | `CHECKIN` (0x2) | First check-in sets the resting baseline; soldier stands still |

The check-in is the only periodic traffic: it lets the commander tell a quiet node from a lost one. The jitter avoids a fixed period an interceptor could detect.

## 2. Packet layout (18 bytes, little-endian)

| Offset | Size | Field | Type | Unit / encoding |
|---|---|---|---|---|
| 0 | 1 | `head` | uint8 | high nibble = version (1), low nibble = packet type |
| 1 | 1 | `soldier_id` | uint8 | 1..255 |
| 2 | 2 | `seq` | uint16 | increments per packet, wraps |
| 4 | 2 | `t_s` | uint16 | seconds since node power-on |
| 6 | 1 | `code` | uint8 | alert code (section 3); 0 for check-in |
| 7 | 1 | `hr_bpm` | uint8 | beats per minute |
| 8 | 2 | `skin_temp` | int16 | °C × 100 (34.56 °C → 3456) |
| 10 | 1 | `activity` | uint8 | 0..255, mean \|accel − 1 g\| over last 2 s, scaled |
| 11 | 2 | `x` | int16 | PDR east position, decimetres from start point |
| 13 | 2 | `y` | int16 | PDR north position, decimetres from start point |
| 15 | 1 | `gas` | uint8 | 0..255 raw gas sensor level |
| 16 | 1 | `hops` | uint8 | 0 at origin; each relaying node adds 1 |
| 17 | 1 | `crc8` | uint8 | CRC-8, poly 0x07, init 0x00, over bytes 0..16 |

A relaying node changes only `hops` (+1) and `crc8` (recomputed), and drops any packet whose (`soldier_id`, `seq`) it has already forwarded.

## 3. Alert codes

| Code | Name | Condition | Commander severity |
|---|---|---|---|
| 0x00 | `NONE` | Check-in | OK |
| 0x01 | `HR_SPIKE_IMMOBILE` | HR ≥ baseline + 45 while immobile ≥ 10 s | CRITICAL |
| 0x02 | `HR_LOW_IMMOBILE` | HR ≤ 45 while immobile ≥ 10 s | CRITICAL |
| 0x03 | `FALL_IMMOBILE` | Impact ≥ 2.5 g, then immobile ≥ 10 s | CRITICAL |
| 0x04 | `HEAT_STRAIN` | Skin temp ≥ baseline + 1.5 °C and HR ≥ baseline + 35 for 30 s | WARN |
| 0x05 | `HAZARD_ENV` | Gas ≥ 120 | WARN |
| 0x10 | `SITREP_CONTACT` | Button: enemy or target sighted | WARN |
| 0x12 | `SITREP_SOS` | Button: help needed | CRITICAL |

"Immobile" means `activity` < 8. All thresholds are demo defaults; tune them with measured data (`commander-hq/backend/app/node_rules.py`).

## 4. Node processing

1. Sample heart rate, skin temperature, IMU (≥ 50 Hz, for PDR) and gas.
2. Run PDR: step detection on \|accel\|, Weinberg stride length, gyro-integrated heading. Reference: `commander-hq/backend/app/analysis/pdr.py`.
3. Every second, evaluate the rules in section 3. Reference: `node_rules.py`.
4. When a rule fires or a timer expires, build the packet and send one advertising burst (section 5) at the lowest TX power that reaches the next hop.

## 5. Radio: BLE advertising

Nodes never connect. Each packet is a legacy, non-connectable advertisement (`ADV_NONCONN_IND`):

| AD structure | Bytes | Content |
|---|---|---|
| Flags | `02 01 06` | LE General Discoverable, BR/EDR not supported |
| Manufacturer data | `15 FF FF FF` + 18 bytes | Length 21, type 0xFF, company ID `0xFFFF` (little-endian), then the packet |

25 of 31 bytes used. `0xFFFF` is the Bluetooth SIG company ID for testing and internal use. Other devices may use it, so receivers must check length, version and CRC.

Advertisements are not acknowledged, so a node repeats the same packet (same `seq`) in a burst, then stops. Proposed burst: 20–30 ms advertising interval for 300 ms. Verify with packet counts on hardware.

## 6. Gateway → commander (USB serial, 115200 baud)

The gateway (`commander-firmware/`) prints one line per new packet:

```
PKT:<36 hex characters>,RSSI:<dBm>
```

Example: `PKT:11030700d007018d800d02d204c8ff0c0147,RSSI:-63` = S3, seq 7, t = 2000 s, `HR_SPIKE_IMMOBILE`, HR 141, 34.56 °C, position (123.4, −5.6) m, 1 hop.

It forwards only the first copy of each (`soldier_id`, `seq`) within 30 s, so burst repeats and relayed copies reach the backend once. The backend ignores all other lines; the gateway prints `GW,...` counters every 10 s.
