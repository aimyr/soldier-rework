# Squad HUD

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
