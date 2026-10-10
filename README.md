# Soldier Rework

Fork of [Squad HUD](https://github.com/csihyeon05/D4D-x-EDTH-Hackathon---Team.-Squad-HUD), preserving the original branches and history. The default `soldier-rework` branch adds phone GPS AR; the original firmware and commander projects remain below.

## Phone camera AR

Every phone shares its GPS position and rear-camera orientation with the laptop. Open `/ar` on each phone to see the others as **thin blue wireframe cubes**. A cube has a fixed physical size, so it gets smaller with distance. Your own GPS position, camera heading, pitch and roll determine the projection; another phone's direction rotates its cube.

**macOS / Linux:**

```sh
cd commander-hq
./run_ar.sh                  # or ./run_ar.sh YOUR_LAPTOP_WIFI_IP
```

**Windows:** double-click `commander-hq/RUN_AR.bat`.

Connect phones and laptop to the same Wi-Fi or hotspot. The launcher prints `https://LAPTOP_IP:8443/ar`. Trust the generated local certificate on the phones, then tap **Start camera + GPS** and allow camera, location and motion access. Use **Try demo** to preview three simulated phones without permissions or GPS uploads. Angular and firmware builds are not needed for this page.

Height is used when both phones provide an altitude with a matching reference and acceptable vertical accuracy (15 m by default). Missing or noisy height falls back to a flat position; settings include a manual altitude correction. GPS and compass errors still affect marker placement. This is approximate GPS AR, with no person recognition, surface tracking or wall occlusion.

On the viewing phone, **Калибровка по человеку** lets you select a participant, aim the central crosshair at them and press **Совместить**. This aligns the GPS cube by adjusting camera heading and tilt. Arrow buttons provide fine adjustments; **Сбросить поправку** clears them. Repeat when GPS drifts or after changing location. Alignment does not improve either phone's GPS coordinates.

See [phone setup, certificate trust, calibration and tests](commander-hq/README.md#phone-ar-and-gps-sharing).

## Original Squad HUD projects

D4D x EDTH hackathon prototype. Soldier-worn sensor nodes report anomalies over BLE to an offline commander laptop, which shows squad status on a map.

```
soldier-firmware ──BLE advertisement──► commander-firmware ──USB serial──► commander-hq
(NU-87 on soldier)                       (NU-87 on laptop)                 (backend + web UI)
```

| Folder | What it is | Language |
|---|---|---|
| [soldier-firmware/](soldier-firmware/) | Node firmware: reads heart rate, temperature, IMU and GPS | C++ (Arduino, Realtek AmebaD) |
| [commander-firmware/](commander-firmware/) | Gateway firmware: receives node packets, forwards them over USB | C++ (Arduino, Realtek AmebaD) |
| [commander-hq/](commander-hq/) | FastAPI backend and Angular map display | Python, TypeScript |
| [docs/DATA_SPEC.md](docs/DATA_SPEC.md) | Packet format and radio rules shared by all three | |

Nodes transmit only on alerts and a randomized check-in, not a continuous stream. Each project's README covers its build and run steps.

## Status

| Part | State |
|---|---|
| soldier-firmware | Event reporting per `docs/DATA_SPEC.md`: alert rules, check-ins, GPS/PDR position, advertising bursts. Unit- and parity-tested against the backend; not yet compiled for or run on hardware. |
| commander-firmware | Written and unit-tested. Not yet compiled for or run on hardware. |
| commander-hq | Working with its built-in squad simulator. |

Open work: [TODO.md](TODO.md).
