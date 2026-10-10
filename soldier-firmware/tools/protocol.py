"""Protocol v3 (MPU6050 DMP); matches src/protocol/packets.h and uuids.h."""
import struct
import math

SERVICE = "76b92001-7c4d-4f21-9b63-136a2d8e507c"
UUIDS = {name: f"76b9200{index}-7c4d-4f21-9b63-136a2d8e507c"
         for index, name in enumerate(("imu", "vitals", "gps", "status", "orientation"), 2)}
FORMATS = {"imu": "<I6h", "vitals": "<IhHH", "gps": "<IiiiHBB", "status": "<IHHII", "orientation": "<I4i"}


def decode(kind, payload):
    fmt = FORMATS[kind]
    if len(payload) != struct.calcsize(fmt):
        raise ValueError(f"{kind}: expected {struct.calcsize(fmt)} bytes, got {len(payload)}")
    t, *v = struct.unpack(fmt, payload)
    out = {"type": kind, "t_ms": t}
    if kind == "imu":
        out.update(acc_g=[round(x / 16384.0, 6) for x in v[:3]],
                   gyro_dps=[round(x / 16.4, 4) for x in v[3:]])
    elif kind == "orientation":
        q = [x / 1073741824.0 for x in v]
        norm2 = sum(x*x for x in q)
        if not 0.9 <= norm2 <= 1.1:
            raise ValueError("Invalid DMP quaternion norm")
        w, x, y, z = q = [x / math.sqrt(norm2) for x in q]
        # ZYX Euler convention; quaternion is authoritative near gimbal lock.
        roll = math.atan2(2*(w*x+y*z), 1-2*(x*x+y*y))
        pitch = math.asin(max(-1.0, min(1.0, 2*(w*y-z*x))))
        yaw = math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z))
        out.update(quaternion_wxyz=q, roll_deg=math.degrees(roll),
                   pitch_deg=math.degrees(pitch), yaw_deg=math.degrees(yaw))
    elif kind == "vitals":
        out.update(temp_c=None if v[0] == -32768 else v[0] / 100,
                   bpm=v[1] or None, pulse_raw=v[2])
    elif kind == "gps":
        out.update(fix=bool(v[4]), lat=v[0] / 1e7 if v[4] else None,
                   lon=v[1] / 1e7 if v[4] else None,
                   alt_m=v[2] / 100 if v[4] else None,
                   speed_mps=v[3] / 100 if v[4] else None, sats=v[5])
    else:
        if v[0] != 3:
            raise ValueError(f"Unsupported protocol version {v[0]}")
        out.update(version=v[0], flags=v[1], tx_dropped=v[2], sample_gaps=v[3])
        for bit, name in enumerate(("imu_online", "analog_ready", "temp_valid", "bpm_valid", "gps_fix", "gps_enabled", "dmp_initializing")):
            out[name] = bool(v[1] & (1 << bit))
    return out
