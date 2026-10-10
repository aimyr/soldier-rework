# NU40 HUD Sensor Firmware

Reads a NU-IMU, TMP36, analog Pulse Sensor, and UART NMEA GPS on the NU40 DK and sends BLE notifications to a PC. GPS is enabled by default.

## Wiring

The manufacturer's NU40 Arduino variant is included in this project. `board = adafruit_feather_nrf52840` retains the flash and bootloader configuration previously used for successful uploads; the actual pin definitions come from `variants/nu40dk_nrf52840`. Use the NU40 pin map, not the Feather pin map, when interpreting Arduino pin numbers and nRF port numbers.

| Component signal | NU40 connection | Notes |
|---|---|---|
| TMP36 VOUT | A0 = P0.02 | `PIN_TMP36` |
| TMP36 +VS | 3.3V | A 100nF bypass capacitor between +VS and GND near the sensor is recommended |
| TMP36 GND | GND | TO-92 pins: 1=+VS, 2=VOUT, 3=GND; check the datasheet bottom view |
| Pulse Sensor S | A1 = P0.03 | `PIN_PULSE` |
| Pulse Sensor + / − | 3.3V / GND | Check the terminal labels on the purchased sensor |
| NU-IMU | Qwiic connector | SDA=P0.26, SCL=P0.27, 3.3V, GND |
| GPS TX | P1.01 (Arduino 33, Serial1 RX) | Connect this signal and GND for reception |
| GPS RX | P1.02 (Arduino 34, Serial1 TX) | Optional; the firmware does not send configuration commands |
| GPS GND | GND | Common ground for all sensors |
| GPS VCC | Follow the module specification | The model is unconfirmed; supply voltage may differ from UART signal voltage |

Use 3.3V levels for analog inputs and UART/I2C signals. The ADC's 3.6V conversion range does not mean the pins tolerate a 3.6V or 5V input. Connect the TMP36 according to the datasheet pin numbers; do not infer pin orientation from the package's flat face alone.

The NU-IMU product image identifies the sensor as LSM6DS3TR. The driver checks the TR-C WHO_AM_I value of 0x6A and reads back configuration registers, probing I2C addresses 0x6A and 0x6B. If the supplied sensor has a different ID, it logs the mismatch and leaves the IMU offline.

GPS defaults to **UART NMEA GGA/RMC at 9600 baud**. The actual model and baud rate are not yet confirmed. Adjust `GPS_BAUD` in `src/config.h` for your module. This parser cannot read a UBX-only binary stream.

## Build and Upload

Run these commands from the project directory. The wrapper prefers the VS Code PlatformIO virtual environment when installed.

```sh
sh tools/pio.sh run -e nucode_nu40
sh tools/pio.sh device list
sh tools/pio.sh run -e nucode_nu40 -t upload --upload-port /dev/ttyACM0
sh tools/pio.sh device monitor -p /dev/ttyACM0 -b 9600
```

Replace the port with your actual device: `COMx` on Windows or `/dev/cu.usbmodem...` on macOS. The default Linux upload pattern is restricted to `/dev/ttyACM*` to avoid selecting `/dev/ttyS0`. Specify an exact port when multiple boards are connected. If no port exists, check the USB data cable and bootloader mode.

## Onboard Status LED

LED1 (`LED_BUILTIN`, P0.13) displays status. The main loop updates the pattern without a blocking LED delay. Short pulses reduce power consumption during normal operation.

| LED pattern | Meaning |
|---|---|
| Steady on during boot | Initialization in progress; remaining on may indicate stalled initialization |
| One short pulse every 2 seconds | Running, waiting for a BLE connection |
| Two short pulses every 2 seconds | Running, BLE connected; this does not confirm receipt by the PC application |
| Three short pulses every 2 seconds | IMU missing/offline or invalid TMP36 reading |
| Continuous fast blinking, 4 times per second | BLE/analog task initialization failure or analog data stalled for at least 1 second |

Errors take priority over the BLE connection indication. Waiting for a GPS fix or missing BPM due to lack of finger contact does not trigger an LED error. Check the serial `GPS`, `VITALS`, and `STATUS` records for those conditions. Since the main loop generates the pattern, blinking stops if the loop stalls. The bootloader may use different LED patterns.

## Serial Debugging at 9600 Baud

Open the USB serial monitor at 9600 baud to see every telemetry type independently of the BLE connection. IMU records are emitted for fresh readings at approximately 50Hz, VITALS at 5Hz, and GPS and STATUS at 1Hz each. Pulse raw values match the BLE packet sampling points; the internal 500Hz pulse sample stream is not printed in full.

