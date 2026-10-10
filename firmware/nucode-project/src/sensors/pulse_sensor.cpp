#include "pulse_sensor.h"
#include "config.h"

void PulseSensor::begin() {
  pinMode(pin_, INPUT);
}

void PulseSensor::sample() {
  raw_ = analogRead(pin_);
  const int sig = raw_ >> (ADC_BITS - 10);  // 10bit 스케일

  const uint32_t now = millis();
  // A long sampling gap invalidates the beat history; never invent samples.
  if (!sampled_ || (uint32_t)(now - previousMs_) > 20) {
    thresh_ = peak_ = trough_ = 512;
    first_ = true; second_ = false; pulse_ = false;
    bpm_ = 0; ibi_ = 600; lastBeat_ = now;
  }
  sampled_ = true;
  previousMs_ = now;
  sampleCounter_ = now;
  const int32_t n = (int32_t)(sampleCounter_ - lastBeat_);

  if (sig < thresh_ && n > (ibi_ / 5) * 3 && sig < trough_) trough_ = sig;
  if (sig > thresh_ && sig > peak_) peak_ = sig;

  if (n > 250) {
    if (sig > thresh_ && !pulse_ && n > (ibi_ / 5) * 3) {
      pulse_ = true;
      ibi_ = (uint16_t)(sampleCounter_ - lastBeat_);
      lastBeat_ = sampleCounter_;

      if (second_) {
        second_ = false;
        for (auto& r : rate_) r = ibi_;
      }
      if (first_) {
        first_ = false;
        second_ = true;
        return;
      }

      uint32_t total = 0;
      for (int i = 0; i < 9; i++) {
        rate_[i] = rate_[i + 1];
        total += rate_[i];
      }
      rate_[9] = ibi_;
      total += ibi_;
      bpm_ = (uint16_t)(60000UL * 10 / total);
    }
  }

  if (sig < thresh_ && pulse_) {
    pulse_ = false;
    amp_ = peak_ - trough_;
    thresh_ = amp_ / 2 + trough_;
    peak_ = thresh_;
    trough_ = thresh_;
  }

  // 2.5초 동안 비트 없으면 초기화
  if (n > 2500) {
    thresh_ = peak_ = trough_ = 512;
    lastBeat_ = sampleCounter_;
    first_ = true;
    second_ = false;
    bpm_ = 0;
    pulse_ = false;
    ibi_ = 600;
  }
}
