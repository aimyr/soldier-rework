# NU-87 Power and Stability Validation Record

## Current Target

NUCODE NU-87 Tiny DK / RTL8720DF, official Realtek AmebaD 3.1.9 core, AMB26 target, MPU6050 at 50Hz with a 20Hz low-pass filter. TMP36 and Pulse Sensor use calibrated 3.3V ADC scaling. GPS remains 9600-baud NMEA on Serial1. The previous NU40 upload records and LSM6DS power settings do not validate this board.

## Confirmed Evidence

- NUCODE's start guide specifies AMB26 and supports Auto Upload Mode. The schematic confirms active-high RGB LEDs on PA13/PA12/PA14 and the sensor header pin assignments documented in README.md.
- An AMB26 build completed with the official core. The tool reports 860924 bytes (41% of its 2097152-byte program limit).
- Flashing the connected CP2102N port `/dev/ttyUSB0` completed with `All images are sent successfully!`.
- An 8-second read of `/dev/ttyUSB0` at 9600 baud captured 1720 bytes of live telemetry. Status reported protocol v2, flags 0x22, and `sample_gaps=0`. MPU6050 was not detected; TMP36 was invalid, pulse raw/BPM were zero, and GPS had no fix. This verifies execution and logging, not attached-sensor operation or visual LED behavior.
- Native C++ ASan/UBSan tests passed, including MPU6050 byte order/sign, I2C transaction failures, ADC conversion, pulse timing, NMEA parsing, and periodic scheduling. Seven Python protocol/receiver tests passed.
- The ADC task has a dedicated 500Hz schedule on the core's 1000Hz RTOS tick. The main loop yields and slow 9600-baud logs run in a bounded, lower-priority queue. Debug records are limited to one per type per second.
- BLE peripheral initialization waits inside the vendor core until stack readiness; there is no application timeout around that call. The onboard boot indication remains steady during initialization.
- The Realtek characteristic notify function does not return transmission status. The status counter only records local failures, not complete radio packet-loss statistics.

## Power Claims

No minimum-power claim or measured current figure is available. Wi-Fi is not started by the application. ADC acquisition, gyro operation, UART GPS, BLE advertising, USB-UART hardware, regulators, and the board's fixed power LED all consume current. Do not reuse NU40 current estimates for RTL8720DF.

The MPU6050 gyro stays active for six-axis measurements; cycling accelerometer-only low-power mode would lose gyro data. The RGB status indication uses short pulses. Debugging can be compiled out with `CFG_DEBUG=0`, but closing the PC monitor does not stop UART transmission by itself.

## Hardware Checks Still Required

1. Confirm stationary acceleration is about 1g in magnitude and gyro rates are near zero; move each axis to check signs and orientation.
2. Compare TMP36 against a reference thermometer and verify Pulse Sensor waveforms/BPM during motion and poor contact. A plausible analog value does not prove sensor presence.
3. Confirm the GPS model, supply/logic voltage, baud rate, and outdoor fix. Exercise loss of fix and stale data handling.
4. Record BLE packet counts/timestamp gaps on an actual PC adapter, including disconnect/reconnect and distance tests. The development environment currently lacks a usable BlueZ D-Bus service.
5. Run extended acquisition with all sensors attached, inspect stack headroom and `sample_gaps`, and test I2C unplug/recovery with pull-ups present.
6. Measure average/peak supply current for at least 60 seconds under identical sensor, RF, GPS, and supply conditions. Measure both connected and advertising modes, with debug enabled and disabled. Avoid supply paths that bypass the current measurement.

Sources: [NUCODE schematic/start guide](https://nucode.gitbook.io/nuseries/downloads/nu-87-tinydk), [official Realtek Arduino core](https://github.com/Ameba-AIoT/ameba-arduino-d).
