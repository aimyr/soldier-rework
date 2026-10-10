# Soldier Firmware

Node firmware for the NUCODE NU-87 Tiny DK (RTL8720DF) with an MPU6050 IMU, TMP36GT9Z temperature sensor, analog Pulse Sensor and UART NMEA GPS. Built with the official Realtek AmebaD **3.1.9** Arduino core, board **AMB26**.

> **Pending rework:** the radio currently streams sensor data over a BLE connection (protocol v3, below). It must be replaced with event-only BLE advertisements per [docs/DATA_SPEC.md](../docs/DATA_SPEC.md). Until then, this firmware cannot talk to `commander-firmware`.

## Wiring

Use the MCU signal names printed on the board. Header positions come from NUCODE's NU87-TinyDK schematic, not Arduino D-numbers. All sensors share GND and use 3.3V logic; no input tolerates 5V.

| Signal | NU-87 pin | Arduino index | Header |
|---|---|---|---|
| MPU6050 SDA | PB21 | 18 | P2 pin 8 |
| MPU6050 SCL | PB20 | 19 | P2 pin 7 |
| TMP36 VOUT | PB1 / A4 | 11 | P2 pin 5 |
| Pulse Sensor signal | PB2 / A5 | 10 | P2 pin 4 |
| GPS TX → board RX | PB18 / Serial1 RX | 17 | P2 pin 9 |
| GPS RX ← board TX (optional) | PB19 / Serial1 TX | 16 | P2 pin 10 |
| RGB red (onboard) | PA13 | 2 | P1 pin 3; reserved |
| RGB green (onboard) | PA12 | 3 | P1 pin 2; reserved |
| RGB blue (onboard) | PA14 | 1 | P1 pin 4; reserved |

- **TMP36 and Pulse Sensor:** power from 3.3V. TMP36 TO-92 pins: 1 = +VS, 2 = VOUT, 3 = GND (check the datasheet package view). Fit a 100nF bypass capacitor near the TMP36 supply pins.
- **MPU6050:** use a 3.3V-compatible breakout with SDA/SCL pulled up to 3.3V (typically 4.7k, if not already fitted). AD0 = GND gives address 0x68, AD0 = 3.3V gives 0x69; both are probed. INT is not used.
- **GPS:** Serial1, 9600 baud, NMEA GGA/RMC. Match `GPS_BAUD` and supply voltage to the module. UBX-only output is unsupported. GPS RX may be left disconnected; the firmware sends no GPS commands.
- **Do not use:** PA25/PA26 (native USB), PA7/PA8 (onboard CP2102N USB-UART), PA27/PB3 (debug/boot), PA28 (USB reference resistor).

Pins and timing are set in `src/config.h`. Ameba `analogRead` uses factory calibration and returns millivolts scaled by `2^ADC_BITS / 3300`; the TMP36 conversion uses the same denominator. A floating analog input can still read plausible values, so the firmware cannot detect a missing sensor.

## Build, upload, monitor

Requires Arduino CLI on `PATH`, at `~/.local/bin/arduino-cli`, or set in `ARDUINO_CLI`.

```sh
sh tools/nu87.sh setup                 # once: installs Realtek AmebaD 3.1.9
sh tools/nu87.sh build
sh tools/nu87.sh upload /dev/ttyUSB0
sh tools/nu87.sh monitor /dev/ttyUSB0  # 9600 baud
```

The script stages `src/` as a sketch in `.build/` (git-ignored) and compiles for AMB26 with Auto Upload Mode at 921600 baud. Output image: `.build/output/km0_km4_image2.bin`. The vendor uploader also uses a copy in its tool directory, so do not run two Realtek builds or uploads at once. `platformio.ini` and `tools/pio.sh` are stubs left from the earlier PlatformIO setup; neither builds anything.

If upload cannot enter the bootloader: hold BOOT, press and release RESET, release BOOT. Do not erase the whole flash as routine recovery.

## Runtime

| LED pattern | Meaning |
|---|---|
| Steady cyan | Booting, or DMP loading / waiting for stillness |
| 1 blue pulse every 2 s | Running, no BLE connection |
| 2 green pulses every 2 s | BLE connected |
| 3 red pulses every 2 s | MPU6050 offline or TMP36 reading invalid |
| Fast red blinking | Analog task failed or readings stale |

The LED is active-high through SN74LVC3G17 buffers. Faults override connection status. No GPS fix and no finger contact are not faults. The main loop drives the LED, so a stalled loop stops the heartbeat; a stall inside the vendor BLE initializer leaves the LED on boot cyan.

- **Pulse:** sampled at 500Hz in its own FreeRTOS task, the only user of the ADC. Sampling gaps invalidate pulse history.
- **TMP36:** 16 readings averaged, spread over time.
- **GPS:** byte budget per loop, checksum and range validation, fix expires after 3 s.
- **IMU:** 5ms deadline per transaction, register read-back, data-ready checks, retry after disconnect. MotionApps 6.12 configuration: ±2g, ±2000°/s, DLPF 1, divider 4. Do not change ranges or divider without a matching DMP configuration. DMP FIFO output is nominally 100Hz; the host polls every loop (≥ 5ms apart) and publishes new samples at up to 50Hz.

## DMP startup and recovery

Keep the board still during startup. The firmware resets the MPU6050, uploads the DMP image in 16-byte blocks with read-back verification, then enables it. Startup runs incrementally, so GPS, ADC, BLE and the LED keep working. The FIFO is polled over I2C; no INT wire is needed.

