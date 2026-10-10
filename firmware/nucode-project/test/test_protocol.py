import pathlib
import re
import struct
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))
from protocol import decode, UUIDS, SERVICE

class ProtocolTests(unittest.TestCase):
    def test_sizes_and_invalid(self):
        for kind in UUIDS:
            with self.assertRaises(ValueError): decode(kind, b"")
        with self.assertRaises(ValueError): decode("status", struct.pack("<IHHII", 0, 2, 0, 0, 0))
    def test_vitals(self):
        p = decode("vitals", struct.pack("<IhHH", 123, -32768, 0, 4095))
        self.assertIsNone(p["temp_c"])
        self.assertIsNone(p["bpm"])
        self.assertEqual(p["pulse_raw"], 4095)
        self.assertEqual(decode("vitals", struct.pack("<IhHH", 0, -25, 60, 1))["temp_c"], -0.25)
    def test_imu(self):
        p = decode("imu", struct.pack("<I6h", 0, 1000, -1000, 0, 1000, -1000, 0))
        self.assertEqual(p["acc_g"], [0.122, -0.122, 0])
        self.assertEqual(p["gyro_dps"], [17.5, -17.5, 0])
    def test_no_fix(self):
        self.assertIsNone(decode("gps", struct.pack("<IiiiHBB", 0, 100, 200, 300, 5, 0, 0))["lat"])
    def test_uuids_match_firmware(self):
        text = (pathlib.Path(__file__).resolve().parents[1] / "src/protocol/uuids.h").read_text()
        for name, value in {"service": SERVICE, **UUIDS}.items():
            self.assertEqual(re.search(r'#define UUID_' + name.upper() + r'\s+"([^" ]+)"', text)[1].lower(), value)

if __name__ == "__main__": unittest.main()
