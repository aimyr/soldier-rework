# Soldier Firmware

Node firmware for the NUCODE NU-87 Tiny DK (RTL8720DF) with an MPU6050 IMU, TMP36GT9Z temperature sensor, analog Pulse Sensor and UART NMEA GPS. Built with the official Realtek AmebaD **3.1.9** Arduino core, board **AMB26**.

The node is radio-silent except for alerts and a randomized check-in. Each transmission is an 18-byte packet sent as a short burst of BLE advertisements to `commander-firmware`. Packet, rules and radio format: [docs/DATA_SPEC.md](../docs/DATA_SPEC.md).

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
- **MPU6050:** use a 3.3V-compatible breakout with SDA/SCL pulled up to 3.3V (typically 4.7k, if not already fitted). AD0 = GND gives address 0x68, AD0 = 3.3V gives 0x69; both are probed. INT is not used. Mount the board with its z axis vertical; heading assumes it.
- **GPS:** Serial1, 9600 baud, NMEA GGA/RMC. Match `GPS_BAUD` and supply voltage to the module. UBX-only output is unsupported. GPS RX may be left disconnected; the firmware sends no GPS commands.
- **Do not use:** PA25/PA26 (native USB), PA7/PA8 (onboard CP2102N USB-UART), PA27/PB3 (debug/boot), PA28 (USB reference resistor).

Pins and timing are set in `src/config.h`. Ameba `analogRead` uses factory calibration and returns millivolts scaled by `2^ADC_BITS / 3300`; the TMP36 conversion uses the same denominator. A floating analog input can still read plausible values, so the firmware cannot detect a missing sensor.

## Build, upload, monitor

Requires Arduino CLI on `PATH`, at `~/.local/bin/arduino-cli`, or set in `ARDUINO_CLI`. Every board needs its own `SOLDIER_ID` (1..255); the build fails without one.

```sh
sh tools/nu87.sh setup                                # once: installs Realtek AmebaD 3.1.9
SOLDIER_ID=3 sh tools/nu87.sh build
SOLDIER_ID=3 sh tools/nu87.sh upload /dev/ttyUSB0
sh tools/nu87.sh monitor /dev/ttyUSB0                 # 9600 baud
```

Optional shared map origin, so all soldiers' positions share one frame once GPS has a fix (degrees × 1e7):

```sh
SOLDIER_ID=3 AO_ORIGIN_LAT_E7=520000000 AO_ORIGIN_LON_E7=134000000 sh tools/nu87.sh build
```

The script stages `src/` as a sketch in `.build/` (git-ignored) and compiles for AMB26 with Auto Upload Mode at 921600 baud. Output image: `.build/output/km0_km4_image2.bin`. The vendor uploader also uses a copy in its tool directory, so do not run two Realtek builds or uploads at once.

If upload cannot enter the bootloader: hold BOOT, press and release RESET, release BOOT. Do not erase the whole flash as routine recovery.

## Operation

At power-on the soldier stands still, facing north, while the node collects a resting baseline. (Until GPS has calibrated the heading, dead reckoning treats the startup direction as north.) Then:

1. **Baseline:** resting heart rate and skin temperature are averaged over 20 valid seconds of each, or whatever was collected after 120 s. The first check-in carries these values, so the commander uses the same baseline.
2. **Every second:** the node evaluates the alert rules (DATA_SPEC section 3) and sends an `ALERT` if one fires; otherwise a `CHECKIN` if due (every 120 s ± 30 s).
3. **Each packet:** sent as non-connectable advertisements every 20–30 ms for 300 ms, then the radio stops. `seq` starts at a random value at boot, so a rebooted node is not mistaken for a duplicate.

**Inputs to the rules:**

| Input | Source |
|---|---|
| Heart rate | Pulse Sensor BPM. 0 = no reading; HR rules are skipped. |
| Skin temperature | TMP36. No reading disables the heat rule. |
| Activity | Mean \|(\|accel\| − 1g)\| over 2 s, scaled so 1g = 255. Needs the IMU running; without it, immobility rules are skipped. |
| Impact | Peak \|accel\| per second. An axis at the ±2g sensor limit counts as an impact, because the true peak cannot be measured. |
| Gas, buttons | Not fitted. Gas is sent as 0; `HAZARD_ENV`, `SITREP_CONTACT` and `SITREP_SOS` are never sent. |

**Position (`x`, `y`):** metres east and north of the origin, sent in decimetres.

- **With a GPS fix:** GPS position.
- **Without:** pedestrian dead reckoning (step detection plus stride length, port of `pdr.py`), continuing from the last GPS position.
- **PDR heading:** the DMP quaternion yaw, relative to the startup direction. After a 15 m GPS track with at least 7.5 m of PDR movement, the node learns the offset to true north.
- **Origin:** the shared `AO_ORIGIN_*` point if built with one; otherwise the power-on position.

## LED

| Pattern | Meaning |
|---|---|
| Steady cyan | Booting, or DMP loading / waiting for stillness |
| 1 blue pulse every 2 s | Collecting baseline |
| 2 green pulses every 2 s | Reporting (baseline sent, check-ins active) |
| 3 red pulses every 2 s | MPU6050 offline or TMP36 reading invalid |
| Fast red blinking | Analog task failed or readings stale |

The LED is active-high through SN74LVC3G17 buffers. Faults override the reporting state. No GPS fix and no finger contact are not faults. The main loop drives the LED, so a stalled loop stops the heartbeat; a stall inside the vendor BLE initializer leaves the LED on boot cyan.

