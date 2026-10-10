#include "tmp36.h"
#include "config.h"

void Tmp36::begin() { pinMode(pin_, INPUT); }
void Tmp36::sample() {
  sum_ += analogRead(pin_);
  if (++count_ < 16) return;
  const int32_t value = (int32_t)((sum_ * ADC_VREF_MV * 10UL) /
      (ADC_SCALE * 16UL)) - 5000;
  // TMP36 specified temperature range. A floating input can still look plausible.
  temperature_ = (value < -4000 || value > 12500) ? INT16_MIN : (int16_t)value;
  sum_ = 0; count_ = 0;
}
int16_t Tmp36::readCelsiusX100() { return temperature_; }
