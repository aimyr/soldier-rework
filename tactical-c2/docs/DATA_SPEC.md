# Data Specification v1 — Soldier Node ↔ Commander Terminal

This is the contract between the node firmware (ESP32) and the commander backend.
Change it only together, and bump `PROTOCOL_VERSION` when the layout changes.
Reference implementation: `backend/app/protocol.py`.

## 1. When a node transmits

Nodes are **radio-silent by default**. A node transmits only when:

| Trigger | Packet type | Notes |
|---|---|---|
| Node-side rule fires (section 4) | `ALERT` (0x1) | Same code is not repeated within 60 s |
| Soldier presses a report button | `ALERT` (0x1) | `SITREP_CONTACT` or `SITREP_SOS` |
| Check-in timer expires | `CHECKIN` (0x2) | Every 120 s ± 30 s random jitter |
| Power-on | `CHECKIN` (0x2) | First check-in = resting baseline (stand still) |

The randomized check-in is the only periodic traffic. Without it the commander
cannot tell "silent and fine" from "node destroyed". Jitter prevents a fixed
period that an interceptor could lock onto.

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

Relaying nodes must forward the packet unchanged except `hops` (+1) and `crc8`
(recomputed). Duplicate suppression: drop a packet whose (`soldier_id`, `seq`)
was already forwarded.

## 3. Alert codes

| Code | Name | Meaning | Commander severity |
|---|---|---|---|
| 0x00 | `NONE` | Check-in | OK |
| 0x01 | `HR_SPIKE_IMMOBILE` | HR ≥ baseline + 45 while immobile ≥ 10 s | CRITICAL |
| 0x02 | `HR_LOW_IMMOBILE` | HR ≤ 45 while immobile ≥ 10 s | CRITICAL |
| 0x03 | `FALL_IMMOBILE` | impact ≥ 2.5 g, then immobile ≥ 10 s | CRITICAL |
| 0x04 | `HEAT_STRAIN` | skin temp ≥ baseline + 1.5 °C and HR ≥ baseline + 35 for 30 s | WARN |
| 0x05 | `HAZARD_ENV` | gas ≥ 120 | WARN |
| 0x10 | `SITREP_CONTACT` | button: enemy / target sighted | WARN |
| 0x12 | `SITREP_SOS` | button: help needed | CRITICAL |

All thresholds are **demo defaults** and must be tuned with measured data
(`backend/app/node_rules.py`). "Immobile" = `activity` < 8.

## 4. Node-side processing (firmware)

1. Sample HR, skin temperature, IMU (≥ 50 Hz for PDR), gas.
2. Run PDR: step detection on \|accel\|, Weinberg stride, gyro-integrated heading
   (reference: `backend/app/analysis/pdr.py`).
3. Every second, evaluate the rules in section 3 (reference: `node_rules.py`).
4. If a rule fires or a timer expires, build the 18-byte packet and send one
   ESP-NOW burst at the minimum TX power that reaches the next hop.

## 5. Gateway → commander (USB serial)

The gateway ESP32 at the commander prints one line per received packet:

```
PKT:<36 hex characters>,RSSI:<dBm>
```

Example: `PKT:11030700d007018d800d02d204c8ff0c0147,RSSI:-63`
→ S3, seq 7, t = 2000 s, `HR_SPIKE_IMMOBILE`, HR 141, 34.56 °C, position (123.4, −5.6) m, 1 hop.

Baud 115200. Any other line is ignored by the backend, so debug prints are safe.
