# Commander HQ

Offline commander software: a FastAPI backend that turns gateway packets into squad status, and an Angular map display (COP). A local language model writes plain-language briefings. Track 4 (Tactical Edge) prototype.

```
commander-firmware ──USB serial──► backend ──WebSocket──► frontend (COP)
                                    │ parse · assess · squad correlation
                                    └► local LLM (OpenAI-compatible API) → briefing
```

Packet format: [docs/DATA_SPEC.md](../docs/DATA_SPEC.md).

## Run

Requires Python 3.11+ and Node 20.19+ or 22.12+.

**Windows:** run `SETUP_AND_RUN.bat` once (creates `backend\.venv`, installs dependencies, runs tests, builds the frontend, starts the server). Afterwards use `RUN.bat`.

**Manual:**

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --port 8000      # simulator mode by default

cd frontend
npm install
npx ng serve                          # http://localhost:4200
```

After `npx ng build` in `frontend/`, the backend serves the COP itself at http://localhost:8000 (one port, fully offline).

## Configuration

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `C2_SOURCE` | `sim` | `sim`: built-in squad simulator. `serial`: real gateway |
| `C2_SERIAL_PORT` | `/dev/ttyUSB0` | Gateway port, e.g. `COM3` on Windows |
| `C2_SERIAL_BAUD` | `115200` | |
| `C2_LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | Any OpenAI-compatible local server (Ollama, llama.cpp, LM Studio) |
| `C2_LLM_MODEL` | `llama3.1:8b` | |
| `C2_LLM_ENABLED` | `1` | `0`: always use the rule-based template |
| `C2_SIM_SPEED` | `1.0` | Simulator time factor, e.g. `5` for fast demos |
| `C2_SIM_SQUAD_SIZE` | `8` | |

If the LLM is unreachable, the backend uses the rule-based template briefing.

## Briefing safety

The engine decides the facts; the LLM only phrases them. It receives a compact facts JSON (`Engine.facts`). Output that mentions a callsign not in those facts is discarded and replaced with the template briefing (`briefing._grounded`). The COP shows each briefing's source.

## Demo scenarios (simulator only)

| Button | Simulated event | Expected result |
|---|---|---|
| Injury | One soldier: HR spike, stops moving | `HR_SPIKE_IMMOBILE` → CRITICAL |
| Unconscious | Impact, then immobile, HR falls | `FALL_IMMOBILE` → CRITICAL |
| Heat strain | Skin temperature and HR rise while moving | `HEAT_STRAIN` → WARN (≈1–2 min) |
| Ambush | 3 nearby soldiers go prone with HR spikes; one presses CONTACT | Squad event **POSSIBLE CONTACT** |
| Gas hazard | Gas cloud over the squad | Squad event **HAZARD AREA** |
| SOS | Button press | `SITREP_SOS` → CRITICAL |
| Node dark | One node stops transmitting | UNKNOWN after missed check-ins (≈4.5 min at speed 1) |

**Radio silence %** in the header: the share of sensor samples never transmitted, compared with streaming every sample.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/state` | Full COP snapshot |
| GET | `/api/health` | Source and LLM status |
| POST | `/api/scenario` | `{"name": "ambush"}`; simulator only; `reset` clears |
| POST | `/api/soldiers/{id}/ack` | Acknowledge a soldier's alert |
| POST | `/api/briefing` | Generate a briefing now |
| WS | `/ws` | Pushes `{"type":"state"}` every second, and `{"type":"briefing"}` |

## Layout

```
backend/app/
  protocol.py        18-byte packet encode/decode, CRC-8, gateway line parser
  node_rules.py      node-side alert rules (reference for soldier-firmware)
  analysis/pdr.py    pedestrian dead reckoning (reference for soldier-firmware)
  analysis/assess.py sectors, estimated PSI, severity mapping
  analysis/squad.py  squad-level correlation (proximity clusters)
  engine.py          commander state, events, facts for the briefing
  briefing.py        LLM client, grounding check, template fallback
  simulator.py       synthetic squad using the real packet path
  serial_source.py   gateway serial reader
  main.py            FastAPI app, WebSocket, static COP
backend/tests/       unit and scenario tests (pytest)
frontend/src/app/    Angular 21 COP
```

## Known limitations

- PSI is estimated from skin temperature; the original index uses core temperature.
- All alert thresholds are demo defaults and need tuning with measured data.
- RSSI-based PDR correction (`PDR.correct`) is implemented but not connected to the engine.
