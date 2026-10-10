# NU-87 Tiny DK HUD Sensor Firmware

Modular firmware for the NUCODE NU-87 Tiny DK (RTL8720DF), MPU6050, TMP36GT9Z, analog Pulse Sensor, and UART NMEA GPS. MPU6050 orientation uses MotionApps DMP 6.12. Uses the official Realtek AmebaD **3.1.9** Arduino core and **AMB26 (RTL8720DF)** target, as specified by NUCODE's start guide. The previous NU40/nRF52840 PlatformIO target is no longer active.

## Wiring

Use the MCU signal names printed on the board. Header positions below are from the manufacturer's NU87-TinyDK schematic, not Arduino D-number labels. All sensors share GND. Use 3.3V logic; no input is intended for 5V signals.

| Signal | NU-87 connection | Arduino index | Header |
|---|---|---|---|
| MPU6050 SDA | PB21 | 18 | P2 pin 8 |
| MPU6050 SCL | PB20 | 19 | P2 pin 7 |
| TMP36 VOUT | PB1 / A4 | 11 | P2 pin 5 |
| Pulse Sensor signal | PB2 / A5 | 10 | P2 pin 4 |
| GPS TX -> board RX | PB18 / Serial1 RX | 17 | P2 pin 9 |
| GPS RX <- board TX (optional) | PB19 / Serial1 TX | 16 | P2 pin 10 |
| RGB red (onboard) | PA13 | 2 | P1 pin 3; reserved |
| RGB green (onboard) | PA12 | 3 | P1 pin 2; reserved |
| RGB blue (onboard) | PA14 | 1 | P1 pin 4; reserved |

- Power TMP36 and the analog Pulse Sensor from 3.3V. TMP36 TO-92 pin numbers are 1=+VS, 2=VOUT, 3=GND; verify the datasheet's package view. Place a 100nF bypass capacitor near the TMP36 supply pins.
- MPU6050 breakout supply requirements depend on its regulator. Use a breakout compatible with 3.3V operation and pull SDA/SCL up to **3.3V**, typically with 4.7k resistors if not already fitted. AD0=GND selects 0x68; AD0=3.3V selects 0x69. Both are probed. INT is not used.
- Do not use PA25/PA26 for this IMU: those nets connect to the board's native USB circuit. The bounded software I2C driver uses PB21/PB20 instead.
- GPS is enabled by default: Serial1, 9600 baud, NMEA GGA/RMC. Match `GPS_BAUD` and the supply voltage to the actual GPS module. A UBX-only stream is unsupported. GPS RX may be left disconnected; this firmware sends no GPS commands.
- PA7/PA8 are reserved for the onboard CP2102N USB-UART. PA27/PB3 are debug/boot-related signals. PA28 is a USB reference-resistor connection. Do not reuse them for these sensors.

Pin assignments and timing are in `src/config.h`. Ameba analogRead uses factory calibration and returns millivolts scaled by `2^ADC_BITS / 3300`; the TMP36 conversion uses that exact denominator. A floating analog input can still produce plausible values: the firmware cannot prove a sensor is physically attached.

## Build, Upload, and Monitor

Install Arduino CLI and put it on PATH or at `~/.local/bin/arduino-cli`; alternatively set `ARDUINO_CLI` to its full path. Then run from this directory:

```sh
sh tools/nu87.sh setup
sh tools/nu87.sh build
sh tools/nu87.sh upload /dev/ttyUSB0
sh tools/nu87.sh monitor /dev/ttyUSB0
```

`setup` pins Realtek AmebaD to 3.1.9. The script stages `src/` as a recursive Arduino sketch in ignored `.build/`, compiles for AMB26, enables Auto Upload Mode and uses 921600 baud for flashing. Debug output remains 9600 baud. Specify the actual board port explicitly when uploading. Old PlatformIO commands stop rather than targeting the wrong processor.

The generated image is `.build/output/km0_km4_image2.bin`. The vendor uploader also uses its tool-directory copy of this image, so avoid concurrent Realtek builds/uploads. If automatic flashing cannot enter the bootloader, use the manufacturer's BOOT/RESET sequence: hold BOOT, press and release RESET, then release BOOT during the upload connection window. Do not erase the entire flash as a routine recovery step.

