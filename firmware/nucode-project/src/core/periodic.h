#pragma once
#include <stdint.h>

// Periodic micros() timer that preserves cadence without cumulative drift.
class Periodic {
public:
  explicit Periodic(uint32_t periodUs) : period_(periodUs) {}

  bool due(uint32_t nowUs) {
    if ((uint32_t)(nowUs - last_) < period_) return false;
    last_ += period_;
    // Skip missed periods after a long delay to prevent catch-up bursts.
    if ((uint32_t)(nowUs - last_) >= period_) last_ = nowUs;
    return true;
  }

private:
  uint32_t period_;
  uint32_t last_ = 0;
};
