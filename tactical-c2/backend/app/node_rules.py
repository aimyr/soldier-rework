"""Node-side trigger rules: WHEN does a soldier node break radio silence?

This is the reference implementation the ESP32 firmware should mirror.
The simulator runs it on every synthetic sample, so the commander only ever
receives what a real node would transmit.

All thresholds are demo defaults to be tuned with measured data, not
clinical values.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from .protocol import AlertCode

# --- tunable thresholds -------------------------------------------------------
IMMOBILE_ACTIVITY = 8         # activity units below this = "not moving"
IMMOBILE_HOLD_S = 10          # must stay immobile this long
HR_SPIKE_DELTA = 45           # bpm above personal resting baseline
HR_LOW_ABS = 45               # bpm
FALL_IMPACT_G = 2.5           # |accel| peak in g
FALL_WINDOW_S = 15            # immobility must follow impact within this window
HEAT_TEMP_DELTA = 1.5         # degC above baseline skin temperature
HEAT_HR_DELTA = 35            # bpm above baseline
HEAT_HOLD_S = 30
GAS_THRESHOLD = 120           # 0..255 sensor level
REALERT_COOLDOWN_S = 60       # do not repeat the same alert code inside this window


@dataclass
class Sample:
    t_s: float
    hr_bpm: float
    skin_temp_c: float
    accel_g: float      # |acceleration| magnitude in g
    activity: float     # 0..255
    gas: float
    button: AlertCode = AlertCode.NONE  # manual report pressed this second


@dataclass
class NodeRuleState:
    resting_hr: float
    resting_temp: float
    immobile_since: float | None = None
    last_impact_t: float | None = None
    heat_since: float | None = None
    last_sent: dict = field(default_factory=dict)
    recent: deque = field(default_factory=lambda: deque(maxlen=30))


def evaluate(st: NodeRuleState, s: Sample) -> AlertCode | None:
    """Return an alert code if the node should transmit now, else None."""
    st.recent.append(s)

    # manual reports always go out (still subject to cooldown to avoid button bounce)
    if s.button != AlertCode.NONE:
        return _fire(st, s.button, s.t_s, cooldown=5)

    if s.accel_g >= FALL_IMPACT_G:
        st.last_impact_t = s.t_s

    if s.activity < IMMOBILE_ACTIVITY:
        st.immobile_since = st.immobile_since if st.immobile_since is not None else s.t_s
    else:
        st.immobile_since = None
    immobile_for = (s.t_s - st.immobile_since) if st.immobile_since is not None else 0.0
    immobile = immobile_for >= IMMOBILE_HOLD_S

    if immobile and st.last_impact_t is not None and abs(st.immobile_since - st.last_impact_t) <= FALL_WINDOW_S:
        return _fire(st, AlertCode.FALL_IMMOBILE, s.t_s)
    if immobile and s.hr_bpm <= HR_LOW_ABS:
        return _fire(st, AlertCode.HR_LOW_IMMOBILE, s.t_s)
    if immobile and s.hr_bpm >= st.resting_hr + HR_SPIKE_DELTA:
        return _fire(st, AlertCode.HR_SPIKE_IMMOBILE, s.t_s)

    if s.gas >= GAS_THRESHOLD:
        return _fire(st, AlertCode.HAZARD_ENV, s.t_s)

    hot = (s.skin_temp_c >= st.resting_temp + HEAT_TEMP_DELTA and s.hr_bpm >= st.resting_hr + HEAT_HR_DELTA)
    if hot:
        st.heat_since = st.heat_since if st.heat_since is not None else s.t_s
        if s.t_s - st.heat_since >= HEAT_HOLD_S:
            return _fire(st, AlertCode.HEAT_STRAIN, s.t_s)
    else:
        st.heat_since = None
    return None


def _fire(st: NodeRuleState, code: AlertCode, t: float, cooldown: float = REALERT_COOLDOWN_S) -> AlertCode | None:
    last = st.last_sent.get(code)
    if last is not None and t - last < cooldown:
        return None
    st.last_sent[code] = t
    return code
