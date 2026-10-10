import csv

from fastapi.testclient import TestClient

from app.gps import GpsFix, GpsStore
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
    with s.csv_path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert list(rows[0])[:6] == ["time_local", "device_id", "latitude_deg", "longitude_deg",
                                 "accuracy_m", "heading_deg"]
    assert rows[0]["latitude_deg"] == "37.5665" and rows[0]["heading_deg"] == "12.5"
    assert rows[0]["heading_gps_course_deg"] == "" and rows[0]["heading_source"] == "compass"
    assert s.log_path("../secret.csv") is None and s.log_path(s.csv_path.name) == s.csv_path


def test_api_roundtrip():
    with TestClient(app) as c:
        assert c.get("/gps").status_code == 200
        r = c.post("/api/gps", json=FIX)
        assert r.status_code == 200 and r.json()["heading_deg"] == 12.5
        assert c.post("/api/gps", json=FIX | {"lat": 123}).status_code == 422
        assert c.post("/api/gps", json=FIX | {"device_id": "x/../y"}).status_code == 422
        dev = c.get("/api/gps").json()["devices"][0]
        assert dev["device_id"] == "P1" and dev["track"] == [[37.5665, 126.978]]
        assert c.get("/api/state").json()["gps"]["devices"][0]["accuracy_m"] == 4.8
        assert c.get("/gps/pc").status_code == 200
        csv_r = c.get("/api/gps/csv")
        assert csv_r.status_code == 200 and "attachment" in csv_r.headers["content-disposition"]
        assert csv_r.text.splitlines()[0].startswith("time_local,device_id,latitude_deg,longitude_deg,accuracy_m,heading_deg")
        name = c.get("/api/gps/logs").json()["files"][0]["name"]
        assert c.get("/api/gps/csv", params={"name": name}).status_code == 200
        assert c.get("/api/gps/csv", params={"name": "../app/main.py"}).status_code == 404
