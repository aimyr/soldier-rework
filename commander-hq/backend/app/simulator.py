"""Squad simulator for development and demos without hardware.

Each simulated soldier produces 1 Hz synthetic sensor samples. The same
node-side rules the firmware will run decide whether to transmit; transmitted
packets are encoded to the real 18-byte format and decoded again, so the
commander path is identical to the serial (hardware) path.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from . import config
from .node_rules import NodeRuleState, Sample, evaluate
from .protocol import AlertCode, Packet, PacketType, encode

CP = (150.0, 15.0)  # commander position (south edge, centre)
RELAY_RANGE_M = 90.0

SCENARIOS = {
    "injury": "One soldier: HR spike and stops moving (suspected injury)",
    "unconscious": "One soldier: impact, then immobile with falling HR",
    "heat": "One soldier: gradual skin-temp and HR rise while moving",
    "ambush": "Soldiers in one sector go prone with HR spike; one presses CONTACT",
    "hazard": "Gas cloud over one sector",
    "sos": "One soldier presses SOS",
    "silent": "One soldier's node goes dark (no more check-ins)",
}


@dataclass
class SimSoldier:
    sid: int
    x: float
    y: float
    hr_rest: float
    temp_rest: float
    offset: tuple[float, float]
    rules: NodeRuleState = field(init=False)
    seq: int = 0
    drift_x: float = 0.0
    drift_y: float = 0.0
    hr: float = 0.0
    temp: float = 0.0
    next_checkin: float = 0.0
    effect: str | None = None
    effect_t0: float = 0.0
    dark: bool = False
    pending_button: AlertCode = AlertCode.NONE

    def __post_init__(self) -> None:
        self.rules = NodeRuleState(self.hr_rest, self.temp_rest)
        self.hr, self.temp = self.hr_rest, self.temp_rest


class SquadSimulator:
    def __init__(self, n: int = config.SIM_SQUAD_SIZE, seed: int = config.SIM_SEED):
        self.n, self.seed = n, seed
        self.reset()

    def reset(self) -> None:
        self.rng = random.Random(self.seed)
        self.t = 0.0
        self.samples = 0       # sensor samples generated (what continuous streaming would send)
        self.transmitted = 0   # packets actually put on air (incl. relays)
        self.gas_sector: tuple[float, float] | None = None
        cols = 4
        self.soldiers = []
        for i in range(self.n):
            off = ((i % cols) * 20.0 - 30.0, -(i // cols) * 18.0)
            self.soldiers.append(SimSoldier(
                sid=i + 1, x=CP[0] + off[0], y=40 + off[1],
                hr_rest=self.rng.uniform(62, 78), temp_rest=self.rng.uniform(33.0, 34.2), offset=off,
                next_checkin=self.rng.uniform(0.5, 3.0),
            ))
        # squad route: advance north-east through the AO, then hold
        self.route = [(150, 40), (150, 120), (210, 170), (230, 250), (230, 270)]
        self.route_i = 0
        self.lead = list(self.route[0])

    # ----------------------------------------------------------------- scenarios
    def trigger(self, name: str, soldier_id: int | None = None) -> dict:
        if name == "reset":
            self.reset()
            return {"ok": True, "scenario": "reset"}
        if name not in SCENARIOS:
            return {"ok": False, "error": f"unknown scenario {name}", "available": list(SCENARIOS)}
        alive = [s for s in self.soldiers if s.effect is None and not s.dark]
        if not alive:
            return {"ok": False, "error": "no unaffected soldier left; reset first"}
        if name == "hazard":
            target = self.rng.choice(alive)
            self.gas_sector = (target.x, target.y)
            return {"ok": True, "scenario": name, "center": [round(target.x), round(target.y)]}
        if name == "ambush":
            anchor = self.rng.choice(alive) if soldier_id is None else self._get(soldier_id)
            group = sorted(alive, key=lambda s: math.dist((s.x, s.y), (anchor.x, anchor.y)))[:3]
            for s in group:
                s.effect, s.effect_t0 = "ambush", self.t
            group[0].pending_button = AlertCode.SITREP_CONTACT
            return {"ok": True, "scenario": name, "soldiers": [s.sid for s in group]}
        s = self._get(soldier_id) if soldier_id else self.rng.choice(alive)
        if name == "sos":
            s.pending_button = AlertCode.SITREP_SOS
        elif name == "silent":
            s.dark = True
        else:
            s.effect, s.effect_t0 = name, self.t
        return {"ok": True, "scenario": name, "soldiers": [s.sid]}

    def _get(self, sid: int) -> SimSoldier:
        return next(s for s in self.soldiers if s.sid == sid)

    # --------------------------------------------------------------------- tick
    def step(self, dt: float = 1.0) -> list[tuple[bytes, int]]:
        """Advance dt seconds. Returns the (packet_bytes, rssi) the gateway receives."""
        self.t += dt
        self._advance_lead(dt)
        out: list[tuple[bytes, int]] = []
        for s in self.soldiers:
            sample, moving = self._simulate(s, dt)
            self.samples += 1
            if s.dark:
                continue
            code = evaluate(s.rules, sample)
            ptype = None
            if code is not None:
                ptype = PacketType.ALERT
            elif self.t >= s.next_checkin:
                ptype, code = PacketType.CHECKIN, AlertCode.NONE
                s.next_checkin = self.t + config.CHECKIN_PERIOD_S + self.rng.uniform(
                    -config.CHECKIN_JITTER_S, config.CHECKIN_JITTER_S)
            if ptype is None:
                continue  # radio silence
            s.seq += 1
            d = math.dist((s.x, s.y), CP)
            hops = max(0, math.ceil(d / RELAY_RANGE_M) - 1)
            self.transmitted += 1 + hops
            pkt = Packet(ptype=ptype, soldier_id=s.sid, seq=s.seq, t_s=int(self.t), code=int(code),
                         hr_bpm=round(sample.hr_bpm), skin_temp_c=sample.skin_temp_c,
                         activity=round(sample.activity), x_m=s.x + s.drift_x, y_m=s.y + s.drift_y,
                         gas=round(sample.gas), hops=hops)
            hop_d = d / (hops + 1)
            rssi = round(-40 - 22 * math.log10(max(1.0, hop_d)) + self.rng.uniform(-4, 4))
            out.append((encode(pkt), rssi))
        return out

    def _advance_lead(self, dt: float) -> None:
        if self.route_i >= len(self.route) - 1 or any(s.effect == "ambush" for s in self.soldiers):
            return
        tx, ty = self.route[self.route_i + 1]
        dx, dy = tx - self.lead[0], ty - self.lead[1]
        dist = math.hypot(dx, dy)
        step = 1.1 * dt
        if dist <= step:
            self.lead = [tx, ty]
            self.route_i += 1
        else:
            self.lead[0] += dx / dist * step
            self.lead[1] += dy / dist * step

    def _simulate(self, s: SimSoldier, dt: float) -> tuple[Sample, bool]:
        r = self.rng
        el = self.t - s.effect_t0
        moving = self.route_i < len(self.route) - 1 and not any(x.effect == "ambush" for x in self.soldiers)
        target_hr = s.hr_rest + (28 if moving else 6)
        target_temp = s.temp_rest + (0.4 if moving else 0.0)
        activity = r.uniform(35, 70) if moving else r.uniform(10, 25)
        accel = 1.0 + activity / 255 + r.uniform(0, 0.15)
        stop = False

        if s.effect == "injury":
            stop, target_hr = True, s.hr_rest + 62
        elif s.effect == "unconscious":
            stop = True
            if el < 1.5:
                accel = 3.6
            target_hr = max(38.0, s.hr_rest - 1.2 * el)
        elif s.effect == "heat":
            target_temp = s.temp_rest + min(2.6, 0.08 * el)
            target_hr = s.hr_rest + 28 + min(32, 0.8 * el)
            s.temp += (target_temp - s.temp) * 0.08 * dt  # faster skin-temp response under load
        elif s.effect == "ambush":
            stop, target_hr = True, s.hr_rest + 58

        if stop:
            activity = r.uniform(0, 4)
            accel = max(accel, 1.0) if s.effect == "unconscious" and el < 1.5 else 1.0 + r.uniform(0, 0.02)
        else:
            # follow the lead with the formation offset; PDR drift accumulates while walking
            tx, ty = self.lead[0] + s.offset[0], self.lead[1] + s.offset[1]
            dx, dy = tx - s.x, ty - s.y
            dist = math.hypot(dx, dy)
            if dist > 0.05:
                k = min(1.0, 1.4 * dt / dist)
                s.x += dx * k
                s.y += dy * k
                s.drift_x += r.gauss(0, 0.12)
                s.drift_y += r.gauss(0, 0.12)

        # first-order response toward targets + sensor noise
        s.hr += (target_hr - s.hr) * min(1.0, 0.25 * dt) + r.gauss(0, 1.2)
        s.temp += (target_temp - s.temp) * min(1.0, 0.03 * dt) + r.gauss(0, 0.02)
        gas = r.uniform(5, 20)
        if self.gas_sector and math.dist((s.x, s.y), self.gas_sector) < 45:
            gas = r.uniform(150, 220)

        button, s.pending_button = s.pending_button, AlertCode.NONE
        return Sample(t_s=self.t, hr_bpm=s.hr, skin_temp_c=s.temp, accel_g=accel,
                      activity=activity, gas=gas, button=button), not stop

    def emission_stats(self) -> dict:
        silence = 1 - self.transmitted / self.samples if self.samples else 1.0
        return {"sensor_samples": self.samples, "packets_on_air": self.transmitted,
                "radio_silence_pct": round(100 * silence, 2)}