## Sensor handling

- **Pulse:** sampled at 500Hz in its own FreeRTOS task, the only user of the ADC. Sampling gaps invalidate pulse history.
- **TMP36:** 16 readings averaged, spread over time.
- **GPS:** byte budget per loop, checksum and range validation, fix expires after 3 s.
- **IMU:** 5ms deadline per transaction, register read-back, data-ready checks, retry after disconnect. MotionApps 6.12 configuration: ±2g, ±2000°/s, DLPF 1, divider 4. Do not change ranges or divider without a matching DMP configuration. DMP FIFO output is nominally 100Hz; the host polls every loop (≥ 5ms apart) and uses new samples at up to 50Hz.

## DMP startup and recovery

Keep the board still during startup. The firmware resets the MPU6050, uploads the DMP image in 16-byte blocks with read-back verification, then enables it. Startup runs incrementally, so GPS, ADC, radio and the LED keep working. The FIFO is polled over I2C; no INT wire is needed.

IMU data is withheld for at least 10 s after DMP start, and until 100 consecutive packets pass a stillness check (acceleration ≈ 1g, low gyro output, small acceleration changes). This does not prove calibration: slow constant rotation can pass, and there is no absolute heading reference. If the LED stays cyan, keep the board still and check the serial `DMP` line.

FIFO handling: 28-byte packets read as two 14-byte bursts, at most two packets per poll; only the latest valid sample is kept and none is used twice. Overflow, a backlog over four packets, or a partial read resets the FIFO. Three consecutive transfer or decode failures, or 1 s without valid data, takes the IMU offline and restarts initialization. Reinitialization resets the yaw reference, so the PDR heading offset must be relearned from GPS.

Serial `DMP,state=…,fifo_resets=…` states: 0 offline, 1 reset wait, 2 signal reset wait, 3 image upload, 4 start, 5 settling, 6 running. `fifo_resets` includes startup resets. State 6 with changing `QUAT` lines means valid packets, not verified angle accuracy. Yaw drift on this hardware is unmeasured.

Vendored DMP image version, source, checksum and license: [src/sensors/vendor/SOURCE.md](src/sensors/vendor/SOURCE.md).

## Serial output

Onboard USB-UART, **9600 baud, 8N1**. A bounded queue keeps slow UART writes from blocking sampling; lines are dropped when it is full. Vendor boot and BLE stack messages (e.g. `GAP adv start`) also appear.

```text
IMU,t_ms=15000,ax=0,ay=0,az=16384,gx=0,gy=0,gz=0
QUAT,t_ms=15000,w_q30=1073741824,x_q30=0,y_q30=0,z_q30=0
VITALS,t_ms=15000,temp_c_x100=2500,bpm=60,pulse_raw=1800
GPS,t_ms=15000,lat_e7=0,lon_e7=0,alt_cm=0,speed_cms=0,fix=0,sats=0
NODE,t_s=15,activity=2,x_dm=0,y_dm=0,pos=pdr,steps=0,baseline=0,sample_gaps=0
TX,t_s=21,type=2,code=0x00,seq=40213,hr=64,temp_c_x100=3350,x_dm=0,y_dm=0
```

`IMU`, `QUAT`, `VITALS` and `GPS` print once per second (`IMU`/`QUAT` only after DMP stabilization). Each second prints either `NODE` (state, nothing sent) or `TX` (packet queued for sending; `type` 1 = alert, 2 = check-in). `activity=-1` means no valid IMU data.

## Tests

```sh
sh tools/test.sh
```

- **Native C++ (ASan/UBSan):** timing, MPU6050 byte order, I2C failures, TMP36 conversion, pulse timing, NMEA parsing.
- **DMP simulator:** verified image loading, motion gating, partial FIFO packets, overflow and backlog reset, mid-packet bus failure, corruption, stale data, retries, clock wraparound.
- **Node logic:** packet encoding, advertisement layout, activity, heading, PDR, GPS/PDR fusion and heading calibration, baseline, check-in timing, rule handling of missing readings.
- **Parity with `commander-hq/backend`:** the same inputs through the C++ code and the Python reference must give identical packets (500 random) and alert decisions (20 × 1500 s scenarios), and matching PDR tracks.

`main.cpp` and `comm/advertiser.cpp` use the Realtek API and are only compiled by the Arduino build. Tests do not establish sensor accuracy, radio range, current draw or wiring. Hardware evidence and remaining checks: [docs/power-validation.md](docs/power-validation.md).

## Not yet done

- Compile with the Realtek core and run on hardware; confirm the 20 ms advertising interval is accepted and count bursts received.
- Lowest-power transmission: the Arduino BLE API has no TX power setting.
- Relaying other nodes' packets (`hops` is always 0).
- Report buttons and a gas sensor.
- Calibrate the Weinberg stride constant (`Pdr::WEINBERG_K`) per soldier; tune alert thresholds with measured data.

## Sources

- [NUCODE NU-87 start guide and schematic](https://nucode.gitbook.io/nuseries/downloads/nu-87-tinydk)
- [Realtek AmebaD Arduino core](https://github.com/Ameba-AIoT/ameba-arduino-d): AMB26 variant, calibrated ADC, BLE API, uploader
- [Adafruit MPU6050 driver](https://github.com/adafruit/Adafruit_MPU6050)
- [TMP36 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/TMP35_36_37.pdf)