```text
IMU,t_ms=1000,ax=0,ay=0,az=8197,gx=0,gy=0,gz=0
VITALS,t_ms=1000,temp_c_x100=2500,bpm=60,pulse_raw=1800
GPS,t_ms=1000,lat_e7=0,lon_e7=0,alt_cm=0,speed_cms=0,fix=0,sats=0
STATUS,t_ms=1000,version=1,flags=0x2F,tx_dropped=0,sample_gaps=0
```

These values illustrate the output format. IMU axes contain raw readings; conversion factors are listed in the packet table below. `temp_c_x100=2500` means 25.00°C, and `-32768` means invalid. GPS coordinates use degrees multiplied by 1e7. When the IMU is offline, there are no IMU records and STATUS bit0 is clear.

`Serial` uses TinyUSB USB CDC: 9600 is the port setting, and actual USB throughput is not limited to a physical 9600bps UART. It is separate from GPS `Serial1`. Logs are skipped when the monitor is closed or the USB buffer is full so acquisition can continue. Logging is enabled by default; set `CFG_DEBUG=0` to disable it.

## PC Receiver

Requires Python 3.10 or later and a BLE adapter. On Linux, the execution environment must have access to BlueZ/D-Bus.

```sh
python3 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
.venv/bin/python tools/ble_receiver.py
.venv/bin/python tools/ble_receiver.py --jsonl capture.jsonl
```

Use `--address ADDRESS` to select a specific board when several are present. The console displays the latest values once per second; JSONL records every received packet and its PC reception time. Readings older than 3 seconds are removed from the display. The receiver retries discovery after a missing device, disconnection, or 5 seconds without data. Press Ctrl+C to exit. Malformed packets and unsupported protocol versions cause an error exit.

The UUIDs changed to resolve the previous reuse of Nordic UART Service UUIDs. Use the updated firmware and receiver together. The service UUID is `76b90001-7c4d-4f21-9b63-136a2d8e507c`; characteristic UUIDs replace the final digit of the first group with 2, 3, 4, or 5.

## Architecture and Behavior

- `src/main.cpp`: Initialization, IMU/GPS acquisition, and packet publication.
- `src/config.h`: Pins, baud rates, and sampling/publication periods.
- `src/sensors/analog_sensors.*`: A dedicated FreeRTOS task exclusively owns the ADC. Targets average 500Hz pulse sampling and 100Hz temperature sampling with a 16-sample average; a queue provides consistent snapshots.
- `src/sensors/pulse_sensor.*`: Calculates BPM using actual elapsed time. Resets after a sampling gap greater than 20ms or 2.5 seconds without a beat.
- `src/sensors/tmp36.*`: Converts 12-bit ADC readings with a 3.6V reference to Celsius. Values outside -40 to 125°C and incomplete initial averages are invalid.
- `src/sensors/imu.*`: Uses ±4g and ±500dps ranges, with a default internal ODR of 52Hz in low-power mode (`IMU_LOW_POWER=false` selects 104Hz high-performance mode). Publishes fresh data at approximately 50Hz. Goes offline after three consecutive communication failures or 1 second without fresh data; retries initialization every 2 seconds.
- `src/comm/i2c_bus.*`: Open-drain software I2C with a 5ms transaction deadline, potentially exceeded by one RTOS sleep tick. Checks STOP line release and performs nine-clock recovery on reinitialization. Yields through RTOS delays while the clock is held low. This separate driver avoids unbounded hardware waits in the core Wire implementation. Intended for a single master and short Qwiic wiring; check the sensor board's pull-ups before adding external ones.
- `src/sensors/nmea_parser.*`: Arduino-independent GPS parser. Validates checksums, lengths, coordinates, units, and numeric ranges; expires positions after 3 seconds, expires speed independently, and handles invalid RMC status.
- `src/comm/ble_link.*`: A separate task and an eight-packet queue keep acquisition running. New packets are dropped and counted when the queue is full. Packets queued for more than 500ms and packets from previous connections are discarded. Clients must subscribe again after reconnecting.
- `src/protocol/*`, `tools/protocol.py`: Binary formats and PC decoding.

Pulse acquisition distributes the 1024Hz RTOS clock into two- and three-tick intervals to schedule an average of 500Hz. Host tests check cumulative tick accuracy over 1000 seconds, but interrupts and task delays mean this is not exact 2ms hardware-timer sampling. Sample intervals exceeding 4ms increment `sample_gaps`. Real signals require validation for noise, motion, and sensor contact. Software alone cannot reliably detect a floating ADC input. TMP36 measures its own temperature; do not interpret it directly as core body temperature.

## Protocol v1

All packets use little-endian fields without padding. Each is at most 20 bytes and fits in one notification at the default ATT MTU of 23. `t_ms` is the board's 32-bit millisecond counter, which wraps approximately every 49.7 days and restarts at zero after reboot.

