#pragma once
#include <Arduino.h>
#include "protocol/packets.h"

// MPU6050, I2C 0x68/0x69.
class Imu {
public:
  bool begin();
  bool read(ImuPacket& out);
  bool ok() const { return ok_; }

private:
  bool ok_ = false;
  uint32_t lastDataMs_ = 0;
  uint8_t failures_ = 0;
  uint8_t addr_ = 0;
};
