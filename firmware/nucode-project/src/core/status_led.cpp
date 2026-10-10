#include "status_led.h"
#include <Arduino.h>

void StatusLed::begin() {
  pinMode(LED_BUILTIN, OUTPUT);
  // Force a known state, regardless of variant initialization.
  digitalWrite(LED_BUILTIN, LED_STATE_ON);
  on_ = true;
  state_ = State::Boot;
  sinceMs_ = millis();
}
void StatusLed::set(bool on) {
  if (on == on_) return;
  digitalWrite(LED_BUILTIN, on ? LED_STATE_ON : !LED_STATE_ON);
  on_ = on;
}
void StatusLed::update(State state, uint32_t nowMs) {
  if (state != state_) { state_ = state; sinceMs_ = nowMs; }
  const uint32_t elapsed = nowMs - sinceMs_;
  if (state == State::Boot) { set(true); return; }
  if (state == State::Fatal) { set(elapsed % 250 < 80); return; }
  const uint8_t pulses = state == State::SensorFault ? 3 : state == State::Connected ? 2 : 1;
  const uint32_t phase = elapsed % 2000;
  set(phase < uint32_t(pulses) * 200 && phase % 200 < 60);
}
