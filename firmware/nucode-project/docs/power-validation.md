# Power and Stability Validation Record

Objective: improve stability and code quality while reducing system power consumption, retaining IMU/temperature/pulse/GPS BLE telemetry and 9600-baud USB serial debugging.

## Evidence Available

- The installed core is Adafruit nRF52 1.7.0 with a 1024Hz RTOS tick. The previous maximum BLE bandwidth configuration used MTU 247 and a 125ms event length.
- Project packets are at most 20 bytes, so MTU 23 is sufficient.
- The ST LSM6DS3TR-C datasheet specifies low-power operation when CTRL6_C bit4 and CTRL7_G bit7 disable high-performance mode and the ODR is 52Hz. Configuration read-back checks include the rate and mode settings.
- The 500Hz scheduler distributes two- and three-tick intervals; tests check cumulative timing across 500,000 consecutive schedules.
- I2C STOP checks SDA/SCL release and propagates failure. RTOS delays avoid consuming CPU throughout the 5ms deadline while the clock is held low. Host tests cover normal ACK/read/repeated START, STOP failure, and subsequent retries; these do not validate physical signal quality.
- C++ ASan/UBSan tests and Python protocol/receiver tests exist. They do not prove actual current draw, RF range, bus signal quality, or sensor accuracy.

## Hardware Validation Requirements and Status

Validation requires a wired NU40 and sensors, the GPS model/specification, a PC BLE adapter, and current measurements in the board's power path. Earlier checks found no `/dev/ttyACM*` or `/dev/ttyUSB*` devices. The board subsequently appeared as `/dev/ttyACM0`, and uploads, including the status LED firmware, completed with `Device programmed.`. A six-second 9600-baud serial check after the earlier upload captured no output. Actual sensor reception, LED behavior, and current consumption remain unverified.

## Measurement Conditions

Compare configurations using the same supply voltage, sensors, GPS reception environment, BLE distance/PC, and firmware data rates. Ensure simultaneous USB and battery supplies do not bypass the current measurement path. Record average and peak current over at least 60 seconds together with the actual data reception rate, rather than relying on a single instantaneous reading.

| Condition | Average current | Peak current | IMU reception Hz | Change in drops/gaps | Status |
|---|---|---|---|---|---|
| Previous settings, USB monitor open, BLE connected | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Baseline required |
| Updated settings, USB monitor open, BLE connected | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Functional comparison required |
| Updated settings, USB monitor closed, BLE connected | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Measure debugging overhead |
| Updated settings, battery supply, BLE connected | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Intended operating condition |
| Updated settings, battery supply, BLE disconnected | Unmeasured | Unmeasured | Not applicable | Unmeasured | Advertising and continuous sensing overhead |

## Outstanding Validation and Improvements

1. Verify all sensor values, units, boot identification, and GPS fix on the programmed board.
2. Check actual reception against the 50Hz target and measure stationary/motion noise in 52Hz IMU low-power mode. Compare with `IMU_LOW_POWER=false` when evaluating measurement quality.
3. Measure actual BLE connection intervals, transmit power behavior, advertising intervals, and reception at the required range. Select the lowest transmit power that meets the packet-loss requirement.
4. Evaluate a bounded hardware TWIM implementation to reduce software I2C CPU consumption further. Do not consider the bus replacement validated until timeout handling, DMA termination, and sensor-disconnection recovery have been tested on hardware.
5. Confirm GPS-specific power-saving/update-rate support and time to reacquire a fix. Do not assume power control that the hardware does not provide.
6. Confirm the NU40 DC-DC inductor circuitry before deciding whether to enable the internal DC-DC converter. Do not enable it without checking the circuit.
7. Test repeated sensor/USB/PC disconnects and reconnects, corrupted UART input, extended operation, memory/stack headroom, and drops/gaps.

Do not claim minimum power consumption or complete hardware validation until both current consumption and functionality have been measured.

Sources: [ST datasheet](https://www.st.com/resource/en/datasheet/lsm6ds3tr-c.pdf), installed Adafruit nRF52 core files `bluefruit.cpp` and `FreeRTOSConfig.h`.
