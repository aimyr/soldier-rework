#include "rules.h"

namespace node {

void NodeRules::setBaseline(bool hrValid, float hrBpm, bool tempValid, float skinTempC) {
  restingHrValid_ = hrValid;
  restingHr_ = hrBpm;
  restingTempValid_ = tempValid;
  restingTemp_ = skinTempC;
}

AlertCode NodeRules::evaluate(const RuleSample& s) {
  // Manual reports always go out; the short cooldown absorbs button bounce.
  if (s.button != AlertCode::None) return fire(s.button, s.tS, BUTTON_COOLDOWN_S);

  if (s.accelPeakG >= FALL_IMPACT_G) {
    impact_ = true;
    lastImpact_ = s.tS;
  }

  // Unknown activity counts as moving, so a dead IMU cannot raise immobility alerts.
  if (s.activityValid && s.activity < IMMOBILE_ACTIVITY) {
    if (!immobile_) { immobile_ = true; immobileSince_ = s.tS; }
  } else {
    immobile_ = false;
  }
  const bool immobile = immobile_ && s.tS - immobileSince_ >= IMMOBILE_HOLD_S;

  if (immobile && impact_) {
    const int64_t gap = int64_t(immobileSince_) - int64_t(lastImpact_);
    if ((gap < 0 ? -gap : gap) <= int64_t(FALL_WINDOW_S)) return fire(AlertCode::FallImmobile, s.tS, REALERT_COOLDOWN_S);
  }
  if (immobile && s.hrValid && s.hrBpm <= HR_LOW_ABS) return fire(AlertCode::HrLowImmobile, s.tS, REALERT_COOLDOWN_S);
  if (immobile && s.hrValid && restingHrValid_ && s.hrBpm >= restingHr_ + HR_SPIKE_DELTA)
    return fire(AlertCode::HrSpikeImmobile, s.tS, REALERT_COOLDOWN_S);

  if (s.gas >= GAS_THRESHOLD) return fire(AlertCode::HazardEnv, s.tS, REALERT_COOLDOWN_S);

  const bool hot = s.hrValid && s.tempValid && restingHrValid_ && restingTempValid_
      && s.skinTempC >= restingTemp_ + HEAT_TEMP_DELTA && s.hrBpm >= restingHr_ + HEAT_HR_DELTA;
  if (hot) {
    if (!heat_) { heat_ = true; heatSince_ = s.tS; }
    if (s.tS - heatSince_ >= HEAT_HOLD_S) return fire(AlertCode::HeatStrain, s.tS, REALERT_COOLDOWN_S);
  } else {
    heat_ = false;
  }
  return AlertCode::None;
}

AlertCode NodeRules::fire(AlertCode code, uint32_t tS, uint32_t cooldownS) {
  for (uint8_t i = 0; i < sentCount_; ++i) {
    if (sent_[i].code != code) continue;
    if (tS - sent_[i].tS < cooldownS) return AlertCode::None;
    sent_[i].tS = tS;
    return code;
  }
  if (sentCount_ < sizeof(sent_) / sizeof(sent_[0])) sent_[sentCount_++] = Sent{code, tS};
  return code;
}

}  // namespace node
