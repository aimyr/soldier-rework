"""FastAPI entry point: data source -> engine -> WebSocket COP + briefings."""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config
from .briefing import Briefer
from .engine import Engine
from .gps import GpsFix, GpsStore
from .protocol import PACKET_SIZE, PacketError, decode, parse_gateway_line
from .simulator import SCENARIOS, SquadSimulator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("c2")


class Hub:
    """Shared runtime: one engine, one source, many COP clients."""

    def __init__(self) -> None:
        self.engine = Engine()
        self.briefer = Briefer()
        self.sim = SquadSimulator() if config.SOURCE == "sim" else None
        self.clients: set[WebSocket] = set()
        self.briefings: list[dict] = []
        self.t0 = time.monotonic()
        self._brief_pending = False
        self.serial_queue: asyncio.Queue = asyncio.Queue()
        self.gps = GpsStore()

    def now(self) -> float:
        return self.sim.t if self.sim else time.monotonic() - self.t0

    async def broadcast(self, msg: dict) -> None:
        dead = []
        for ws in self.clients:
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def state(self) -> dict:
        snap = self.engine.snapshot(self.now())
        snap["source"] = config.SOURCE
        snap["emission"] = self.sim.emission_stats() if self.sim else None
        snap["briefings"] = self.briefings[:10]
        snap["gps"] = self.gps.snapshot()
        snap["llm"] = {"enabled": config.LLM_ENABLED, "reachable": self.briefer.llm_ok,
                       "model": config.LLM_MODEL, "base_url": config.LLM_BASE_URL}
        return snap

    def handle_events(self, events: list[dict]) -> None:
        important = any(
            (e["type"] == "squad") or (e["type"] == "alert" and e["severity"] in ("CRITICAL", "WARN"))
            for e in events)
        if important:
            self.request_briefing(delay=2.0, trigger="event")

    def request_briefing(self, delay: float = 0.0, trigger: str = "manual") -> None:
        if self._brief_pending:
            return
        self._brief_pending = True
        asyncio.get_running_loop().create_task(self._brief(delay, trigger))

    async def _brief(self, delay: float, trigger: str) -> None:
        try:
            await asyncio.sleep(delay)  # let related packets arrive and get correlated first
            b = await self.briefer.brief(self.engine.facts(self.now()))
            b["trigger"], b["mission_time_s"] = trigger, round(self.now(), 1)
            self.briefings.insert(0, b)
            del self.briefings[20:]
            await self.broadcast({"type": "briefing", "briefing": b})
        finally:
            self._brief_pending = False

    # ------------------------------------------------------------ source loops
    async def sim_loop(self) -> None:
        while True:
            for raw, rssi in self.sim.step(1.0):
                try:
                    self.handle_events(self.engine.ingest(decode(raw, rssi), self.now(), len(raw)))
                except PacketError:
                    self.engine.reject()
            await self.broadcast({"type": "state", "state": self.state()})
            await asyncio.sleep(1.0 / max(0.1, config.SIM_SPEED))

    async def serial_loop(self) -> None:
        from .serial_source import start_serial_reader
        start_serial_reader(asyncio.get_running_loop(), self.serial_queue)
        while True:
            line = await self.serial_queue.get()
            try:
                p = parse_gateway_line(line)
            except (PacketError, ValueError):
                self.engine.reject()
                continue
            if p is not None:
                self.handle_events(self.engine.ingest(p, self.now(), PACKET_SIZE))

    async def tick_loop(self) -> None:
        """In serial mode, push state every second so staleness updates on the COP."""
        while True:
            await asyncio.sleep(1.0)
            await self.broadcast({"type": "state", "state": self.state()})


hub: Hub


@asynccontextmanager
async def lifespan(app: FastAPI):
    global hub
    hub = Hub()
    tasks = [asyncio.create_task(hub.sim_loop() if hub.sim else hub.serial_loop())]
    if not hub.sim:
        tasks.append(asyncio.create_task(hub.tick_loop()))
    log.info("C2 backend up (source=%s, llm=%s %s)", config.SOURCE, config.LLM_BASE_URL, config.LLM_MODEL)
    yield
    for t in tasks:
        t.cancel()
    hub.gps.close()


app = FastAPI(title="Squad Tactical C2", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
                   allow_methods=["*"], allow_headers=["*"])


class ScenarioReq(BaseModel):
    name: str
    soldier_id: int | None = None


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "source": config.SOURCE, "llm_reachable": hub.briefer.llm_ok,
            "llm_error": hub.briefer.last_error}


@app.get("/api/state")
def get_state() -> dict:
    return hub.state()


@app.get("/api/scenarios")
def list_scenarios() -> dict:
    return {"available": SCENARIOS if hub.sim else {}, "source": config.SOURCE}


@app.post("/api/scenario")
def trigger_scenario(req: ScenarioReq) -> dict:
    if not hub.sim:
        raise HTTPException(400, "scenarios are only available with C2_SOURCE=sim")
    res = hub.sim.trigger(req.name, req.soldier_id)
    if req.name == "reset" and res.get("ok"):
        hub.engine.reset()
        hub.briefings.clear()
    return res


@app.post("/api/soldiers/{sid}/ack")
def ack(sid: int) -> dict:
    if not hub.engine.acknowledge(sid):
        raise HTTPException(404, "unknown soldier")
    return {"ok": True}


@app.post("/api/briefing")
async def briefing_now() -> dict:
    b = await hub.briefer.brief(hub.engine.facts(hub.now()))
    b["trigger"], b["mission_time_s"] = "manual", round(hub.now(), 1)
    hub.briefings.insert(0, b)
    await hub.broadcast({"type": "briefing", "briefing": b})
    return b


# ---------------------------------------------------------------- phone GPS
_static = Path(__file__).resolve().parent / "static"


@app.get("/gps", include_in_schema=False)
def gps_page() -> FileResponse:
    """Phone measurement page. Open it on the phone over HTTPS (see README)."""
    return FileResponse(_static / "gps.html")


@app.post("/api/gps")
async def post_gps(fix: GpsFix) -> dict:
    row = hub.gps.ingest(fix)
    await hub.broadcast({"type": "gps", "fix": row})
    return {"ok": True, "heading_deg": row["heading_deg"], "heading_source": row["heading_source"]}


@app.get("/api/gps")
def get_gps() -> dict:
    return hub.gps.snapshot()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    hub.clients.add(ws)
    await ws.send_json({"type": "state", "state": hub.state()})
    try:
        while True:
            await ws.receive_text()  # keepalive; client messages are not used
    except WebSocketDisconnect:
        hub.clients.discard(ws)


# Serve the built Angular COP from the same process (fully offline, one port)
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist" / "frontend" / "browser"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="cop")
