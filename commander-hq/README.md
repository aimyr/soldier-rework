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

## Phone AR and GPS sharing

The `/ar` page runs directly from FastAPI, independently of Angular. The phone's rear-camera preview has a canvas overlay with thin blue wireframe cubes. Position is relative to the viewing phone, using WGS84 surface ECEF → local east/north/up coordinates. A pinhole camera projection includes camera heading, pitch and roll, with a configurable field of view. Cubes have a constant physical edge (1.8 m by default); their perspective size decreases with distance. Their yaw follows the other phone's last known rear-camera direction, or its compass heading when it uses the GPS-only page.

### Start on the laptop

Requires Python 3.11+. No Node/Angular build is required for AR.

```sh
cd commander-hq
./run_ar.sh 192.168.1.10    # replace with this laptop's Wi-Fi/hotspot IP
```

Windows: run `RUN_AR.bat`, or `powershell -File run_ar.ps1 -LaptopIp 192.168.1.10`. Both launchers create `backend/.venv`, install dependencies and serve HTTPS on port 8443. If IP autodetection picks a VPN or another adapter, supply the Wi-Fi IP explicitly. Use `AR_PORT=9443 ./run_ar.sh IP` or `run_ar.ps1 -Port 9443` to change the port. Allow that port from the local subnet in your firewall when necessary.

Open `https://LAPTOP_IP:8443/ar` on every phone on the same Wi-Fi/hotspot. Each phone gets a persistent unique ID shared with `/gps`; change it before starting if needed. Allow camera, location and motion permissions after pressing **Start camera + GPS**. Keep the page foregrounded. **Stop**, closing the page or hiding it stops the camera, GPS watch and network polling. Phones can also share position without the camera using `/gps`. Laptop readings and CSV downloads are at `/gps/pc`.

### Trusted HTTPS on phones

Camera and location require a [secure context](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia). The helper creates a persistent local root CA and a server certificate for the laptop IP, including localhost. Transfer **only** `backend/certs/root-ca.cer` to the phones and install/trust it for this development server. Private keys stay on the laptop. The root is reused on later runs, so restarting does not require trusting a different certificate.

