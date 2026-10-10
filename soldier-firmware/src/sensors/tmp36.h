#pragma once
#include <Arduino.h>

// TMP36GT9Z: 10 mV/°C, 500 mV offset (0°C = 500 mV)
class Tmp36 {
public:
  explicit Tmp36(uint8_t pin) : pin_(pin) {}
  void begin();
  void sample();
  // 16 samples spread over time; INT16_MIN = invalid/not ready
  int16_t readCelsiusX100();

private:
  uint8_t pin_;
  uint32_t sum_ = 0;
  uint8_t count_ = 0;
  int16_t temperature_ = INT16_MIN;
};
