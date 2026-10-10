import csv

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import gps, main
from app.gps import GpsCapacityError, GpsFix, GpsStore
from app.main import app

FIX = {"device_id": "P1", "fix_unix_ms": 1760000000000, "lat": 37.5665, "lon": 126.978,
       "accuracy_m": 4.8, "heading_gps_deg": None, "heading_compass_deg": 372.5, "speed_mps": 0.2}


def test_heading_choice():
    assert GpsFix(**FIX).heading() == (12.5, "compass")             # normalised, stationary -> compass
    moving = GpsFix(**FIX | {"heading_gps_deg": 90.0, "speed_mps": 1.5})
    assert moving.heading() == (90.0, "gps")
    assert GpsFix(**FIX | {"heading_compass_deg": None}).heading() == (None, "none")


def test_store_writes_csv(tmp_path):
    s = GpsStore(log_dir=tmp_path)
    s.ingest(GpsFix(**FIX))
    s.close()
    with s.csv_path.open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    assert list(rows[0])[:6] == ["time_local", "device_id", "latitude_deg", "longitude_deg",
                                 "accuracy_m", "heading_deg"]
    assert rows[0]["latitude_deg"] == "37.5665" and rows[0]["heading_deg"] == "12.5"
    assert rows[0]["heading_gps_course_deg"] == "" and rows[0]["heading_source"] == "compass"
    assert s.log_path("../secret.csv") is None and s.log_path(s.csv_path.name) == s.csv_path


def test_api_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "GpsStore", lambda: GpsStore(log_dir=tmp_path))
    with TestClient(app) as c:
        assert c.get("/gps").status_code == 200
        r = c.post("/api/gps", json=FIX)
        assert r.status_code == 200 and r.json()["heading_deg"] == 12.5
        assert not r.json()["id_conflict"]
        assert c.post("/api/gps", json=FIX | {"lat": 123}).status_code == 422
        assert c.post("/api/gps", json=FIX | {"device_id": "x/../y"}).status_code == 422
        dev = c.get("/api/gps").json()["devices"][0]
        assert dev["device_id"] == "P1" and dev["track"] == [[37.5665, 126.978]]
        assert dev["motion_state"] == "unknown" and dev["motion_age_s"] is None
        assert c.get("/api/state").json()["gps"]["devices"][0]["accuracy_m"] == 4.8
        assert c.get("/gps/pc").status_code == 200
        csv_r = c.get("/api/gps/csv")
        assert csv_r.status_code == 200 and "attachment" in csv_r.headers["content-disposition"]
        assert csv_r.text.lstrip("\ufeff").splitlines()[0].startswith("time_local,device_id,latitude_deg,longitude_deg,accuracy_m,heading_deg")
        name = c.get("/api/gps/logs").json()["files"][0]["name"]
        assert c.get("/api/gps/csv", params={"name": name}).status_code == 200
        assert c.get("/api/gps/csv", params={"name": "../app/main.py"}).status_code == 404


def test_device_identity_and_conflict(tmp_path):
    s = GpsStore(log_dir=tmp_path)
    a = s.ingest(GpsFix(**FIX | {"device_id": "SM-S911N-3fa2", "device_name": "SM-S911N · Android 14\n"}), "172.20.10.3")
    b = s.ingest(GpsFix(**FIX | {"device_id": "iPhone-7c1e", "device_name": "iPhone · iOS 18"}), "172.20.10.4")
    assert a["device_name"] == "SM-S911N · Android 14" and a["client_ip"] == "172.20.10.3"
    assert not a["id_conflict"] and not b["id_conflict"]
    assert [d["device_id"] for d in s.snapshot()["devices"]] == ["SM-S911N-3fa2", "iPhone-7c1e"]
    c = s.ingest(GpsFix(**FIX | {"device_id": "iPhone-7c1e"}), "172.20.10.5")
    assert c["id_conflict"]
    s.close()
    with s.csv_path.open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["device_name"] == "SM-S911N · Android 14" and rows[1]["client_ip"] == "172.20.10.4"


