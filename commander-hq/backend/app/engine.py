"""Commander-side state engine: packets in, COP state and events out."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from . import config
from .analysis.assess import (ALERT_INTERPRETATION, ALERT_SEVERITY, SEVERITY_ORDER,
                              psi_band, sector_of, strain_index)
from .analysis.squad import correlate
from .protocol import ALERT_LABELS, AlertCode, Packet, PacketType


@dataclass
class SoldierTrack:
    soldier_id: int
    callsign: str
    hr0: float | None = None
    temp0: float | None = None
    last: Packet | None = None
    last_seen_s: float | None = None
    severity: str = "UNKNOWN"
    active_code: int = AlertCode.NONE
    psi: float | None = None
    packets: int = 0
    acked: bool = False
    trail: deque = field(default_factory=lambda: deque(maxlen=40))

    def to_dict(self, now_s: float) -> dict:
        p = self.last
        stale = self.last_seen_s is None or now_s - self.last_seen_s > config.STALE_AFTER_S
        sev = "UNKNOWN" if stale else self.severity
        return {
            "soldier_id": self.soldier_id,
            "callsign": self.callsign,
            "severity": sev,
            "stale": stale,
            "acked": self.acked,
            "active_code": int(self.active_code),
            "active_label": ALERT_LABELS[AlertCode(self.active_code)],
            "interpretation": ALERT_INTERPRETATION[AlertCode(self.active_code)],
            "hr_bpm": p.hr_bpm if p else None,
            "skin_temp_c": p.skin_temp_c if p else None,
            "activity": p.activity if p else None,
            "gas": p.gas if p else None,
            "x_m": p.x_m if p else None,
            "y_m": p.y_m if p else None,
            "sector": sector_of(p.x_m, p.y_m) if p else None,
            "hops": p.hops if p else None,
            "rssi": p.rssi if p else None,
            "psi_est": self.psi,
            "psi_band": psi_band(self.psi) if self.psi is not None else None,
            "baseline": {"hr_bpm": self.hr0, "skin_temp_c": self.temp0},
            "last_seen_s": self.last_seen_s,
            "seconds_since_seen": None if self.last_seen_s is None else round(now_s - self.last_seen_s, 1),
            "packets": self.packets,
            "trail": list(self.trail),
        }


class Engine:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.soldiers: dict[int, SoldierTrack] = {}
        self.alerts: deque[dict] = deque(maxlen=200)
        self.squad_events: deque[dict] = deque(maxlen=50)
        self._reported: dict[tuple, float] = {}
        self.stats = {"packets": 0, "bytes": 0, "rejected": 0, "alerts": 0, "checkins": 0}

    def track(self, sid: int) -> SoldierTrack:
        if sid not in self.soldiers:
            self.soldiers[sid] = SoldierTrack(sid, f"S{sid}")
        return self.soldiers[sid]

    def reject(self) -> None:
        self.stats["rejected"] += 1

    def ingest(self, p: Packet, now_s: float, nbytes: int) -> list[dict]:
        """Process one packet. Returns new events (alert / squad) for briefing triggers."""
        self.stats["packets"] += 1
        self.stats["bytes"] += nbytes
        tr = self.track(p.soldier_id)
        tr.last, tr.last_seen_s = p, now_s
        tr.packets += 1
        tr.trail.append((round(p.x_m, 1), round(p.y_m, 1)))
        events: list[dict] = []

        if p.ptype == PacketType.CHECKIN:
            self.stats["checkins"] += 1
            if tr.hr0 is None:  # first check-in = mission-start resting baseline
                tr.hr0, tr.temp0 = float(p.hr_bpm), float(p.skin_temp_c)
        if tr.hr0 is not None:
            tr.psi = strain_index(p.hr_bpm, p.skin_temp_c, tr.hr0, tr.temp0)

        code = AlertCode(p.code)
        if p.ptype == PacketType.ALERT and code != AlertCode.NONE:
            self.stats["alerts"] += 1
            prev = SEVERITY_ORDER[tr.severity]
            tr.active_code, tr.severity, tr.acked = code, ALERT_SEVERITY[code], False
            alert = {
                "soldier_id": p.soldier_id, "callsign": tr.callsign, "code": int(code),
                "label": ALERT_LABELS[code], "interpretation": ALERT_INTERPRETATION[code],
                "severity": tr.severity, "sector": sector_of(p.x_m, p.y_m), "t_s": now_s,
                "x_m": p.x_m, "y_m": p.y_m,
                "hr_bpm": p.hr_bpm, "skin_temp_c": p.skin_temp_c, "gas": p.gas,
                "hops": p.hops, "rssi": p.rssi,
            }
            self.alerts.appendleft(alert)
            events.append({"type": "alert", "escalated": SEVERITY_ORDER[tr.severity] > prev, **alert})
        elif p.ptype == PacketType.CHECKIN:
            # a routine check-in clears low states; WARN/CRITICAL persist until the commander acks
            if tr.severity in ("OK", "UNKNOWN", "WATCH") or tr.acked:
                tr.active_code, tr.severity = AlertCode.NONE, "OK"
            if tr.severity == "OK" and tr.psi is not None and tr.psi >= 4:
                tr.severity = "WATCH"

        # squad-level correlation over recent alerts
        self._reported = {k: t for k, t in self._reported.items() if now_s - t <= config.CORRELATION_WINDOW_S}
        for ev in correlate(list(self.alerts), now_s, set(self._reported)):
            self._reported[(ev.kind, ev.sector)] = now_s
            # merge into a recent event of the same kind/sector instead of duplicating it
            prior = next((e for e in self.squad_events if e["kind"] == ev.kind and e["sector"] == ev.sector
                          and now_s - e["t_s"] <= 120), None)
            if prior is not None:
                merged = sorted(set(prior["soldier_ids"]) | set(ev.soldier_ids))
                grew = len(merged) > len(prior["soldier_ids"])
                prior.update(soldier_ids=merged, t_s=now_s,
                             detail=ev.detail.replace(f"{len(ev.soldier_ids)} soldiers", f"{len(merged)} soldiers", 1))
                if grew:
                    events.append({"type": "squad", **prior})
                continue
            d = ev.to_dict()
            self.squad_events.appendleft(d)
            events.append({"type": "squad", **d})
        return events

    def acknowledge(self, sid: int) -> bool:
        tr = self.soldiers.get(sid)
        if not tr:
            return False
        tr.acked = True
        if tr.severity != "CRITICAL":
            tr.active_code, tr.severity = AlertCode.NONE, "OK"
        return True

    def snapshot(self, now_s: float) -> dict:
        soldiers = [t.to_dict(now_s) for t in sorted(self.soldiers.values(), key=lambda t: t.soldier_id)]
        counts: dict[str, int] = {}
        for s in soldiers:
            counts[s["severity"]] = counts.get(s["severity"], 0) + 1
        return {
            "mission_time_s": round(now_s, 1),
            "soldiers": soldiers,
            "alerts": list(self.alerts)[:50],
            "squad_events": list(self.squad_events)[:20],
            "counts": counts,
            "stats": dict(self.stats),
            "grid": {"size_m": config.AO_SIZE_M, "n": config.GRID_N},
        }

    def facts(self, now_s: float) -> dict:
        """Compact, verifiable facts handed to the LLM (and the template fallback)."""
        snap = self.snapshot(now_s)
        flagged = [
            {k: s[k] for k in ("callsign", "severity", "active_label", "interpretation", "sector",
                               "hr_bpm", "skin_temp_c", "psi_est", "seconds_since_seen")}
            for s in snap["soldiers"] if s["severity"] not in ("OK",)
        ]
        recent_squad = [e for e in snap["squad_events"] if now_s - e["t_s"] <= 120]
        return {
            "mission_time": _mmss(now_s),
            "squad_size": len(snap["soldiers"]),
            "status_counts": snap["counts"],
            "flagged_soldiers": flagged,
            "squad_events": [{k: e[k] for k in ("kind", "sector", "detail")} | {
                "callsigns": [f"S{i}" for i in e["soldier_ids"]]} for e in recent_squad],
        }


def _mmss(s: float) -> str:
    s = int(s)
    return f"T+{s // 60:02d}:{s % 60:02d}"
