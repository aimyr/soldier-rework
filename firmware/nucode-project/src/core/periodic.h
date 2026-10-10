#pragma once
#include <stdint.h>

// micros() 기반 고정 주기 타이머. 누적 오차 없이 period 간격을 유지한다.
class Periodic {
public:
  explicit Periodic(uint32_t periodUs) : period_(periodUs) {}

  bool due(uint32_t nowUs) {
    if ((uint32_t)(nowUs - last_) < period_) return false;
    last_ += period_;
    // 오래 밀렸으면 따라잡기 대신 리셋 (폭주 방지)
    if ((uint32_t)(nowUs - last_) >= period_) last_ = nowUs;
    return true;
  }

private:
  uint32_t period_;
  uint32_t last_ = 0;
};