@pytest.mark.parametrize("field", ["lat", "lon", "accuracy_m", "heading_gps_deg",
                                 "heading_compass_deg", "compass_accuracy_deg", "speed_mps",
                                 "alt_m", "alt_accuracy_m", "camera_heading_deg",
                                 "camera_pitch_deg", "camera_roll_deg", "fix_age_ms",
                                 "orientation_age_ms", "motion_age_ms", "linear_accel_rms_mps2",
                                 "rotation_rate_rms_dps"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_measurements_rejected(field, value):
    with pytest.raises(ValidationError):
        GpsFix(**FIX | {field: value})


@pytest.mark.parametrize("invalid", [{"camera_pitch_deg": 91}, {"camera_roll_deg": -181},
                                    {"orientation_source": "gps"}, {"alt_reference": "sea"},
                                    {"alt_accuracy_m": -1}, {"compass_accuracy_deg": -1},
                                    {"fix_age_ms": -1}, {"orientation_unix_ms": -1},
                                    {"motion_state": "walking"}, {"motion_unix_ms": -1},
                                    {"motion_age_ms": 86_400_001}, {"linear_accel_rms_mps2": -1},
                                    {"linear_accel_rms_mps2": 201}, {"rotation_rate_rms_dps": 2001}])
def test_invalid_telemetry_rejected(invalid):
    with pytest.raises(ValidationError):
        GpsFix(**FIX | invalid)


def test_camera_orientation_separate_from_course_and_logged(tmp_path):
    f = GpsFix(**FIX | {"speed_mps": 2, "heading_gps_deg": 90, "camera_heading_deg": 405,
                       "camera_pitch_deg": 15, "camera_roll_deg": -8,
                       "orientation_source": "absolute", "orientation_unix_ms": FIX["fix_unix_ms"],
                       "orientation_age_ms": 250, "alt_m": 60, "alt_reference": "msl"})
    assert f.heading() == (90, "gps") and f.camera_heading_deg == 45
    s = GpsStore(log_dir=tmp_path)
    try:
        row = s.ingest(f)
        assert row["heading_deg"] == 90 and row["camera_heading_deg"] == 45
        assert row["orientation_age_s"] == 0.2
    finally:
        s.close()
    with s.csv_path.open(encoding="utf-8-sig") as file:
        logged = list(csv.DictReader(file))[0]
    assert logged["camera_heading_deg"] == "45.0"
    assert logged["camera_pitch_deg"] == "15.0" and logged["altitude_reference"] == "msl"


def _clock(monkeypatch):
    clock = {"wall": FIX["fix_unix_ms"] / 1000, "mono": 100.0}
    monkeypatch.setattr(gps.time, "time", lambda: clock["wall"])
    monkeypatch.setattr(gps.time, "monotonic", lambda: clock["mono"])
    return clock


def test_heartbeat_cannot_move_fix_or_refresh_its_age(tmp_path, monkeypatch):
    clock = _clock(monkeypatch)
    s = GpsStore(log_dir=tmp_path)
    try:
        s.ingest(GpsFix(**FIX | {"fix_age_ms": 2000, "camera_heading_deg": 20,
                                "orientation_source": "absolute", "orientation_age_ms": 0,
                                "orientation_unix_ms": FIX["fix_unix_ms"]}))
        clock["mono"] += 5
        clock["wall"] += 5
        heartbeat = s.ingest(GpsFix(**FIX | {
            "lat": 38, "alt_m": 900, "fix_age_ms": 0, "camera_heading_deg": 50,
            "orientation_source": "absolute", "orientation_age_ms": 0,
            "orientation_unix_ms": FIX["fix_unix_ms"] + 5000}))
        assert heartbeat["lat"] == FIX["lat"] and heartbeat["alt_m"] is None
        assert heartbeat["fix_age_s"] == 7 and heartbeat["orientation_age_s"] == 0
        assert len(s.snapshot()["devices"][0]["track"]) == 1
        clock["mono"] += 4
        clock["wall"] += 4
        snap = s.snapshot()["devices"][0]
        assert snap["age_s"] == 4 and snap["fix_age_s"] == 11
        assert snap["stale"] and snap["orientation_stale"] and not snap["offline"]
        reordered = s.ingest(GpsFix(**FIX | {"fix_unix_ms": FIX["fix_unix_ms"] - 1,
                                           "camera_heading_deg": 150}))
        assert not reordered["accepted"] and reordered["reason"] == "older_fix"
        assert reordered["camera_heading_deg"] == 50 and reordered["age_s"] == 4
        # Server wall-clock corrections do not rejuvenate or age stored fixes.
        clock["wall"] += 1_000_000
        assert s.snapshot()["devices"][0]["fix_age_s"] == 11
        clock["mono"] += 27
        assert s.snapshot()["devices"][0]["offline"]
    finally:
        s.close()


def test_clock_skew_and_explicit_client_age(tmp_path, monkeypatch):
    clock = _clock(monkeypatch)
    clock["wall"] += 100_000
    s = GpsStore(log_dir=tmp_path)
    try:
        untrusted = s.ingest(GpsFix(**FIX))
        assert untrusted["fix_age_s"] == 0 and not untrusted["fix_time_reliable"]
        buffered = s.ingest(GpsFix(**FIX | {"device_id": "P2", "fix_age_ms": 60_000}))
        assert buffered["fix_time_reliable"] and buffered["fix_age_s"] == 60 and buffered["stale"]
    finally:
        s.close()


def test_older_orientation_cannot_replace_latest_camera_pose(tmp_path, monkeypatch):
    clock = _clock(monkeypatch)
    s = GpsStore(log_dir=tmp_path)
    try:
        s.ingest(GpsFix(**FIX | {"camera_heading_deg": 80, "orientation_source": "webkit",
                                "orientation_unix_ms": FIX["fix_unix_ms"] + 1000,
                                "orientation_age_ms": 0}))
        clock["mono"] += 2
        newer_fix = s.ingest(GpsFix(**FIX | {"fix_unix_ms": FIX["fix_unix_ms"] + 2000,
                                            "camera_heading_deg": 40,
                                            "orientation_unix_ms": FIX["fix_unix_ms"]}))
        assert newer_fix["camera_heading_deg"] == 80
        assert newer_fix["orientation_source"] == "webkit" and newer_fix["orientation_age_s"] == 2
    finally:
        s.close()


def test_capacity_bound_and_expired_eviction(tmp_path, monkeypatch):
    clock = _clock(monkeypatch)
    s = GpsStore(log_dir=tmp_path, max_devices=2)
    try:
        s.ingest(GpsFix(**FIX))
        s.ingest(GpsFix(**FIX | {"device_id": "P2"}))
        with pytest.raises(GpsCapacityError):
            s.ingest(GpsFix(**FIX | {"device_id": "P3"}))
        assert len(s.snapshot()["devices"]) == 2
        clock["mono"] += gps.EXPIRE_AFTER_S + 1
        s.ingest(GpsFix(**FIX | {"device_id": "P3"}))
        assert list(s.latest) == ["P3"] and list(s.tracks) == ["P3"]
        assert list(s._ips) == ["P3"] and list(s._timing) == ["P3"]
    finally:
        s.close()


def test_api_reordered_fix_and_capacity(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "GpsStore", lambda: GpsStore(log_dir=tmp_path, max_devices=1))
    with TestClient(app) as c:
        assert c.post("/api/gps", json=FIX).json()["accepted"]
        result = c.post("/api/gps", json=FIX | {"fix_unix_ms": FIX["fix_unix_ms"] - 1})
        assert result.status_code == 200 and result.json()["reason"] == "older_fix"
        assert c.post("/api/gps", json=FIX | {"device_id": "P2"}).status_code == 409


def test_motion_age_is_independent_and_equal_fix_can_update_motion(tmp_path, monkeypatch):
    clock = _clock(monkeypatch)
    s = GpsStore(log_dir=tmp_path)
    try:
        first = s.ingest(GpsFix(**FIX | {"fix_age_ms": 2000, "motion_state": "still",
            "motion_unix_ms": FIX["fix_unix_ms"], "motion_age_ms": 500,
            "linear_accel_rms_mps2": .03, "rotation_rate_rms_dps": .4}))
        assert first["motion_age_s"] == .5
        clock["mono"] += 4
        clock["wall"] += 4
        # Motion heartbeat changes neither the position nor the original GPS age.
        updated = s.ingest(GpsFix(**FIX | {"lat": 38, "fix_age_ms": 0, "motion_state": "moving",
            "motion_unix_ms": FIX["fix_unix_ms"] + 4000, "motion_age_ms": 250,
            "linear_accel_rms_mps2": 1.2, "rotation_rate_rms_dps": 15}))
        assert updated["motion_state"] == "moving" and updated["motion_age_s"] == .2
        assert updated["lat"] == FIX["lat"] and updated["fix_age_s"] == 6
        clock["mono"] += 5
        clock["wall"] += 100_000  # elapsed ages survive a server wall-clock correction
        snapshot = s.snapshot()["devices"][0]
        assert snapshot["fix_age_s"] == 11 and snapshot["stale"]
        assert snapshot["motion_age_s"] == 5.2 and snapshot["motion_state"] == "moving"
        assert len(snapshot["track"]) == 1
    finally:
        s.close()
    with s.csv_path.open(encoding="utf-8-sig") as file:
        logged = list(csv.DictReader(file))
    assert logged[-1]["motion_state"] == "moving"
    assert logged[-1]["linear_accel_rms_mps2"] == "1.2"
    assert logged[-1]["rotation_rate_rms_dps"] == "15.0"
    assert logged[-1]["client_motion_age_ms"] == "250.0"


def test_motion_timestamp_ties_and_older_motion_preserve_state_age(tmp_path, monkeypatch):
    clock = _clock(monkeypatch)
    s = GpsStore(log_dir=tmp_path)
    try:
        s.ingest(GpsFix(**FIX | {"motion_state": "still", "motion_unix_ms": FIX["fix_unix_ms"] + 1000,
            "motion_age_ms": 0, "linear_accel_rms_mps2": .04, "rotation_rate_rms_dps": .5}))
        clock["mono"] += 2
        tied = s.ingest(GpsFix(**FIX | {"motion_state": "moving",
            "motion_unix_ms": FIX["fix_unix_ms"] + 1000, "motion_age_ms": 0,
            "linear_accel_rms_mps2": 10, "rotation_rate_rms_dps": 100}))
        assert tied["motion_state"] == "still" and tied["motion_age_s"] == 2
        clock["mono"] += 3
        newer_gps = s.ingest(GpsFix(**FIX | {"fix_unix_ms": FIX["fix_unix_ms"] + 5000,
            "fix_age_ms": 0, "motion_state": "moving", "motion_unix_ms": FIX["fix_unix_ms"],
            "motion_age_ms": 0, "linear_accel_rms_mps2": 10, "rotation_rate_rms_dps": 100}))
        assert newer_gps["fix_age_s"] == 0 and newer_gps["motion_age_s"] == 5
        assert newer_gps["motion_state"] == "still" and newer_gps["linear_accel_rms_mps2"] == .04
        clock["mono"] += 1
        missing = s.ingest(GpsFix(**FIX | {"fix_unix_ms": FIX["fix_unix_ms"] + 6000, "fix_age_ms": 0}))
        assert missing["motion_state"] == "still" and missing["motion_age_s"] == 6
        invalidated = s.ingest(GpsFix(**FIX | {"fix_unix_ms": FIX["fix_unix_ms"] + 6000,
            "motion_state": "unknown", "motion_unix_ms": FIX["fix_unix_ms"] + 6000, "motion_age_ms": 0}))
        assert invalidated["motion_state"] == "unknown" and invalidated["motion_age_s"] == 0
        assert invalidated["linear_accel_rms_mps2"] is None and invalidated["rotation_rate_rms_dps"] is None
    finally:
        s.close()