## Runtime and Status LED

The onboard RGB LED is active-high, driven through SN74LVC3G17 buffers. No sensor pins overlap the LED.

| Pattern | Meaning |
|---|---|
| Steady cyan | Boot or DMP loading/stillness stabilization |
| One blue pulse every 2 seconds | Running, waiting for BLE |
| Two green pulses every 2 seconds | BLE connected |
| Three red pulses every 2 seconds | MPU6050 offline or invalid TMP36 value |
| Fast red blinking | Analog task failed or readings stale |

Faults take priority over connection status. No GPS fix or no finger contact does not cause an LED fault. Patterns are driven by the main loop, so a stalled loop cannot continue a healthy heartbeat. The vendor BLE initializer waits for stack readiness internally; a stall there leaves the boot indication on.

Pulse sampling runs in its own FreeRTOS task at 500Hz, with a single owner of the ADC. TMP36 sampling is spread across time and averaged over 16 readings. Sampling gaps invalidate pulse history. GPS processing has a per-loop byte budget, checksum/range validation, and 3-second fix expiry. IMU transactions have a 5ms deadline, register read-back, data-ready checks, and retry after disconnect. MPU6050 uses the MotionApps 6.12 operating configuration: +/-2g, +/-2000 degrees/s, DLPF setting 1 and divider 4. The image fixes its FIFO output cadence (nominally 100Hz); the host services FIFO every loop with a 5ms minimum interval and publishes fresh snapshots at up to 50Hz. Do not change sensor ranges/divider without a compatible DMP configuration.

## DMP Startup and Recovery

Keep the sensor stationary during startup. The host resets the MPU6050, uploads and reads back each 16-byte firmware block, then enables DMP. Startup progresses incrementally, so GPS, ADC sampling, BLE and the LED keep running. No INT wire is required: FIFO is polled over PB21/PB20.

The application withholds IMU/orientation telemetry for at least 10 seconds after DMP starts and until 100 consecutive valid packets pass a stillness check (acceleration close to 1g, low gyro output and small acceleration changes). The DMP image includes upstream's stationary runtime gyro calibration. This gate does not prove calibration: slow constant rotation can look stationary, and no absolute heading reference exists. If startup remains cyan, keep the board still and inspect the serial state.

The FIFO contains 28-byte packets. Reads use two bounded 14-byte bursts, consume at most two packets per poll, retain the latest valid sample and never publish it twice. Overflow or a backlog beyond four packets resets FIFO. A partial read also resets FIFO to restore alignment. Three consecutive transfer/decode failures or more than one second without valid DMP data takes the IMU offline and triggers a fresh initialization. Reinitialization also changes the yaw reference; use status bit6 to detect it.

Serial `DMP,state=...,fifo_resets=...` states are 0=offline, 1=reset wait, 2=signal reset wait, 3=image upload, 4=start, 5=settling, 6=running. The FIFO reset count includes initial startup resets. State 6 and changing QUAT records indicate valid DMP packets; they do not establish angle accuracy.

Quaternions are transmitted in w/x/y/z order. The PC normalizes them and displays ZYX roll/pitch/yaw in degrees. Euler angles have a singularity near +/-90-degree pitch; use quaternions for rendering. Board-to-head mounting rotation must be applied separately. Roll/pitch are gravity-referenced, and yaw is startup-relative with possible drift. Calibration, dynamic accuracy and drift on this hardware remain to be measured.

The vendored firmware version, source commit, checksum and license are recorded in [vendor provenance](src/sensors/vendor/SOURCE.md).

## Serial Debugging

Open the onboard USB-UART at **9600 baud, 8N1**. Every data type, including `QUAT` orientation, is printed at **1Hz**; IMU and QUAT lines require fresh data after DMP stabilization. Raw pulse values are snapshots, not the entire internal 500Hz signal. A bounded logging queue isolates slow UART writes from acquisition. On saturation, debug lines are dropped. Vendor boot/stack messages may appear separately; ROM startup can use a different baud rate.

