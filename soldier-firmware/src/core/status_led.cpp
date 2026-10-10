#include "status_led.h"
#include <Arduino.h>
#include "config.h"

void StatusLed::begin() {
  pinMode(STATUS_LED_RED, OUTPUT);
  pinMode(STATUS_LED_GREEN, OUTPUT);
  pinMode(STATUS_LED_BLUE, OUTPUT);
  on_ = false;
  state_ = State::Boot;
  sinceMs_ = millis();
  set(true);
}
void StatusLed::set(bool on) {
  const bool fault = state_ == State::Fatal || state_ == State::SensorFault;
  const bool green = state_ == State::Reporting || state_ == State::Boot;
  const bool blue = state_ == State::Baseline || state_ == State::Boot;
  digitalWrite(STATUS_LED_RED, on && fault);
  digitalWrite(STATUS_LED_GREEN, on && green);
  digitalWrite(STATUS_LED_BLUE, on && blue);
  on_ = on;
}
void StatusLed::update(State state, uint32_t nowMs) {
  if (state != state_) { state_ = state; sinceMs_ = nowMs; }
  const uint32_t elapsed = nowMs - sinceMs_;
  if (state == State::Boot) { set(true); return; }
  if (state == State::Fatal) { set(elapsed % 250 < 80); return; }
  const uint8_t pulses = state == State::SensorFault ? 3 : state == State::Reporting ? 2 : 1;
  const uint32_t phase = elapsed % 2000;
  set(phase < uint32_t(pulses) * 200 && phase % 200 < 60);
}