| Characteristic | Size / rate | Python format | Fields |
|---|---|---|---|
| IMU (`...02`) | 16B / target 50Hz | `<I6h` | t_ms, ax/ay/az, gx/gy/gz; acceleration ×0.000122 g, angular rate ×0.0175 dps |
| Vitals (`...03`) | 10B / 5Hz | `<IhHH` | Acquisition t_ms, °C×100, BPM, ADC raw; temperature -32768=invalid, BPM 0=unavailable |
| GPS (`...04`) | 20B / 1Hz | `<IiiiHBB` | t_ms, latitude×1e7, longitude×1e7, altitude cm, speed cm/s, fix, satellite count |
| Status (`...05`) | 16B / 1Hz + read | `<IHHII` | t_ms, version=1, flags, tx_dropped, sample_gaps |

Status flags: bit0 IMU online, bit1 analog data fresh, bit2 temperature in range, bit3 BPM available, bit4 GPS fix, bit5 GPS enabled. When GPS fix=0, coordinates, altitude, speed, and satellite count are zeroed; the receiver displays location as `null`. A zero speed can mean stationary, unavailable, or expired. Position comes from GGA; enable GGA output on modules that currently send only RMC.

`tx_dropped` counts queue overflow, expired packets, and notification failures. It excludes data not transmitted because no client was connected or subscribed. BLE notifications do not provide PC application acknowledgments or persistent storage. The development service currently does not require encryption or pairing.

## Power Settings and Measurements

Power-related settings are centralized in `src/config.h`. Defaults are:

- IMU: 52Hz low-power mode, retaining ranges and packet units. Noise differs from high-performance mode and needs validation with actual orientation/motion measurements.
- BLE: MTU 23, event length 7.5ms, eight-entry HVN queue, sized for packets of 20 bytes or less instead of maximum bandwidth.
- BLE connection interval: requests 30–50ms. The PC chooses the actual interval, and multiple packets can be sent per event.
- Transmit power: 0dBm. Range and packet-loss measurements are required before reducing it further.
- Advertising: every 100ms for the first 10 seconds, then every second. Discovery can take longer than with the previous settings.
- Automatic connection LED disabled; main loop idle delay of 5ms. The pulse task now wakes an average of 500 times per second instead of checking every RTOS tick. The application status LED uses the short patterns described above.
- Requested 9600-baud USB serial output is retained. Text formatting is skipped when the monitor is closed.

These are configuration values, not measured current savings. GPS power/sleep commands have not been changed because the model is unconfirmed. Board and sensor power LEDs, the GPS antenna/receiver, and USB connections also affect system current. See [Power and Stability Validation](docs/power-validation.md) for measurement procedures and outstanding work.

## Validation

```sh
sh tools/test.sh
sh tools/pio.sh run -e nucode_nu40
```

Host tests use a C++ compiler with ASan/UBSan. They cover corrupted GPS checksums, excessive input length, coordinate errors, fix/speed expiration, millisecond rollover, recovery after random bytes, synthetic pulse signals and sampling gaps, temperature conversion, normal I2C reads/writes, repeated START, NACK, stuck SDA/SCL, recovery after STOP failure, and Python packet length/UUID consistency.

Hardware validation is separate. After connecting the sensors, check:

1. WHO_AM_I=0x6A in the boot log and the IMU online Status bit.
2. Approximately 1g acceleration magnitude at rest and changing gyro readings during rotation.
3. TMP36 ambient readings against a reference thermometer and BPM stabilization after finger contact.
4. GPS fix=1 in open sky and fix=0 within 3 seconds after disconnecting GPS.
5. PC and sensor disconnect/reconnect behavior, plus drops/gaps during extended operation.

Successful builds and host tests do not guarantee correct wiring, RF quality, measurement accuracy, or uninterrupted long-term operation.

## References

- [NU-IMU product image identifying LSM6DS3TR](https://nucode.store/web/upload/NNEditor/20260917/NU-IMU20SENSOR01-1.jpg)
- [NU40 DK manufacturer documentation](https://nucode.gitbook.io/nuseries/dks/nu-40-dk)
- [Manufacturer's NU40 Arduino variant](https://github.com/Nucode01/Adafruit_nRF52_Arduino/tree/master/variants/nu40dk_nrf52840); see `variants/nu40dk_nrf52840/SOURCE.txt` for the vendored commit.
- [ST LSM6DS3TR-C datasheet](https://www.st.com/resource/en/datasheet/lsm6ds3tr-c.pdf)
- [Analog Devices TMP35/36/37 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/TMP35_36_37.pdf)
- [Bleak API documentation](https://bleak.readthedocs.io/en/latest/api/client.html)
