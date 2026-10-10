#pragma once
#include <stdint.h>

// Error-diffused conversion from microseconds to RTOS ticks. Unlike rounding
// every delay independently, this preserves the long-term sampling frequency.
class FractionalTicks {
public:
  constexpr FractionalTicks(uint32_t periodUs, uint32_t tickHz)
      : whole_(uint64_t(periodUs) * tickHz / 1000000),
        fraction_(uint64_t(periodUs) * tickHz % 1000000) {}
  uint32_t next() {
    remainder_ += fraction_;
    if (remainder_ >= 1000000) {
      remainder_ -= 1000000;
      return whole_ + 1;
    }
    return whole_;
  }
private:
  const uint32_t whole_;
  const uint32_t fraction_;
  uint32_t remainder_ = 0;
};
