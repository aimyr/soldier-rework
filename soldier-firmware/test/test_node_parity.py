"""Compare the C++ node logic with the Python reference in commander-hq/backend.

tools/test.sh builds test/native/test_node.cpp and sets NODE_BINARY. Inputs are
chosen to be exact in both float32 and float64, so results must match exactly
(rules, encoding) or to float precision (PDR positions).
"""
import math
import os
import pathlib
import random
import subprocess
import sys
import unittest

BACKEND = pathlib.Path(__file__).resolve().parents[2] / "commander-hq" / "backend"
sys.path.insert(0, str(BACKEND))
from app.analysis.pdr import PDR  # noqa: E402
from app.node_rules import NodeRuleState, Sample, evaluate  # noqa: E402
from app.protocol import Packet, encode  # noqa: E402

BINARY = os.environ.get("NODE_BINARY")


def run(args, lines):
    result = subprocess.run([BINARY, *args], input="\n".join(lines) + "\n",
                            capture_output=True, text=True, check=True)
    return result.stdout.splitlines()


@unittest.skipUnless(BINARY, "run via tools/test.sh")
class NodeParityTests(unittest.TestCase):
    def test_encode(self):
        rng = random.Random(1)
        rows, expected = [], []
        for _ in range(500):
            f = [rng.choice((1, 2)), rng.randint(1, 255), rng.randint(0, 65535), rng.randint(0, 65535),
                 rng.choice((0, 1, 2, 3, 4, 5, 0x10, 0x12)), rng.randint(0, 255), rng.randint(-32768, 32767),
                 rng.randint(0, 255), rng.randint(-32768, 32767), rng.randint(-32768, 32767),
                 rng.randint(0, 255), rng.randint(0, 255)]
            rows.append(" ".join(map(str, f)))
            expected.append(encode(Packet(
                ptype=f[0], soldier_id=f[1], seq=f[2], t_s=f[3], code=f[4], hr_bpm=f[5],
                skin_temp_c=f[6] / 100, activity=f[7], x_m=f[8] / 10, y_m=f[9] / 10,
                gas=f[10], hops=f[11])).hex())
        self.assertEqual(run(["--encode"], rows), expected)

    def test_rules(self):
        for seed in range(20):
            rng = random.Random(seed)
            hr0, temp0 = rng.randint(55, 80), rng.randint(130, 140) / 4
            state = NodeRuleState(resting_hr=hr0, resting_temp=temp0)
            hr, temp, mode, rows, expected = float(hr0), temp0, "walk", [], []
            for t in range(1500):
                if rng.random() < 0.03:  # switch scenario now and then
                    mode = rng.choice(("walk", "rest", "injury", "unconscious", "heat", "gas", "low"))
                accel = rng.randint(4, 6) / 4
                activity = float(rng.randint(30, 70))
                gas = float(rng.randint(0, 40))
                if mode == "rest":
                    activity = float(rng.randint(0, 12))
                    hr += (hr0 - hr) * 0.25
                elif mode == "injury":
                    activity = float(rng.randint(0, 6))
                    hr = float(min(200, hr + rng.randint(0, 8)))
                elif mode == "unconscious":
                    activity = float(rng.randint(0, 4))
                    hr = float(max(30, hr - rng.randint(0, 3)))
                    if rng.random() < 0.05:
                        accel = rng.randint(10, 14) / 4  # impact
                elif mode == "heat":
                    temp = min(temp0 + 3, temp + 0.25)
                    hr = float(min(hr0 + 60, hr + rng.randint(0, 3)))
                elif mode == "gas":
                    gas = float(rng.randint(100, 200))
                elif mode == "low":
                    activity = float(rng.randint(0, 9))
                    hr = float(rng.randint(35, 55))
                else:
                    hr += (hr0 + 25 - hr) * 0.25
                    temp += (temp0 - temp) * 0.25
                hr, temp = float(round(hr)), round(temp * 4) / 4  # exact in float32
                rows.append(f"{t} {hr} {temp} {accel} {activity} {gas}")
                code = evaluate(state, Sample(t_s=t, hr_bpm=hr, skin_temp_c=temp, accel_g=accel,
                                              activity=activity, gas=gas))
                expected.append(str(int(code) if code is not None else 0))
            got = run(["--rules", str(hr0), str(temp0)], rows)
            self.assertEqual(got, expected, f"seed {seed}")
            self.assertGreater(len(set(expected)), 3, f"seed {seed} exercises few rules")

    def test_pdr(self):
        rng = random.Random(7)
        reference = PDR()
        rows, expected = [], []
        heading, previous, t_ms = 0.0, 0.0, 0
        for _ in range(6000):
            t_ms += 7  # 7 ms never lands exactly on the 300 ms step interval
            heading += rng.uniform(-0.02, 0.02)
            accel = rng.choice((rng.randint(48, 72), rng.randint(76, 100))) / 64  # avoids 1.14..1.16
            reference.update(t_ms / 1000, accel, (heading - previous) / 0.007, 0.007)
            previous = heading
            rows.append(f"{t_ms} {accel} {heading!r}")
            expected.append((reference.s.x, reference.s.y, reference.s.steps))
        got = [tuple(map(float, line.split())) for line in run(["--pdr"], rows)]
        self.assertEqual([int(g[2]) for g in got], [e[2] for e in expected])
        self.assertGreater(expected[-1][2], 100)
        for (gx, gy, _), (ex, ey, _) in zip(got, expected):
            self.assertLess(math.hypot(gx - ex, gy - ey), 0.05)


if __name__ == "__main__":
    unittest.main()
