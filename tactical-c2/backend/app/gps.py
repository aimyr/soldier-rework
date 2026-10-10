"""Phone-as-GPS ingest: validate fixes, keep the latest per device, log every fix to CSV.

Stopgap for the missing GPS module. A phone opens /gps (served by this backend),
reads the browser Geolocation API + compass, and POSTs one fix per second.
"""
from __future__ import annotations

import csv
import math
import time
from collections import deque
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

LOG_DIR = Path(__file__).resolve().parents[1] / "data"
CSV_FIELDS = ["recv_unix_ms", "device_id", "fix_unix_ms", "lat", "lon", "accuracy_m",
              "heading_deg", "heading_source", "heading_gps_deg", "heading_compass_deg",
              "compass_accuracy_deg", "speed_mps", "alt_m", "alt_accuracy_m"]


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
        self._w = csv.DictWriter(self._f, fieldnames=CSV_FIELDS)
        self._w.writeheader()
        self._f.flush()

    def ingest(self, fix: GpsFix) -> dict:
        heading, src = fix.heading()
        row = fix.model_dump() | {"recv_unix_ms": int(time.time() * 1000),
                                  "heading_deg": heading, "heading_source": src}
        self._w.writerow({k: row.get(k) for k in CSV_FIELDS})
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

    def close(self) -> None:
        self._f.close()
