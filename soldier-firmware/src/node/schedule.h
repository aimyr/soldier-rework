#pragma once
// Power-on baseline and randomized check-in timing (docs/DATA_SPEC.md section 1).

#include <stdint.h>

namespace node {

constexpr uint32_t CHECKIN_PERIOD_S = 120;
constexpr int32_t CHECKIN_JITTER_S = 30;  // +/- around the period

// Resting heart rate and skin temperature, averaged while the soldier stands
// still after power-on. Complete after BASELINE_SAMPLES valid seconds of both,
// or after BASELINE_TIMEOUT_S with whatever was collected.
class Baseline {
public:
  static constexpr uint16_t BASELINE_SAMPLES = 20;
  static constexpr uint16_t MIN_SAMPLES = 5;  // fewer than this after timeout = no baseline
  static constexpr uint32_t BASELINE_TIMEOUT_S = 120;

  void add(uint32_t tS, bool hrValid, float hrBpm, bool tempValid, float skinTempC) {
    if (done_) return;
    if (hrValid) { hrSum_ += hrBpm; ++hrCount_; }
    if (tempValid) { tempSum_ += skinTempC; ++tempCount_; }
    done_ = (hrCount_ >= BASELINE_SAMPLES && tempCount_ >= BASELINE_SAMPLES) || tS >= BASELINE_TIMEOUT_S;
  }
  bool done() const { return done_; }
  bool hrValid() const { return hrCount_ >= MIN_SAMPLES; }
  float hrBpm() const { return hrCount_ ? hrSum_ / hrCount_ : 0; }
  bool tempValid() const { return tempCount_ >= MIN_SAMPLES; }
  float skinTempC() const { return tempCount_ ? tempSum_ / tempCount_ : 0; }

private:
  bool done_ = false;
  float hrSum_ = 0, tempSum_ = 0;
  uint16_t hrCount_ = 0, tempCount_ = 0;
};

class CheckinTimer {
public:
  void start(uint32_t tS) { dueS_ = tS; started_ = true; }  // first check-in due now
  bool started() const { return started_; }
  bool due(uint32_t tS) const { return started_ && int32_t(tS - dueS_) >= 0; }
  // jitterS: uniform random in [-CHECKIN_JITTER_S, CHECKIN_JITTER_S].
  void schedule(uint32_t tS, int32_t jitterS) { dueS_ = tS + uint32_t(int32_t(CHECKIN_PERIOD_S) + jitterS); }

private:
  bool started_ = false;
  uint32_t dueS_ = 0;
};

}  // namespace node
