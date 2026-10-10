#include "i2c_bus.h"
#include "config.h"
namespace {
void low(uint8_t pin) { digitalWrite(pin, LOW); pinMode(pin, OUTPUT); }
void release(uint8_t pin) { pinMode(pin, INPUT_PULLUP); }
void halfCycle() { delayMicroseconds(5); }
}
bool I2cBus::clockHigh() {
  release(PIN_WIRE_SCL);
  while (!digitalRead(PIN_WIRE_SCL)) {
    if ((uint32_t)(micros() - started_) >= 5000) return false;
    // A stretched/stuck clock must not burn CPU for the full deadline.
    // Other tasks and the RTOS idle task can run while the line is held low.
    delay(1);
  }
  halfCycle();
  return (uint32_t)(micros() - started_) < 5000;
}
void I2cBus::begin() {
  release(PIN_WIRE_SDA); release(PIN_WIRE_SCL);
  started_ = micros();
  // Recover a slave interrupted in the middle of a byte.
  for (uint8_t i = 0; i < 9 && !digitalRead(PIN_WIRE_SDA); ++i) {
    low(PIN_WIRE_SCL); halfCycle();
    if (!clockHigh()) break;
  }
  stop();
}
bool I2cBus::start() {
  release(PIN_WIRE_SDA); halfCycle();
  if (!clockHigh() || !digitalRead(PIN_WIRE_SDA)) return false;
  low(PIN_WIRE_SDA); halfCycle(); low(PIN_WIRE_SCL);
  return true;
}
bool I2cBus::stop() {
  low(PIN_WIRE_SCL); low(PIN_WIRE_SDA); halfCycle();
  const bool clockReleased = clockHigh();
  release(PIN_WIRE_SDA); halfCycle();
  return clockReleased && digitalRead(PIN_WIRE_SDA);
}
bool I2cBus::put(uint8_t value) {
  for (uint8_t mask = 0x80; mask; mask >>= 1) {
    if (value & mask) release(PIN_WIRE_SDA); else low(PIN_WIRE_SDA);
    halfCycle();
    if (!clockHigh()) return false;
    low(PIN_WIRE_SCL);
  }
  release(PIN_WIRE_SDA); halfCycle();
  if (!clockHigh()) return false;
  bool ack = !digitalRead(PIN_WIRE_SDA);
  low(PIN_WIRE_SCL);
  return ack;
}
bool I2cBus::get(uint8_t& value, bool ack) {
  value = 0; release(PIN_WIRE_SDA);
  for (uint8_t i = 0; i < 8; ++i) {
    halfCycle();
    if (!clockHigh()) return false;
    value = (value << 1) | digitalRead(PIN_WIRE_SDA);
    low(PIN_WIRE_SCL);
  }
  if (ack) low(PIN_WIRE_SDA); else release(PIN_WIRE_SDA);
  halfCycle();
  if (!clockHigh()) return false;
  low(PIN_WIRE_SCL); release(PIN_WIRE_SDA);
  return true;
}
bool I2cBus::read(uint8_t address, uint8_t reg, uint8_t* data, uint8_t count) {
  if (address > 0x7F || !data || count == 0) return false;
  started_ = micros();
  bool ok = start() && put(address << 1) && put(reg) && start() && put((address << 1) | 1);
  for (uint8_t i = 0; ok && i < count; ++i) ok = get(data[i], i + 1 < count);
  const bool stopped = stop();
  return ok && stopped;
}
bool I2cBus::write(uint8_t address, uint8_t reg, uint8_t value) {
  if (address > 0x7F) return false;
  started_ = micros();
  bool ok = start() && put(address << 1) && put(reg) && put(value);
  const bool stopped = stop();
  return ok && stopped;
}

bool I2cBus::writeBlock(uint8_t address, uint8_t reg, const uint8_t* data, uint8_t count) {
  if (address > 0x7F || !data || !count || count > 16) return false;
  started_ = micros();
  bool ok = start() && put(address << 1) && put(reg);
  for (uint8_t i = 0; ok && i < count; ++i) ok = put(data[i]);
  const bool stopped = stop();
  return ok && stopped;
}
