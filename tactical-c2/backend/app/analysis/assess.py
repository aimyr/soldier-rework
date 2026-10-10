"""Commander-side assessment of a single soldier from received packets."""
from __future__ import annotations

from .. import config
from ..protocol import AlertCode

SEVERITY_ORDER = {"OK": 0, "UNKNOWN": 1, "WATCH": 2, "WARN": 3, "CRITICAL": 4}

ALERT_SEVERITY = {
    AlertCode.NONE: "OK",
    AlertCode.HEAT_STRAIN: "WARN",
    AlertCode.HAZARD_ENV: "WARN",
    AlertCode.SITREP_CONTACT: "WARN",
    AlertCode.HR_SPIKE_IMMOBILE: "CRITICAL",
    AlertCode.HR_LOW_IMMOBILE: "CRITICAL",
    AlertCode.FALL_IMMOBILE: "CRITICAL",
    AlertCode.SITREP_SOS: "CRITICAL",
}

ALERT_INTERPRETATION = {
    AlertCode.NONE: "routine check-in",
    AlertCode.HR_SPIKE_IMMOBILE: "suspected injury or panic",
    AlertCode.HR_LOW_IMMOBILE: "suspected loss of consciousness",
    AlertCode.FALL_IMMOBILE: "suspected hit or fall",
    AlertCode.HEAT_STRAIN: "heat exhaustion risk",
    AlertCode.HAZARD_ENV: "gas exposure risk",
    AlertCode.SITREP_CONTACT: "enemy or target sighted (manual report)",
    AlertCode.SITREP_SOS: "requests immediate help (manual report)",
}


def sector_of(x_m: float, y_m: float) -> str:
    """3x3 grid over the AO. Columns A.. west->east, rows 1.. south->north."""
    cell = config.AO_SIZE_M / config.GRID_N
    col = int(max(0, min(config.GRID_N - 1, x_m // cell)))
    row = int(max(0, min(config.GRID_N - 1, y_m // cell)))
    return f"{chr(ord('A') + col)}{row + 1}"


def strain_index(hr: float, temp: float, hr0: float, temp0: float) -> float:
    """Physiological Strain Index (Moran et al., 1998), 0..10.

    PSI = 5(Tt - T0)/(39.5 - T0) + 5(HRt - HR0)/(180 - HR0)

    The original index uses CORE temperature. We only have skin temperature,
    so this is an *estimated* PSI and is reported as such.
    """
    t_term = 5 * (temp - temp0) / max(0.5, 39.5 - temp0)
    hr_term = 5 * (hr - hr0) / max(10.0, 180 - hr0)
    return round(max(0.0, min(10.0, t_term + hr_term)), 1)


def psi_band(psi: float) -> str:
    """Display bands for the COP. Demo cut-offs, not validated thresholds."""
    if psi >= 7:
        return "high"
    if psi >= 4:
        return "moderate"
    return "low"
