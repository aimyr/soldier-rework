# TODO

Open work across the three projects. Tick items off in the same commit that completes them.

## Hardware bring-up

- [ ] Install Arduino CLI and the Realtek AmebaD 3.1.9 core (`sh soldier-firmware/tools/nu87.sh setup`).
- [ ] Compile and flash `soldier-firmware` (`SOLDIER_ID=N sh tools/nu87.sh upload PORT`). `main.cpp` and `comm/advertiser.cpp` have only been checked against stand-in headers.
- [ ] Compile and flash `commander-firmware` (`sh build.sh upload PORT`).
- [ ] Confirm the Realtek controller accepts the 20–30 ms non-connectable advertising interval. If not, raise `ADV_INTERVAL_MIN_MS`/`ADV_INTERVAL_MAX_MS` in `soldier-firmware/src/config.h` and update DATA_SPEC section 5.
- [ ] Count bursts at increasing range: soldier `TX` lines against gateway `forwarded`/`duplicates` counters (`GW` lines). Adjust `ADV_BURST_MS` if packets are missed.
- [ ] Run the full chain on hardware: soldier → gateway → `commander-hq` with `C2_SOURCE=serial`.

## commander-hq (backend)

- [ ] **Treat missing readings as null.** Nodes send `hr_bpm` = 0 and `skin_temp` = −32768 when they have no reading (DATA_SPEC section 2). The backend currently decodes these as 0 bpm and −327.68 °C, which corrupts the first-check-in baseline and the PSI estimate.
  - `backend/app/protocol.py`: decode both sentinels to `None` (`Packet.hr_bpm: int | None`, `skin_temp_c: float | None`); `encode()` writes the sentinels back for `None`.
  - `backend/app/engine.py`: set `hr0`/`temp0` only from non-null values; skip `strain_index` when either input or baseline is null.
  - `frontend/src/app/models.ts` and the COP: show "no reading" instead of a number.
  - Add tests for both sentinels in `backend/tests/test_core.py`.

## soldier-firmware

- [ ] Fall detection: the MPU6050 runs at ±2g (required by the DMP configuration), so the 2.5g impact threshold cannot be measured directly. An axis at its limit is treated as an impact; verify with real falls and adjust.
- [ ] Calibrate the Weinberg stride constant (`Pdr::WEINBERG_K`) per soldier by walking a known distance.
- [ ] Tune alert thresholds (`src/node/rules.h`, mirrored in `commander-hq/backend/app/node_rules.py`) with measured data. Change both together.
- [ ] Verify heading: board mounted with z vertical, GPS-based north calibration while walking, and PDR fallback accuracy when GPS drops.
- [ ] TX power control: the Arduino BLE API has none; find the vendor GAP call to send at the lowest power that reaches the gateway.
- [ ] Relaying: forward other nodes' packets (`hops` + 1, recompute CRC, drop seen `(soldier_id, seq)`). Nodes currently send `hops` = 0.
- [ ] Report buttons (`SITREP_CONTACT`, `SITREP_SOS`): wire buttons and pass them to `RuleSample.button` in `main.cpp`.
- [ ] Gas sensor (`HAZARD_ENV`): fit a sensor and fill `RuleSample.gas` and `NodePacket.gas` in `main.cpp`.
- [ ] Remaining hardware checks in [soldier-firmware/docs/power-validation.md](soldier-firmware/docs/power-validation.md): IMU signs, analog sensor accuracy, GPS fix, endurance, current draw.
