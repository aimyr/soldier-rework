"""Natural-language briefing.

Design rule: the analysis engine decides WHAT is true; the LLM only phrases it.
The LLM receives a compact facts JSON and must not add anything. If the local
LLM is unreachable, slow, or its output mentions a soldier that is not in the
facts, we fall back to a deterministic template, so the COP never shows an
unverified claim.
"""
from __future__ import annotations

import json
import re
import time

import httpx

from . import config

SYSTEM_PROMPT = (
    "You are the briefing assistant of an offline squad command terminal. "
    "Write a tactical briefing for the squad leader in 2 to 4 short sentences. "
    "Use ONLY the facts in the JSON. Do not invent soldiers, locations, causes, or numbers. "
    "Keep words like 'suspected' and 'possible' exactly as cautious as the facts. "
    "Lead with the most critical item. Refer to soldiers by callsign and sector. "
    "If nothing is flagged, say all soldiers are nominal. Plain text, no lists."
)


def template_briefing(f: dict) -> str:
    parts = [f"{f['mission_time']}."]
    for e in f["squad_events"]:
        if e["kind"] == "POSSIBLE_CONTACT":
            parts.append(f"Possible contact in sector {e['sector']}: {', '.join(e['callsigns'])} "
                         f"broke silence together.")
        elif e["kind"] == "HAZARD_AREA":
            parts.append(f"Possible hazard area in sector {e['sector']} ({', '.join(e['callsigns'])}).")
    order = {"CRITICAL": 0, "WARN": 1, "UNKNOWN": 2, "WATCH": 3}
    # group soldiers sharing the same condition and sector to keep the briefing short
    groups: dict[tuple, list[dict]] = {}
    for s in sorted(f["flagged_soldiers"], key=lambda s: (order.get(s["severity"], 9), s["callsign"])):
        key = (s["severity"], s["active_label"] if s["severity"] in ("CRITICAL", "WARN") else "", s["sector"])
        groups.setdefault(key, []).append(s)
    for (sev, _label, sector), members in groups.items():
        who = ", ".join(m["callsign"] for m in members)
        s = members[0]
        if sev == "UNKNOWN":
            parts.append(f"{who}: no check-in received, status unknown.")
        elif sev == "WATCH":
            parts.append(f"{who} in {sector}: elevated physiological strain.")
        else:
            hr = "/".join(str(m["hr_bpm"]) for m in members)
            parts.append(f"{sev.title()}: {who} in {sector}, {s['interpretation']} (HR {hr}).")
    if len(parts) == 1:
        parts.append(f"All {f['squad_size']} soldiers nominal.")
    return " ".join(parts)


_CALLSIGN = re.compile(r"\bS(\d{1,3})\b")


def _grounded(text: str, f: dict) -> bool:
    allowed = {s["callsign"] for s in f["flagged_soldiers"]}
    for e in f["squad_events"]:
        allowed.update(e["callsigns"])
    mentioned = {f"S{m}" for m in _CALLSIGN.findall(text)}
    return mentioned <= allowed


class Briefer:
    def __init__(self) -> None:
        self.llm_ok: bool | None = None
        self.last_error: str | None = None

    async def brief(self, facts: dict) -> dict:
        t0 = time.perf_counter()
        text, source = None, "template"
        if config.LLM_ENABLED:
            try:
                text = await self._llm(facts)
                self.llm_ok, self.last_error = True, None
                if not _grounded(text, facts):
                    self.last_error = "LLM output referenced a soldier not in the facts; discarded"
                    text = None
                else:
                    source = "llm"
            except httpx.ConnectError:
                self.llm_ok, self.last_error = False, "Local sLLM not reachable; showing rule-based briefing"
            except httpx.TimeoutException:
                self.llm_ok, self.last_error = False, "Local sLLM timed out; showing rule-based briefing"
            except Exception as exc:  # bad response shape, HTTP error
                self.llm_ok, self.last_error = False, f"sLLM error ({type(exc).__name__}); rule-based briefing"
        if text is None:
            text = template_briefing(facts)
        return {
            "text": text,
            "source": source,
            "model": config.LLM_MODEL if source == "llm" else None,
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "facts": facts,
            "note": self.last_error,
        }

    async def _llm(self, facts: dict) -> str:
        payload = {
            "model": config.LLM_MODEL,
            "temperature": 0.1,
            "max_tokens": 160,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": "FACTS:\n" + json.dumps(facts, ensure_ascii=False)},
            ],
        }
        async with httpx.AsyncClient(timeout=config.LLM_TIMEOUT_S) as client:
            r = await client.post(f"{config.LLM_BASE_URL}/chat/completions", json=payload)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"].strip()