On iPhone, install the certificate profile, then enable it under **Settings → General → About → Certificate Trust Settings**; see [Apple's certificate trust instructions](https://support.apple.com/en-us/102390). On Android, use the device's **Install a certificate → CA certificate** setting (the exact path varies). Reload the page and verify it is trusted. Merely proceeding through a certificate error can leave sensor APIs unavailable. A trusted existing HTTPS reverse proxy can be used instead.

For a local desktop preview without HTTPS or hardware:

```sh
cd commander-hq/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
C2_LLM_ENABLED=0 .venv/bin/python -m uvicorn app.main:app --port 8765
```

Open `http://localhost:8765/ar` and press **Try demo**. Demo participants stay in that browser; the demo does not request camera/GPS access or send positions to the server.

### Direction and height

**GPS and phone motion:** both phone pages collect optional `devicemotion` readings after Start. Linear acceleration and angular-rate magnitudes are summarized as RMS values and a conservative `unknown` / `still` / `moving` phone-motion state. The GPS packet binds those readings to the same device ID with a separate sensor timestamp and age. The backend keeps GPS and motion freshness independently; new IMU readings cannot make an old GPS position fresh. A sensor permission denial or missing readings leaves GPS collection working.

The viewing phone can enable **Стабилизировать GPS с учётом движения телефона** (on by default). This smooths the viewer and participant positions using GPS timestamps, reported uncertainty, speed and recent motion state. Stationary jitter is reduced; movement remains responsive and repeated large changes can reacquire a new position. Raw latitude/longitude, GPS timestamps and reported accuracy are never replaced in uploads or logs. Stop clears the filter and sensor listeners. Disable/re-enable the setting to reset the display filter, then repeat visual alignment if necessary.

This is sensor-assisted display stabilization, not centimetre-level positioning. It can introduce tracking delay, and a stationary-looking phone can still be carried at a steady speed. GPS motion overrides are therefore required. Acceleration is not integrated twice into a position: bias would accumulate rapidly, and the phone frame does not necessarily match the walking direction. See [W3C motion readings](https://www.w3.org/TR/orientation-event/#devicemotion) and [Android linear-acceleration limitations](https://developer.android.com/develop/sensors-and-location/sensors/sensors_motion#sensors-motion-linear). GPS travel course is kept separate from camera direction.

**Manual alignment on the viewing phone:** start `/ar`, then in **Калибровка по человеку** select the other phone's ID. Both phones need fresh GPS; the other phone can use `/gps` without its camera. Stand still, preferably 10–20 m apart or farther, aim the central **+** at the person with that phone, and press **Совместить**. The cube's centre is placed at the crosshair by applying heading and vertical camera corrections. All markers on this viewer use those corrections; shared latitude/longitude stay unchanged. This also establishes an initial direction for relative orientation sensors, which continue following phone rotations afterwards.

Use **Куб влево / вправо / выше / ниже** for roughly 0.5° screen adjustments, or the **Compass correction** and **Vertical camera correction** sliders below. **Сбросить поправку** clears these alignment offsets. Fresh GPS is required again if a selected participant goes stale; another participant is never automatically selected in their place. Keep the phone near horizontal when aligning, and reset a large correction before trying again. Recheck after moving, restarting or sensor drift. GPS errors can change with distance and surroundings, so this is a visual reference adjustment, not a precise GPS calibration. Field of view can be adjusted separately if a centred marker diverges near image edges.

The app computes the rear-camera direction from the full [W3C device rotation](https://www.w3.org/TR/orientation-event/#worked-example), including screen rotation. GPS course describes travel direction and is never used as the viewing camera's direction. Absolute orientation is preferred. Safari's compass is magnetic-north referenced; the **Compass correction** slider or **Set this direction** button can correct declination and sensor offsets. If the browser only gives relative orientation, aim the rear camera at a known geographic direction, enter its bearing (north 0°, east 90°), and set it. A prior Safari alignment is retained as calibration when its top edge is exactly upright. Check calibration after restart or drift. An unchanged orientation is retained while the page is active because events may fire only when it changes; unavailable/null orientation data clears the pose.

Horizontal field of view is estimated from a 65° long-axis lens angle and the actual preview dimensions. The video preserves its aspect ratio, and projection matches the visible video rectangle. Auto FOV updates after rotation; changing the slider holds your manual value. Real lens characteristics, stabilization and distortion vary, so adjust FOV on the phone.

Browser GPS altitude is [WGS84 ellipsoid height](https://www.w3.org/TR/geolocation/#altitude-attribute). The existing firmware's NMEA altitude is mean sea level (`msl`). The backend carries `alt_reference`; these references are never mixed. Vertical displacement is used only when both heights and vertical uncertainties are present, the references match (`wgs84` or `msl`) and each uncertainty is below the setting's limit (15 m default). Otherwise cubes use a flat height. **My altitude correction** adds to the viewing phone's altitude: a positive correction moves the other markers down, and works as a manual vertical adjustment even with flat fallback. GPS altitude cannot reliably identify floors; better vertical placement needs calibrated barometer/known heights or native AR tracking.

Position and pose are uploaded and other devices polled once per second. Both `/ar` and the camera-free `/gps` page request a fresh GPS fix every 5 seconds to keep stationary phones updated. GPS fixes older than 10 seconds are hidden; transport inactivity becomes offline after 30 seconds. The viewing phone, duplicate-ID conflicts and invalid fixes are excluded. The viewer draws targets from 2 m to 2 km; very close GPS positions are too uncertain for a useful cube. Cubes outside the camera view are not drawn. No wall occlusion or camera-based person detection is performed.

### API and verification

`POST /api/gps` retains compatibility with the original phone payload and adds optional `camera_heading_deg`, `camera_pitch_deg`, `camera_roll_deg`, `orientation_unix_ms`, `orientation_source`, `alt_reference`, `fix_age_ms`, and `orientation_age_ms`. `GET /api/gps` returns devices with receive/fix/orientation ages and stale/offline flags. `orientation_age_s` is time since the last orientation change; a stationary phone may still have a valid unchanged pose. The GPS monitor displays camera direction separately from course/top-edge compass. CSV includes all telemetry. Older GPS timestamps are ignored; repeated timestamps may update orientation but cannot refresh or alter their GPS fix. The store is bounded to 256 devices and expires inactive entries after an hour. Logs and TLS files are ignored by Git.

```sh
cd commander-hq/backend
.venv/bin/python -m pytest -q
node --test tests/ar-math.test.mjs tests/gps-stability.test.mjs
```

Browser smoke tests: start the backend on port 8765, then run `npm ci`, `npx playwright install chromium`, `npm test` and `npm run test:gps` in `commander-hq/ar-tests`. They use simulated media/GPS/orientation, not physical sensors. Physical iPhone/Android camera alignment, GPS accuracy and sensor calibration require a two-phone outdoor check. The local prototype shares positions with clients on its server and has no account authentication.

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
