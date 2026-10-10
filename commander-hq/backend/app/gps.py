"""Phone-as-GPS ingest: validate fixes, keep the latest per device, log every fix to CSV.

Stopgap for the missing GPS module. A phone opens /gps (served by this backend),
reads the browser Geolocation API + compass, and POSTs one fix per second.
"""
from __future__ import annotations

import csv
import math
import re
import time
from collections import deque
from pathlib import Path
from threading import RLock
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

LOG_DIR = Path(__file__).resolve().parents[1] / "data"
LOG_NAME_RE = re.compile(r"^gps_\d{8}_\d{6}\.csv$")
STALE_AFTER_S = 10.0
OFFLINE_AFTER_S = 30.0
ORIENTATION_STALE_AFTER_S = 3.0
EXPIRE_AFTER_S = 3600.0
MAX_DEVICES = 256
# A timestamp without an explicit client age is useful only when the two clocks
# are plausibly aligned. AR heartbeats send ages measured on the phone instead.
MAX_CLOCK_SKEW_S = 300.0

# CSV header (English, unit in the name) -> key in the fix row
CSV_COLUMNS = {
    "time_local": "time_local",              # laptop receive time, YYYY-MM-DD HH:MM:SS.mmm
    "device_id": "device_id",
    "latitude_deg": "lat",                   # Latitude, WGS84 decimal degrees (+N / -S)
    "longitude_deg": "lon",                  # Longitude, WGS84 decimal degrees (+E / -W)
    "accuracy_m": "accuracy_m",              # Horizontal accuracy radius, metres (95 %)
    "heading_deg": "heading_deg",            # Heading / azimuth, degrees clockwise from north
    "heading_source": "heading_source",      # gps | compass | none
    "heading_gps_course_deg": "heading_gps_deg",
    "heading_compass_deg": "heading_compass_deg",
    "compass_accuracy_deg": "compass_accuracy_deg",
    "speed_mps": "speed_mps",
    "altitude_m": "alt_m",
    "altitude_accuracy_m": "alt_accuracy_m",
    "altitude_reference": "alt_reference",
    "camera_heading_deg": "camera_heading_deg",  # rear-camera view direction, not GNSS course
    "camera_pitch_deg": "camera_pitch_deg",
    "camera_roll_deg": "camera_roll_deg",
    "orientation_source": "orientation_source",
    "orientation_unix_ms": "orientation_unix_ms",
    "motion_state": "motion_state",
    "motion_unix_ms": "motion_unix_ms",
    "linear_accel_rms_mps2": "linear_accel_rms_mps2",
    "rotation_rate_rms_dps": "rotation_rate_rms_dps",
    "client_fix_age_ms": "fix_age_ms",
    "client_orientation_age_ms": "orientation_age_ms",
    "client_motion_age_ms": "motion_age_ms",
    "phone_fix_unix_ms": "fix_unix_ms",
    "laptop_recv_unix_ms": "recv_unix_ms",
    "device_name": "device_name",            # phone model / OS reported by the browser
    "client_ip": "client_ip",                # phone address on the hotspot
}


def _deg_or_none(v: float | None) -> float | None:
    if v is None:
        return None
    if not math.isfinite(v):
        raise ValueError("heading must be finite")
    return v % 360.0


class GpsFix(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    device_id: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_\-]+$")
    device_name: str | None = Field(default=None, max_length=64)  # e.g. "SM-S911N · Android 14"
    fix_unix_ms: int = Field(ge=0, le=253402300799999)  # phone clock, through year 9999
    lat: float = Field(ge=-90, le=90)       # WGS84 degrees
    lon: float = Field(ge=-180, le=180)
    accuracy_m: float = Field(ge=0, le=10_000_000)  # horizontal uncertainty radius
    heading_gps_deg: float | None = None    # course over ground; null when stationary
    heading_compass_deg: float | None = None  # magnetometer heading (device top edge)
    compass_accuracy_deg: float | None = Field(default=None, ge=0, le=360)
    speed_mps: float | None = Field(default=None, ge=0, le=10_000)
    alt_m: float | None = Field(default=None, ge=-12_000, le=100_000)
    alt_accuracy_m: float | None = Field(default=None, ge=0, le=10_000_000)
    alt_reference: Literal["wgs84", "msl", "unknown"] = "wgs84"
    camera_heading_deg: float | None = None
    camera_pitch_deg: float | None = Field(default=None, ge=-90, le=90)
    camera_roll_deg: float | None = Field(default=None, ge=-180, le=180)
    orientation_unix_ms: int | None = Field(default=None, ge=0, le=253402300799999)
    orientation_source: Literal["absolute", "webkit", "calibrated", "none"] = "none"
    # Same-clock ages avoid treating a queued fix as fresh because a phone's
    # wall clock differs from the server. Equal-timestamp heartbeats cannot reset
    # the stored GPS age even if their claimed age is zero.
    fix_age_ms: float | None = Field(default=None, ge=0, le=86_400_000)
    orientation_age_ms: float | None = Field(default=None, ge=0, le=86_400_000)
    motion_state: Literal["unknown", "still", "moving"] = "unknown"
    motion_unix_ms: int | None = Field(default=None, ge=0, le=253402300799999)
    motion_age_ms: float | None = Field(default=None, ge=0, le=86_400_000)
    linear_accel_rms_mps2: float | None = Field(default=None, ge=0, le=200)
    rotation_rate_rms_dps: float | None = Field(default=None, ge=0, le=2000)

    @field_validator("device_name")
    @classmethod
    def _clean_name(cls, v: str | None) -> str | None:
        v = "".join(ch for ch in (v or "") if ch.isprintable()).strip()
        return v or None

    @field_validator("heading_gps_deg", "heading_compass_deg", "camera_heading_deg")
    @classmethod
    def _norm_heading(cls, v: float | None) -> float | None:
        return _deg_or_none(v)

    def heading(self) -> tuple[float | None, str]:
        """Pick one heading: GNSS course while moving (>= 1 m/s), compass otherwise."""
        moving = self.speed_mps is not None and self.speed_mps >= 1.0
        if moving and self.heading_gps_deg is not None:
            return self.heading_gps_deg, "gps"
        if self.heading_compass_deg is not None:
            return self.heading_compass_deg, "compass"
        if self.heading_gps_deg is not None:
            return self.heading_gps_deg, "gps"
        return None, "none"


