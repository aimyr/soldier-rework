#pragma once
// Alert rules: when a node breaks radio silence (docs/DATA_SPEC.md section 3).
// Port of commander-hq/backend/app/node_rules.py evaluate(); keep them in step.
// Thresholds are demo defaults, not clinical values.

#include <stdint.h>
#include "packet.h"

namespace node {

constexpr float IMMOBILE_ACTIVITY = 8;     // activity below this = not moving
constexpr uint32_t IMMOBILE_HOLD_S = 10;
constexpr float HR_SPIKE_DELTA = 45;       // bpm above resting baseline
constexpr float HR_LOW_ABS = 45;           // bpm
constexpr float FALL_IMPACT_G = 2.5f;      // |accel| peak
constexpr uint32_t FALL_WINDOW_S = 15;     // impact and start of immobility at most this far apart
constexpr float HEAT_TEMP_DELTA = 1.5f;    // degC above resting skin temperature
constexpr float HEAT_HR_DELTA = 35;        // bpm above resting baseline
constexpr uint32_t HEAT_HOLD_S = 30;
constexpr float GAS_THRESHOLD = 120;
constexpr uint32_t REALERT_COOLDOWN_S = 60;
constexpr uint32_t BUTTON_COOLDOWN_S = 5;

// One reading per second. Invalid inputs disable the rules that need them.
struct RuleSample {
  uint32_t tS;
  bool hrValid;
  float hrBpm;
  bool tempValid;
  float skinTempC;
  float accelPeakG;     // peak |accel| during the last second
  bool activityValid;   // false while the IMU is offline
  float activity;       // 0..255
  float gas;            // 0..255; no sensor fitted yet, always 0
  AlertCode button;     // manual report; no buttons fitted yet, always None
};

class NodeRules {
public:
  // Resting values from the power-on baseline. HR spike and heat rules
  // stay off until the matching baseline is valid.
  void setBaseline(bool hrValid, float hrBpm, bool tempValid, float skinTempC);
  // Returns the alert to transmit now, or None.
  AlertCode evaluate(const RuleSample& s);

private:
  AlertCode fire(AlertCode code, uint32_t tS, uint32_t cooldownS);

  bool restingHrValid_ = false, restingTempValid_ = false;
  float restingHr_ = 0, restingTemp_ = 0;
  bool immobile_ = false, impact_ = false, heat_ = false;
  uint32_t immobileSince_ = 0, lastImpact_ = 0, heatSince_ = 0;
  struct Sent { AlertCode code; uint32_t tS; };
  Sent sent_[8] = {};
  uint8_t sentCount_ = 0;
};

}  // namespace node
