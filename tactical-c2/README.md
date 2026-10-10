# Squad Tactical C2 — Offline Edge COP

Track 4 (Tactical Edge) prototype. Soldier-worn nodes stay radio-silent and
transmit 18-byte alerts only on anomalies; an offline commander laptop
correlates them, shows a Common Operational Picture, and phrases a briefing
with a local small language model.

```
 soldier nodes (ESP32)        gateway ESP32         commander laptop (offline)
 sensors → PDR → rules  ──ESP-NOW──►  USB serial  ──►  FastAPI backend ──WebSocket──► Angular 21 COP
          (silent unless                               │  parse · assess · squad correlation
           a rule fires)                               └► local sLLM (OpenAI-compatible) → briefing
```

## Quick start

Requirements: Python 3.11+, Node 20.19+ / 22.12+.

```bash
# 1) backend
cd backend
pip install -r requirements.txt
uvicorn app.main:app --port 8000          # simulator mode by default

# 2) frontend (dev, hot reload) — open http://localhost:4200
cd frontend
npm install
npx ng serve
```

Single-port offline mode: run `npx ng build` once in `frontend/`; the backend then
serves the COP itself at http://localhost:8000.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `C2_SOURCE` | `sim` | `sim` = built-in squad simulator, `serial` = real gateway |
| `C2_SERIAL_PORT` | `/dev/ttyUSB0` | e.g. `COM3` on Windows |
| `C2_SERIAL_BAUD` | `115200` | |
| `C2_LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | any OpenAI-compatible local server (Ollama, llama.cpp server, LM Studio) |
| `C2_LLM_MODEL` | `llama3.1:8b` | model name on that server |
| `C2_LLM_ENABLED` | `1` | `0` = always use the rule template |
| `C2_SIM_SPEED` | `1.0` | simulator time factor (e.g. `5` for fast demos) |
| `C2_SIM_SQUAD_SIZE` | `8` | |

Without a reachable LLM the backend falls back to a deterministic rule-based
briefing, so the demo never depends on the model being up.

## Briefing safety

The engine decides what is true; the LLM only phrases it. The model receives
a compact facts JSON (`Engine.facts`). If its output mentions a callsign that is
not in those facts, the output is discarded and the template briefing is shown
instead (`briefing._grounded`). Every briefing on the COP shows its source.

## Demo scenarios (simulator)

| Button | What happens | Expected result |
|---|---|---|
| Injury | one soldier: HR spike, stops moving | `HR_SPIKE_IMMOBILE` → CRITICAL |
| Unconscious | impact, then immobile, HR falls | `FALL_IMMOBILE` → CRITICAL |
| Heat strain | skin temp and HR rise while moving | `HEAT_STRAIN` → WARN (≈1–2 min) |
| Ambush | 3 nearby soldiers go prone, HR spike, one presses CONTACT | squad event **POSSIBLE CONTACT** |
| Gas hazard | gas cloud over the squad | squad event **HAZARD AREA** |
| SOS | button press | `SITREP_SOS` → CRITICAL |
| Node dark | one node stops transmitting | UNKNOWN after missed check-ins (≈4.5 min at speed 1) |

The header shows **radio silence %**: the share of sensor samples that never
went on air, compared with a design that streams every sample.

## Phone GPS node (stopgap for the missing GPS module)

The team has no GPS module, so a phone measures **latitude, longitude, accuracy
and heading** in its browser and posts one fix per second to the backend.

```powershell
RUN_GPS.bat        # HTTPS on :8443, creates a self-signed cert on first run
```

1. Put the phone and the laptop on the same Wi-Fi or phone hotspot.
2. On the phone open `https://<laptop-ip>:8443/gps` (the URL is printed at start).
   Accept the certificate warning once (self-signed). HTTPS is required:
   browsers block the Geolocation API on plain `http://` except `localhost`.
3. Enter a device ID (e.g. `P1`) and press **측정 시작**. Allow location (and
   motion/compass on iOS).

| Field | Source on the phone | Notes |
|---|---|---|
| `lat`, `lon` | `GeolocationPosition.coords` | WGS84 degrees |
| `accuracy_m` | `coords.accuracy` | radius in metres; ≤ 10 m is good |
| `heading_gps_deg` | `coords.heading` | course over ground, `null` when standing still |
| `heading_compass_deg` | `deviceorientationabsolute` (Android) / `webkitCompassHeading` (iOS) | where the top of the phone points, from magnetic sensor |
| `heading_deg` | chosen by backend | GNSS course if speed ≥ 1 m/s, else compass |

Every fix is appended to `backend/data/gps_<start time>.csv`; the latest fix per
device is in `GET /api/gps`, in `/api/state` under `gps`, and pushed on the
WebSocket as `{"type": "gps", "fix": {...}}`. If the laptop is unreachable the
page buffers up to ~15 min of fixes and resends them; the **CSV** button saves
the phone's own copy. The page map uses OpenStreetMap tiles, which need
internet; without it the readings and upload still work, only the map is blank.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/state` | full COP snapshot |
| GET | `/api/health` | source and LLM status |
| POST | `/api/scenario` | `{"name": "ambush"}` (sim only; `reset` clears) |
| POST | `/api/soldiers/{id}/ack` | commander acknowledges an alert |
| POST | `/api/briefing` | generate a briefing now |
| GET | `/gps` | phone GPS measurement page |
| POST | `/api/gps` | one phone fix (JSON, see above) |
| GET | `/api/gps` | latest fix and track per phone |
| WS | `/ws` | pushes `{"type":"state"}` every second and `{"type":"briefing"}` |

## Layout

```
backend/app/
  protocol.py        18-byte packet encode/decode, CRC-8, gateway line parser
  node_rules.py      node-side trigger rules (firmware reference)
  analysis/pdr.py    pedestrian dead reckoning (firmware reference)
  analysis/assess.py sectors, estimated PSI, severity mapping
  analysis/squad.py  squad-level correlation (proximity clusters)
  engine.py          commander state, events, facts for the briefing
  briefing.py        local LLM client + grounding guard + template fallback
  simulator.py       synthetic squad using the real packet path
  serial_source.py   gateway reader
  main.py            FastAPI app, WebSocket, static COP
backend/tests/       unit + scenario tests (pytest)
frontend/src/app/    Angular 21 COP (signals, zoneless)
docs/DATA_SPEC.md    packet contract with the firmware
firmware/            reference gateway sketch (ESP-NOW → serial)
```

## Known limitations

- PSI is **estimated** from skin temperature; the original index uses core temperature.
- All node thresholds are demo defaults; tune them with measured data.
- RSSI-based PDR correction (`PDR.correct`) is implemented but not yet wired into the engine.
