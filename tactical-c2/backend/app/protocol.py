"""Over-the-air packet format shared with the ESP32 firmware.

See docs/DATA_SPEC.md for the authoritative description. Every field is
little-endian. One packet is 18 bytes so a single short burst carries it.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, asdict
from enum import IntEnum

PROTOCOL_VERSION = 1
_FMT = "<BBHHBBhBhhBBB"  # 18 bytes
PACKET_SIZE = struct.calcsize(_FMT)


class PacketType(IntEnum):
    ALERT = 0x1    # node-side anomaly or manual report
    CHECKIN = 0x2  # low-rate randomized heartbeat (also mission-start baseline)


class AlertCode(IntEnum):
    NONE = 0x00
    HR_SPIKE_IMMOBILE = 0x01   # high HR with no movement -> injury suspected
    HR_LOW_IMMOBILE = 0x02     # low / dropping HR with no movement -> LOC suspected
    FALL_IMMOBILE = 0x03       # impact then no movement -> hit / fall suspected
    HEAT_STRAIN = 0x04         # sustained HR + skin temp rise -> exhaustion
    HAZARD_ENV = 0x05          # gas sensor above threshold
    SITREP_CONTACT = 0x10      # manual button: enemy / target sighted
    SITREP_SOS = 0x12          # manual button: request help


ALERT_LABELS = {
    AlertCode.NONE: "Check-in",
    AlertCode.HR_SPIKE_IMMOBILE: "HR spike, no movement",
    AlertCode.HR_LOW_IMMOBILE: "Low HR, no movement",
    AlertCode.FALL_IMMOBILE: "Fall, then no movement",
    AlertCode.HEAT_STRAIN: "Heat strain",
    AlertCode.HAZARD_ENV: "Hazardous environment",
    AlertCode.SITREP_CONTACT: "Contact report",
    AlertCode.SITREP_SOS: "SOS",
}


@dataclass
class Packet:
    ptype: int
    soldier_id: int
    seq: int
    t_s: int            # seconds since mission start (node clock)
    code: int
    hr_bpm: int
    skin_temp_c: float  # transmitted as centi-degrees
    activity: int       # 0..255, mean |accel - 1g| over last window, scaled
    x_m: float          # PDR estimate, transmitted as decimetres
    y_m: float
    gas: int            # 0..255 gas sensor level
    hops: int           # relay count, incremented by each relaying node
    rssi: int | None = None  # filled in by the gateway, not on air

    def to_dict(self) -> dict:
        d = asdict(self)
        d["code_label"] = ALERT_LABELS.get(AlertCode(self.code), f"0x{self.code:02x}")
        return d


def crc8(data: bytes) -> int:
    """CRC-8 (poly 0x07, init 0x00). Same routine must run on the ESP32."""
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def _clamp(v: float, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(round(v))))


def encode(p: Packet) -> bytes:
    head = ((PROTOCOL_VERSION & 0x0F) << 4) | (p.ptype & 0x0F)
    body = struct.pack(
        _FMT[:-1],
        head,
        p.soldier_id & 0xFF,
        p.seq & 0xFFFF,
        p.t_s & 0xFFFF,
        p.code & 0xFF,
        _clamp(p.hr_bpm, 0, 255),
        _clamp(p.skin_temp_c * 100, -32768, 32767),
        _clamp(p.activity, 0, 255),
        _clamp(p.x_m * 10, -32768, 32767),
        _clamp(p.y_m * 10, -32768, 32767),
        _clamp(p.gas, 0, 255),
        _clamp(p.hops, 0, 255),
    )
    return body + bytes([crc8(body)])


class PacketError(ValueError):
    pass


def decode(raw: bytes, rssi: int | None = None) -> Packet:
    if len(raw) != PACKET_SIZE:
        raise PacketError(f"bad length {len(raw)} (expected {PACKET_SIZE})")
    if crc8(raw[:-1]) != raw[-1]:
        raise PacketError("CRC mismatch")
    (head, sid, seq, t_s, code, hr, temp_c100, act, x_dm, y_dm, gas, hops, _crc) = struct.unpack(_FMT, raw)
    if head >> 4 != PROTOCOL_VERSION:
        raise PacketError(f"unsupported version {head >> 4}")
    return Packet(
        ptype=head & 0x0F, soldier_id=sid, seq=seq, t_s=t_s, code=code, hr_bpm=hr,
        skin_temp_c=temp_c100 / 100.0, activity=act, x_m=x_dm / 10.0, y_m=y_dm / 10.0,
        gas=gas, hops=hops, rssi=rssi,
    )


def parse_gateway_line(line: str) -> Packet | None:
    """Gateway serial format: `PKT:<36 hex chars>[,RSSI:<int>]`. Other lines are ignored."""
    line = line.strip()
    if not line.startswith("PKT:"):
        return None
    parts = line[4:].split(",")
    rssi = None
    for extra in parts[1:]:
        if extra.startswith("RSSI:"):
            rssi = int(extra[5:])
    return decode(bytes.fromhex(parts[0]), rssi=rssi)
