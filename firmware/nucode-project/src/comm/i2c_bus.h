#pragma once
#include <Arduino.h>

// Single-master, open-drain software I2C. A whole transaction has a deadline:
// no transaction may stall sensor processing indefinitely.
class I2cBus {
public:
  void begin();
  bool read(uint8_t address, uint8_t reg, uint8_t* data, uint8_t count);
  bool write(uint8_t address, uint8_t reg, uint8_t value);
private:
  uint32_t started_ = 0;
  bool clockHigh();
  bool start();
  bool stop();
  bool put(uint8_t value);
  bool get(uint8_t& value, bool ack);
};
