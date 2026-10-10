# NU-87 Power and Stability Validation Record

The records below predate the switch from BLE streaming (protocol v3) to event-only advertising. Radio findings refer to the streaming firmware.

Target: NUCODE NU-87 Tiny DK (RTL8720DF), Realtek AmebaD 3.1.9 core, board AMB26. MPU6050 with MotionApps DMP 6.12 at up to 50Hz over BLE; TMP36 and Pulse Sensor on calibrated 3.3V ADC; GPS NMEA at 9600 baud on Serial1. Earlier NU40 upload records and LSM6DS power settings do not apply to this board.

## Confirmed

- **Board facts:** NUCODE's start guide specifies AMB26 and Auto Upload Mode. The schematic confirms active-high RGB LEDs on PA13/PA12/PA14 and the sensor header pins in the README.
- **Build:** an AMB26 build with the official core used 865,020 of 2,097,152 bytes (41%).
- **Upload:** the DMP firmware flashed via the CP2102N port `/dev/ttyUSB0` (`All images are sent successfully!`).
- **Pre-DMP run:** 8 s of serial at 9600 baud captured 1720 bytes of telemetry: protocol v2, flags 0x22, `sample_gaps=0`. MPU6050 not detected, TMP36 invalid, pulse raw and BPM zero, no GPS fix. This shows the firmware runs and logs; it does not verify any sensor or the LED.
- **Tests:** native C++ ASan/UBSan tests passed (MPU6050 byte order and sign, I2C failures, ADC conversion, pulse timing, NMEA parsing, scheduling). Eight Python protocol and receiver tests passed.
- **Scheduling:** the ADC task runs at 500Hz on the core's 1000Hz RTOS tick. The main loop yields. Slow 9600-baud logging runs in a bounded, lower-priority queue, at most one record per type per second.
- **BLE init:** the vendor core blocks until the BLE stack is ready, with no application timeout. The LED stays boot cyan during this time.
- **BLE delivery:** the Realtek notify call returns no transmission status, so the status counter records only local failures, not radio packet loss.

## DMP update

- **Post-DMP run:** 12 s of serial at 9600 baud showed protocol v3 telemetry, `sample_gaps=0` and `DMP,state=0,fifo_resets=0`. Repeated `MPU6050 not found` messages mean sensor communication and DMP operation are still unverified. TMP36 invalid, pulse raw and BPM zero, no GPS fix.
- **Image:** MotionApps 6.12 is pinned and vendored with its upstream license. Every uploaded chunk is verified by read-back before start.
- **Simulated tests:** DMP initialization, startup motion gating, partial FIFO packets and backlog, mid-packet I2C failure, invalid quaternion recovery, stale data, reinitialization and timer wraparound. Simulation does not prove the physical sensor accepts the image.
- **Protocol v3:** adds Q30 quaternions and changes raw ranges to ±2g and ±2000°/s. The PC decoder checks quaternion norms and derives ZYX Euler angles.
- **Startup:** takes at least 10 s plus a stillness window. The image's stationary calibration does not provide an absolute yaw reference.
- **Unmeasured:** actual DMP startup, FIFO cadence, angle accuracy and drift. These need a connected MPU6050; test success is not a drift measurement.

## Power

No current has been measured, so no power figure can be claimed. Do not reuse NU40 estimates.

- Wi-Fi is never started. Current is drawn by ADC sampling, the gyro, UART GPS, BLE advertising, the USB-UART chip, regulators and the always-on power LED.
- The MPU6050 gyro stays on for 6-axis data; accelerometer-only low-power cycling would lose gyro data.
- The status LED uses short pulses.
- `CFG_DEBUG=0` compiles out debug logging. Closing the PC serial monitor does not stop UART output.

## Hardware checks still required

1. **IMU:** at rest, acceleration magnitude ≈ 1g and gyro ≈ 0. Move each axis to check signs and orientation.
2. **Analog sensors:** compare TMP36 with a reference thermometer. Check Pulse Sensor waveform and BPM during motion and poor contact; a plausible value does not prove a sensor is attached.
3. **GPS:** confirm module model, supply and logic voltage, baud rate and an outdoor fix. Test loss of fix and stale-data handling.
4. **Radio:** with `commander-firmware`, count bursts sent (`TX` lines) against packets forwarded and `duplicates` (`GW` lines) at increasing range. Confirm the 20 ms advertising interval is accepted.
5. **Endurance:** run all sensors for an extended period. Check stack headroom and `sample_gaps`, and unplug/replug I2C with pull-ups fitted.
6. **Current:** measure average and peak supply current for ≥ 60 s under fixed conditions, idle and during bursts, with debug on and off. Make sure no supply path bypasses the meter.

Sources: [NUCODE schematic and start guide](https://nucode.gitbook.io/nuseries/downloads/nu-87-tinydk), [Realtek Arduino core](https://github.com/Ameba-AIoT/ameba-arduino-d).
