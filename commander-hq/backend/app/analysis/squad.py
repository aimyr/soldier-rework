"""Squad-level correlation: patterns no single node can see.

A node only knows about itself. The commander sees alerts from everyone, so
it can notice when several soldiers close to each other break silence at the
same time - which points to a shared cause (contact, hazard area) rather than
individual medical events.

Grouping is by distance (CLUSTER_RADIUS_M), not by sector, so a group that
straddles a sector boundary is still recognised. The event is labelled with
the sector of the group's centroid.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from .. import config
from ..protocol import AlertCode
from .assess import sector_of

STRESS_CODES = {AlertCode.HR_SPIKE_IMMOBILE, AlertCode.SITREP_CONTACT, AlertCode.FALL_IMMOBILE}
HAZARD_CODES = {AlertCode.HAZARD_ENV}
CLUSTER_RADIUS_M = 60.0
MIN_SOLDIERS = 2


@dataclass
class SquadEvent:
    kind: str            # POSSIBLE_CONTACT | HAZARD_AREA
    sector: str
    soldier_ids: list[int]
    t_s: float
    detail: str

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def _clusters(items: list[dict]) -> list[list[dict]]:
    """Single-linkage grouping of the latest alert per soldier."""
    latest: dict[int, dict] = {}
    for a in items:
        if a["soldier_id"] not in latest or a["t_s"] > latest[a["soldier_id"]]["t_s"]:
            latest[a["soldier_id"]] = a
    pts = list(latest.values())
    groups: list[list[dict]] = []
    seen: set[int] = set()
    for i, a in enumerate(pts):
        if i in seen:
            continue
        group, stack = [], [i]
        seen.add(i)
        while stack:
            j = stack.pop()
            group.append(pts[j])
            for k, b in enumerate(pts):
                if k not in seen and math.dist((pts[j]["x_m"], pts[j]["y_m"]), (b["x_m"], b["y_m"])) <= CLUSTER_RADIUS_M:
                    seen.add(k)
                    stack.append(k)
        groups.append(group)
    return groups


def correlate(alerts: list[dict], now_s: float, already: set[tuple]) -> list[SquadEvent]:
    """`alerts`: recent alert dicts (soldier_id, code, x_m, y_m, t_s).

    `already` holds (kind, sector) pairs reported inside the current window so
    the same event is not raised repeatedly.
    """
    window = [a for a in alerts if now_s - a["t_s"] <= config.CORRELATION_WINDOW_S]
    events: list[SquadEvent] = []
    for kind, codes, verb in (("POSSIBLE_CONTACT", STRESS_CODES, "broke silence with stress alerts"),
                              ("HAZARD_AREA", HAZARD_CODES, "report hazardous air")):
        relevant = [a for a in window if a["code"] in codes]
        for g in _clusters(relevant):
            ids = sorted({a["soldier_id"] for a in g})
            if len(ids) < MIN_SOLDIERS:
                continue
            cx = sum(a["x_m"] for a in g) / len(g)
            cy = sum(a["y_m"] for a in g) / len(g)
            sector = sector_of(cx, cy)
            if (kind, sector) in already:
                continue
            detail = (f"{len(ids)} soldiers within {int(CLUSTER_RADIUS_M)} m of each other {verb} "
                      f"within {int(config.CORRELATION_WINDOW_S)} s")
            if kind == "POSSIBLE_CONTACT" and any(a["code"] == AlertCode.SITREP_CONTACT for a in g):
                detail += "; corroborated by a manual contact report"
            events.append(SquadEvent(kind, sector, ids, now_s, detail))
    return events