class GpsCapacityError(ValueError):
    """The bounded store is full of devices still active within the expiry window."""


class GpsStore:
    def __init__(self, log_dir: Path = LOG_DIR, track_len: int = 300,
                 max_devices: int = MAX_DEVICES) -> None:
        self.latest: dict[str, dict] = {}
        self.tracks: dict[str, deque] = {}
        self._ips: dict[str, dict[str, float]] = {}   # device_id -> {client_ip: last seen}
        self._timing: dict[str, dict] = {}
        self._lock = RLock()
        self.track_len = track_len
        self.max_devices = max_devices
        log_dir.mkdir(parents=True, exist_ok=True)
        self.csv_path = log_dir / f"gps_{time.strftime('%Y%m%d_%H%M%S')}.csv"
        self._f = self.csv_path.open("w", newline="", encoding="utf-8-sig")  # BOM: Excel opens UTF-8 correctly
        self._w = csv.writer(self._f)
        self._w.writerow(CSV_COLUMNS)
        self._f.flush()

    @staticmethod
    def _initial_age(timestamp_ms: int | None, client_age_ms: float | None,
                     now: float) -> tuple[float, bool]:
        if client_age_ms is not None:
            return client_age_ms / 1000, True
        if timestamp_ms is None:
            return 0.0, False
        delta = now - timestamp_ms / 1000
        if -MAX_CLOCK_SKEW_S <= delta <= MAX_CLOCK_SKEW_S:
            return max(0.0, delta), True
        return 0.0, False

    def _evict_expired(self, mono: float) -> None:
        for dev in list(self.latest):
            if mono - self._timing[dev]["recv_mono"] > EXPIRE_AFTER_S:
                del self.latest[dev]
                self.tracks.pop(dev, None)
                self._ips.pop(dev, None)
                self._timing.pop(dev, None)

    def _with_age(self, dev: str, row: dict, mono: float) -> dict:
        timing = self._timing[dev]
        age = max(0.0, mono - timing["recv_mono"])
        fix_age = timing["fix_initial_age_s"] + max(0.0, mono - timing["fix_mono"])
        orientation_age = None
        if timing["orientation_mono"] is not None:
            orientation_age = (timing["orientation_initial_age_s"]
                               + max(0.0, mono - timing["orientation_mono"]))
        motion_age = None
        if timing["motion_mono"] is not None:
            motion_age = timing["motion_initial_age_s"] + max(0.0, mono - timing["motion_mono"])
        return row | {
            "age_s": round(age, 1), "fix_age_s": round(fix_age, 1),
            "fix_time_reliable": timing["fix_time_reliable"],
            "orientation_age_s": None if orientation_age is None else round(orientation_age, 1),
            "motion_age_s": None if motion_age is None else round(motion_age, 1),
            "orientation_stale": (orientation_age is None or orientation_age > ORIENTATION_STALE_AFTER_S
                                  or row["orientation_source"] == "none" or row["camera_heading_deg"] is None),
            "stale": fix_age > STALE_AFTER_S, "offline": age > OFFLINE_AFTER_S,
        }

    def ingest(self, fix: GpsFix, client_ip: str | None = None) -> dict:
        with self._lock:
            return self._ingest(fix, client_ip)

    def _ingest(self, fix: GpsFix, client_ip: str | None = None) -> dict:
        now, mono = time.time(), time.monotonic()
        self._evict_expired(mono)
        previous = self.latest.get(fix.device_id)
        if previous is not None and fix.fix_unix_ms < previous["fix_unix_ms"]:
            return self._with_age(fix.device_id, previous, mono) | {
                "accepted": False, "reason": "older_fix"}
        if previous is None and len(self.latest) >= self.max_devices:
            raise GpsCapacityError(f"GPS device capacity reached ({self.max_devices}); retry when inactive devices expire")

        new_position = previous is None or fix.fix_unix_ms > previous["fix_unix_ms"]
        row = fix.model_dump() | {
            "recv_unix_ms": int(now * 1000),
            "client_ip": client_ip,
            "time_local": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)) + f".{int(now * 1000) % 1000:03d}"}
        if not new_position:
            # Orientation heartbeats reuse a geolocation timestamp. They must
            # never move its coordinates, alter altitude or renew GPS freshness.
            for field in ("lat", "lon", "accuracy_m", "heading_gps_deg", "speed_mps",
                          "alt_m", "alt_accuracy_m", "alt_reference"):
                row[field] = previous[field]

        orientation_fields = ("camera_heading_deg", "camera_pitch_deg", "camera_roll_deg",
                              "orientation_unix_ms", "orientation_source", "orientation_age_ms")
        # A GPS callback may carry an older orientation sample than the last
        # heartbeat. Keep that newer camera pose and its original age.
        new_orientation = fix.orientation_unix_ms is not None and (
            previous is None or previous["orientation_unix_ms"] is None
            or fix.orientation_unix_ms > previous["orientation_unix_ms"])
        if previous is not None and not new_orientation:
            for field in orientation_fields:
                row[field] = previous[field]

        motion_fields = ("motion_state", "motion_unix_ms", "motion_age_ms",
                         "linear_accel_rms_mps2", "rotation_rate_rms_dps")
        new_motion = fix.motion_unix_ms is not None and (
            previous is None or previous["motion_unix_ms"] is None
            or fix.motion_unix_ms > previous["motion_unix_ms"])
        if previous is not None and not new_motion:
            for field in motion_fields:
                row[field] = previous[field]

        heading, src = GpsFix(**row).heading()
        row.update(heading_deg=heading, heading_source=src)
        seen = self._ips.setdefault(fix.device_id, {})
        seen[client_ip or "?"] = mono
        for ip in [ip for ip, t in seen.items() if mono - t > 15]:
            del seen[ip]
        row["id_conflict"] = len(seen) > 1   # same ID sent from two phones within 15 s
        self.latest[fix.device_id] = row
        timing = self._timing.setdefault(fix.device_id, {
            "orientation_mono": None, "orientation_initial_age_s": 0.0,
            "motion_mono": None, "motion_initial_age_s": 0.0})
        timing["recv_mono"] = mono
        if new_position:
            initial_age, reliable = self._initial_age(fix.fix_unix_ms, fix.fix_age_ms, now)
            timing.update(fix_mono=mono, fix_initial_age_s=initial_age, fix_time_reliable=reliable)
        if new_orientation:
            initial_age, _ = self._initial_age(fix.orientation_unix_ms, fix.orientation_age_ms, now)
            timing.update(orientation_mono=mono, orientation_initial_age_s=initial_age)
        if new_motion:
            initial_age, _ = self._initial_age(fix.motion_unix_ms, fix.motion_age_ms, now)
            timing.update(motion_mono=mono, motion_initial_age_s=initial_age)
        tr = self.tracks.setdefault(fix.device_id, deque(maxlen=self.track_len))
        if new_position:
            tr.append((fix.lat, fix.lon))
        self._w.writerow(["" if row.get(k) is None else row[k] for k in CSV_COLUMNS.values()])
        self._f.flush()
        return self._with_age(fix.device_id, row, mono) | {"accepted": True}

    def snapshot(self) -> dict:
        with self._lock:
            return self._snapshot()

    def _snapshot(self) -> dict:
        mono = time.monotonic()
        self._evict_expired(mono)
        devices = []
        for dev, row in sorted(self.latest.items()):
            devices.append(self._with_age(dev, row, mono) | {"track": list(self.tracks.get(dev, []))})
        return {"devices": devices, "csv": self.csv_path.name,
                "stale_after_s": STALE_AFTER_S, "offline_after_s": OFFLINE_AFTER_S,
                "orientation_stale_after_s": ORIENTATION_STALE_AFTER_S}

    def log_files(self) -> list[dict]:
        """All CSV logs in the data folder, newest first."""
        out = []
        for p in sorted(self.csv_path.parent.glob("gps_*.csv"), reverse=True):
            if LOG_NAME_RE.match(p.name):
                with p.open(encoding="utf-8-sig") as f:
                    rows = max(0, sum(1 for _ in f) - 1)
                out.append({"name": p.name, "bytes": p.stat().st_size, "rows": rows,
                            "current": p == self.csv_path})
        return out

    def log_path(self, name: str) -> Path | None:
        if not LOG_NAME_RE.match(name):
            return None
        p = self.csv_path.parent / name
        return p if p.is_file() else None

    def close(self) -> None:
        self._f.close()
