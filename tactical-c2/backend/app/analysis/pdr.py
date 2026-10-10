"""Pedestrian Dead Reckoning (PDR) reference implementation.

Position is estimated from the IMU alone: detect steps in the acceleration
magnitude, estimate stride length, and advance along the gyro-integrated
heading. Runs on the node (firmware port) and here for offline analysis of
logged IMU data and for unit tests.

Stride model: Weinberg (Analog Devices AN-602), stride = K * (a_max - a_min)^(1/4).
K must be calibrated per soldier by walking a known distance.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass
class PDRConfig:
    step_threshold_g: float = 1.15   # magnitude must rise above this to count a peak
    min_step_interval_s: float = 0.3
    weinberg_k: float = 0.7
    default_stride_m: float = 0.7


@dataclass
class PDRState:
    x: float = 0.0
    y: float = 0.0
    heading_rad: float = 0.0          # 0 = north (+y), clockwise positive
    steps: int = 0
    distance_m: float = 0.0
    _last_step_t: float = -1e9
    _above: bool = False
    _win_min: float = 9.9
    _win_max: float = 0.0
    track: list = field(default_factory=list)


class PDR:
    def __init__(self, x0: float = 0.0, y0: float = 0.0, heading0_rad: float = 0.0, cfg: PDRConfig | None = None):
        self.cfg = cfg or PDRConfig()
        self.s = PDRState(x=x0, y=y0, heading_rad=heading0_rad)

    def update(self, t_s: float, accel_mag_g: float, gyro_z_rad_s: float, dt_s: float) -> bool:
        """Feed one IMU sample. Returns True when a step was detected."""
        s, c = self.s, self.cfg
        s.heading_rad = (s.heading_rad + gyro_z_rad_s * dt_s) % (2 * math.pi)
        s._win_min = min(s._win_min, accel_mag_g)
        s._win_max = max(s._win_max, accel_mag_g)

        stepped = False
        if accel_mag_g > c.step_threshold_g and not s._above:
            s._above = True
            if t_s - s._last_step_t >= c.min_step_interval_s:
                stride = self._stride(s._win_max - s._win_min)
                s.x += stride * math.sin(s.heading_rad)
                s.y += stride * math.cos(s.heading_rad)
                s.steps += 1
                s.distance_m += stride
                s._last_step_t = t_s
                s.track.append((t_s, s.x, s.y))
                stepped = True
            s._win_min, s._win_max = 9.9, 0.0
        elif accel_mag_g < 1.0:
            s._above = False
        return stepped

    def _stride(self, a_range_g: float) -> float:
        if a_range_g <= 0:
            return self.cfg.default_stride_m
        # range in g; K absorbs units and is calibrated per soldier
        return self.cfg.weinberg_k * a_range_g ** 0.25

    def correct(self, x: float, y: float, weight: float = 0.5) -> None:
        """Blend toward an external fix (e.g. strong-RSSI proximity to a neighbour)."""
        w = max(0.0, min(1.0, weight))
        self.s.x = (1 - w) * self.s.x + w * x
        self.s.y = (1 - w) * self.s.y + w * y
