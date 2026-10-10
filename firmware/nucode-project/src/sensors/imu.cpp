#include "imu.h"
#include "comm/i2c_bus.h"
#include "core/log.h"
#include "mpu6050_decode.h"
#include <initializer_list>

namespace {
I2cBus bus;
bool writeChecked(uint8_t addr, uint8_t reg, uint8_t value) {
  uint8_t actual = 0;
  return bus.write(addr, reg, value) && bus.read(addr, reg, &actual, 1) && actual == value;
}
}
bool Imu::begin() {
  ok_ = false;
  bus.begin();
  for (uint8_t addr : {0x68, 0x69}) {
    uint8_t id = 0;
    if (!bus.read(addr, 0x75, &id, 1)) continue;
    LOG("[imu] addr=0x%02X WHO_AM_I=0x%02X\n", addr, id);
    if (id != 0x68) continue;
    addr_ = addr;
    // Reset clears any settings left by a previous application.
    if (!bus.write(addr, 0x6B, 0x80)) return false;
    delay(100); // RTOS yields; independent ADC acquisition continues.
    // PLL X gyro clock, temperature disabled, all six motion axes enabled.
    ok_ = writeChecked(addr, 0x6B, 0x09)
       && writeChecked(addr, 0x6C, 0x00)
       && writeChecked(addr, 0x1A, 0x04) // DLPF ~20Hz, internal rate 1kHz
       && writeChecked(addr, 0x19, 19)   // 1kHz / 20 = 50Hz
       && writeChecked(addr, 0x1B, 0x08) // Gyro +/-500 deg/s
       && writeChecked(addr, 0x1C, 0x08) // Accel +/-4g
       && writeChecked(addr, 0x38, 0x01); // Data-ready status
    failures_ = 0;
    lastDataMs_ = millis();
    return ok_;
  }
  LOG("[imu] MPU6050 not found; check power, SDA/SCL and AD0\n");
  return false;
}
bool Imu::read(ImuPacket& out) {
  if (!ok_) return false;
  uint8_t status = 0, bytes[14]{};
  if (!bus.read(addr_, 0x3A, &status, 1)) {
    if (++failures_ >= 3) ok_ = false;
    return false;
  }
  if (!(status & 1)) {
    failures_ = 0;
    if (uint32_t(millis() - lastDataMs_) > 1000) ok_ = false;
    return false;
  }
  if (!bus.read(addr_, 0x3B, bytes, sizeof(bytes))) {
    if (++failures_ >= 3) ok_ = false;
    return false;
  }
  failures_ = 0;
  lastDataMs_ = millis();
  out = decodeMpu6050(bytes, lastDataMs_);
  return true;
}
