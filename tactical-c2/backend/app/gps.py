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

from pydantic import BaseModel, Field, field_validator

LOG_DIR = Path(__file__).resolve().parents[1] / "data"
LOG_NAME_RE = re.compile(r"^gps_\d{8}_\d{6}\.csv$")

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
    "phone_fix_unix_ms": "fix_unix_ms",
    "laptop_recv_unix_ms": "recv_unix_ms",
}


def _deg_or_none(v: float | None) -> float | None:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v % 360.0


class GpsFix(BaseModel):
    device_id: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_\-]+$")
    fix_unix_ms: int                        # GeolocationPosition.timestamp (phone clock)
    lat: float = Field(ge=-90, le=90)       # WGS84 degrees
    lon: float = Field(ge=-180, le=180)
    accuracy_m: float = Field(ge=0)         # 95% confidence radius per W3C spec
    heading_gps_deg: float | None = None    # course over ground; null when stationary
    heading_compass_deg: float | None = None  # magnetometer heading (device top edge)
    compass_accuracy_deg: float | None = None  # iOS webkitCompassAccuracy only
    speed_mps: float | None = Field(default=None, ge=0)
    alt_m: float | None = None
    alt_accuracy_m: float | None = Field(default=None, ge=0)

    @field_validator("heading_gps_deg", "heading_compass_deg")
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


class GpsStore:
    def __init__(self, log_dir: Path = LOG_DIR, track_len: int = 300) -> None:
        self.latest: dict[str, dict] = {}
        self.tracks: dict[str, deque] = {}
        self.track_len = track_len
        log_dir.mkdir(parents=True, exist_ok=True)
        self.csv_path = log_dir / f"gps_{time.strftime('%Y%m%d_%H%M%S')}.csv"
        self._f = self.csv_path.open("w", newline="", encoding="utf-8")
        self._w = csv.writer(self._f)
        self._w.writerow(CSV_COLUMNS)
        self._f.flush()

    def ingest(self, fix: GpsFix) -> dict:
        heading, src = fix.heading()
        now = time.time()
        row = fix.model_dump() | {
            "recv_unix_ms": int(now * 1000), "heading_deg": heading, "heading_source": src,
            "time_local": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)) + f".{int(now * 1000) % 1000:03d}"}
        self._w.writerow(["" if row.get(k) is None else row[k] for k in CSV_COLUMNS.values()])
        self._f.flush()
        self.latest[fix.device_id] = row
        tr = self.tracks.setdefault(fix.device_id, deque(maxlen=self.track_len))
        tr.append((fix.lat, fix.lon))
        return row

    def snapshot(self) -> dict:
        now = int(time.time() * 1000)
        devices = []
        for dev, row in sorted(self.latest.items()):
            devices.append(row | {"age_s": round((now - row["recv_unix_ms"]) / 1000, 1),
                                  "track": list(self.tracks.get(dev, []))})
        return {"devices": devices, "csv": self.csv_path.name}

    def log_files(self) -> list[dict]:
        """All CSV logs in the data folder, newest first."""
        out = []
        for p in sorted(self.csv_path.parent.glob("gps_*.csv"), reverse=True):
            if LOG_NAME_RE.match(p.name):
                with p.open(encoding="utf-8") as f:
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
