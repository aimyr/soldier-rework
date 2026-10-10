"""Protocol v2 (MPU6050); matches src/protocol/packets.h and uuids.h."""
import struct

SERVICE = "76b91001-7c4d-4f21-9b63-136a2d8e507c"
UUIDS = {name: f"76b9100{index}-7c4d-4f21-9b63-136a2d8e507c"
         for index, name in enumerate(("imu", "vitals", "gps", "status"), 2)}
FORMATS = {"imu": "<I6h", "vitals": "<IhHH", "gps": "<IiiiHBB", "status": "<IHHII"}


def decode(kind, payload):
    fmt = FORMATS[kind]
    if len(payload) != struct.calcsize(fmt):
        raise ValueError(f"{kind}: expected {struct.calcsize(fmt)} bytes, got {len(payload)}")
    t, *v = struct.unpack(fmt, payload)
    out = {"type": kind, "t_ms": t}
    if kind == "imu":
        out.update(acc_g=[round(x / 8192.0, 6) for x in v[:3]],
                   gyro_dps=[round(x / 65.5, 4) for x in v[3:]])
    elif kind == "vitals":
        out.update(temp_c=None if v[0] == -32768 else v[0] / 100,
                   bpm=v[1] or None, pulse_raw=v[2])
    elif kind == "gps":
        out.update(fix=bool(v[4]), lat=v[0] / 1e7 if v[4] else None,
                   lon=v[1] / 1e7 if v[4] else None,
                   alt_m=v[2] / 100 if v[4] else None,
                   speed_mps=v[3] / 100 if v[4] else None, sats=v[5])
    else:
        if v[0] != 2:
            raise ValueError(f"Unsupported protocol version {v[0]}")
        out.update(version=v[0], flags=v[1], tx_dropped=v[2], sample_gaps=v[3])
        for bit, name in enumerate(("imu_online", "analog_ready", "temp_valid", "bpm_valid", "gps_fix", "gps_enabled")):
            out[name] = bool(v[1] & (1 << bit))
    return out