```text
IMU,t_ms=15000,ax=0,ay=0,az=16384,gx=0,gy=0,gz=0
VITALS,t_ms=15000,temp_c_x100=2500,bpm=60,pulse_raw=1800
GPS,t_ms=15000,lat_e7=0,lon_e7=0,alt_cm=0,speed_cms=0,fix=0,sats=0
STATUS,t_ms=15000,version=3,flags=0x2F,tx_dropped=0,sample_gaps=0
QUAT,t_ms=15000,w_q30=1073741824,x_q30=0,y_q30=0,z_q30=0
```

9600 baud supports about 960 payload bytes/second with 8N1 framing. Printing readable IMU lines at 50Hz would exceed that limit. BLE retains its higher update rates independently.

## BLE Protocol v3 and PC Receiver

Device name: `NUCODE-HUD`. Protocol v3 uses a **new UUID namespace** so previous raw-mode receivers cannot silently misinterpret the changed MPU6050 scales. Update the PC receiver together with the firmware.

Service: `76B92001-7C4D-4F21-9B63-136A2D8E507C`. Notify characteristics use the same suffix with prefixes 76B92002 (IMU), 76B92003 (vitals), 76B92004 (GPS), and 76B92005 (status), and 76B92006 (orientation). One PC connection is supported. All packets fit the mandatory BLE MTU; structs are packed and little-endian.

| Packet | Rate | Python struct | Meaning |
|---|---|---|---|
| IMU | 50Hz target | `<I6h` | uptime ms, accel XYZ raw / 16384 = g, gyro XYZ raw / 16.4 = degrees/s |
| Orientation | 50Hz target | `<I4i` | uptime ms, quaternion w/x/y/z in signed Q30 (divide by 1073741824) |
| Vitals | 5Hz | `<IhHH` | uptime ms, temperature x100 C, BPM, pulse raw 0..4095 |
| GPS | 1Hz | `<IiiiHBB` | uptime ms, lat/lon x1e7, altitude cm, speed cm/s, fix, satellites |
| Status | 1Hz | `<IHHII` | uptime ms, version=3, flags, local BLE failures, sample gaps |

Temperature -32768 means invalid; BPM 0 means unavailable. Status flags: bit0 IMU online, bit1 analog fresh, bit2 temperature valid, bit3 BPM available, bit4 GPS fix, bit5 GPS enabled, bit6 DMP initializing/settling. GPS coordinates are invalid when fix=0. BLE delivery is best effort; the Realtek notify API does not report radio delivery, and `tx_dropped` only counts detectable local failures. Actual rates and range require hardware measurement.

```sh
python3 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
.venv/bin/python tools/ble_receiver.py --jsonl readings.jsonl
```

The receiver validates packet lengths/version, decodes units, marks stale data, writes JSONL, and reconnects after link loss. See `--help` for explicit device addressing. Data is sent using an open GATT service; this prototype does not add application authentication or encryption.

## Tests and Validation

```sh
sh tools/test.sh
```

Native C++ tests use AddressSanitizer/UndefinedBehaviorSanitizer and cover timing, MPU6050 byte order, I2C failures, TMP36 conversion, pulse timing, and NMEA parsing. Python tests cover protocol scales/UUIDs, quaternion decoding, and receiver disconnect/error handling. The DMP simulator additionally covers verified banked image loading, motion gating, partial FIFO packets, overflow/backlog reset, mid-packet bus failure, corruption, stale data, retries, and clock wraparound. They do not establish sensor accuracy, current draw, RF reliability, or physical wiring. See [the validation record](docs/power-validation.md) for hardware evidence and remaining checks.

The unused `variants/nu40dk_nrf52840` directory is retained as historical source with its license; it is not compiled for NU-87.

## Sources

- [NUCODE start guide and schematic downloads](https://nucode.gitbook.io/nuseries/downloads/nu-87-tinydk)
- [Official Realtek Arduino core](https://github.com/Ameba-AIoT/ameba-arduino-d), including AMB26 variant, calibrated ADC implementation, BLE API, and uploader
- [Adafruit MPU6050 driver reference](https://github.com/adafruit/Adafruit_MPU6050)
- [TMP36 manufacturer datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/TMP35_36_37.pdf)