IMU and orientation data are withheld for at least 10 s after DMP start, and until 100 consecutive packets pass a stillness check (acceleration ≈ 1g, low gyro output, small acceleration changes). This does not prove calibration: slow constant rotation can pass, and there is no absolute heading reference. If the LED stays cyan, keep the board still and check the serial `DMP` line.

FIFO handling: 28-byte packets read as two 14-byte bursts, at most two packets per poll; only the latest valid sample is kept and none is published twice. Overflow, a backlog over four packets, or a partial read resets the FIFO. Three consecutive transfer or decode failures, or 1 s without valid data, takes the IMU offline and restarts initialization. Reinitialization resets the yaw reference (status bit 6 is set while it runs).

Serial `DMP,state=…,fifo_resets=…` states: 0 offline, 1 reset wait, 2 signal reset wait, 3 image upload, 4 start, 5 settling, 6 running. `fifo_resets` includes startup resets. State 6 with changing `QUAT` lines means valid packets, not verified angle accuracy.

Orientation: quaternions are sent w/x/y/z. The PC normalizes them and shows ZYX roll/pitch/yaw in degrees. Euler angles are singular near ±90° pitch; render from quaternions. Roll and pitch are gravity-referenced; yaw is relative to startup and can drift. Board-to-head mounting rotation is not applied. Accuracy and drift on this hardware are unmeasured.

Vendored DMP image version, source, checksum and license: [src/sensors/vendor/SOURCE.md](src/sensors/vendor/SOURCE.md).

## Serial output

Onboard USB-UART, **9600 baud, 8N1**. Each record type prints once per second; `IMU` and `QUAT` appear only after DMP stabilization. Raw pulse values are snapshots of the 500Hz signal. A bounded queue keeps slow UART writes from blocking sampling; lines are dropped when it is full. Vendor boot messages may appear at a different baud rate.

```text
IMU,t_ms=15000,ax=0,ay=0,az=16384,gx=0,gy=0,gz=0
VITALS,t_ms=15000,temp_c_x100=2500,bpm=60,pulse_raw=1800
GPS,t_ms=15000,lat_e7=0,lon_e7=0,alt_cm=0,speed_cms=0,fix=0,sats=0
STATUS,t_ms=15000,version=3,flags=0x2F,tx_dropped=0,sample_gaps=0
QUAT,t_ms=15000,w_q30=1073741824,x_q30=0,y_q30=0,z_q30=0
```

9600 baud carries about 960 bytes/s, too little for 50Hz text IMU output; BLE carries the full rate.

## BLE protocol v3 (current, to be replaced)

Device name `NUCODE-HUD`, one connection at a time. Service `76B92001-7C4D-4F21-9B63-136A2D8E507C`; notify characteristics share its suffix with prefixes 76B92002 (IMU), 76B92003 (vitals), 76B92004 (GPS), 76B92005 (status), 76B92006 (orientation). Structs are packed little-endian and fit the minimum BLE MTU. v3 uses new UUIDs so older receivers cannot misread the changed MPU6050 scales.

| Packet | Rate | Python struct | Fields |
|---|---|---|---|
| IMU | 50Hz target | `<I6h` | uptime ms, accel XYZ (raw / 16384 = g), gyro XYZ (raw / 16.4 = °/s) |
| Orientation | 50Hz target | `<I4i` | uptime ms, quaternion w/x/y/z, signed Q30 (÷ 1073741824) |
| Vitals | 5Hz | `<IhHH` | uptime ms, temperature °C × 100, BPM, pulse raw 0..4095 |
| GPS | 1Hz | `<IiiiHBB` | uptime ms, lat/lon × 1e7, altitude cm, speed cm/s, fix, satellites |
| Status | 1Hz | `<IHHII` | uptime ms, version = 3, flags, local BLE failures, sample gaps |

Temperature −32768 = invalid. BPM 0 = unavailable. GPS coordinates are invalid when fix = 0. Status flags: bit0 IMU online, bit1 analog fresh, bit2 temperature valid, bit3 BPM available, bit4 GPS fix, bit5 GPS enabled, bit6 DMP initializing/settling. Delivery is best effort: the Realtek notify API does not report radio delivery, so `tx_dropped` counts only local failures. The GATT service is open, with no authentication or encryption. Real rates and range are unmeasured.

PC receiver (validates lengths and version, decodes units, marks stale data, writes JSONL, reconnects; `--help` for device addressing):

```sh
python3 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
.venv/bin/python tools/ble_receiver.py --jsonl readings.jsonl
```

## Tests

```sh
sh tools/test.sh
```

- **Native C++ (ASan/UBSan):** timing, MPU6050 byte order, I2C failures, TMP36 conversion, pulse timing, NMEA parsing.
- **DMP simulator:** verified image loading, motion gating, partial FIFO packets, overflow and backlog reset, mid-packet bus failure, corruption, stale data, retries, clock wraparound.
- **Python:** protocol scales and UUIDs, quaternion decoding, receiver disconnect and error handling.

Tests do not establish sensor accuracy, current draw, RF reliability or wiring. Hardware evidence and remaining checks: [docs/power-validation.md](docs/power-validation.md).

`variants/nu40dk_nrf52840/` is source from the earlier NU40 target, kept with its license. It is not compiled.

## Sources

- [NUCODE NU-87 start guide and schematic](https://nucode.gitbook.io/nuseries/downloads/nu-87-tinydk)
- [Realtek AmebaD Arduino core](https://github.com/Ameba-AIoT/ameba-arduino-d): AMB26 variant, calibrated ADC, BLE API, uploader
- [Adafruit MPU6050 driver](https://github.com/adafruit/Adafruit_MPU6050)
- [TMP36 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/TMP35_36_37.pdf)
