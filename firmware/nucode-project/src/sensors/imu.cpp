#include "imu.h"
#include "comm/i2c_bus.h"
#include <initializer_list>
#include "core/log.h"

namespace {
constexpr uint8_t REG_WHO_AM_I = 0x0F;
constexpr uint8_t REG_CTRL1_XL = 0x10;
constexpr uint8_t REG_CTRL2_G  = 0x11;
constexpr uint8_t REG_CTRL3_C  = 0x12;
constexpr uint8_t REG_CTRL6_C = 0x15;
constexpr uint8_t REG_CTRL7_G = 0x16;
constexpr uint8_t REG_OUTX_L_G = 0x22;  // gyro XYZ, 이어서 accel XYZ

I2cBus bus;
bool readRegs(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t len) {
  return bus.read(addr, reg, buf, len);
}
bool writeReg(uint8_t addr, uint8_t reg, uint8_t val) {
  return bus.write(addr, reg, val);
}
}  // namespace

bool Imu::begin() {
  ok_ = false;
  bus.begin();

  for (uint8_t addr : {0x6A, 0x6B}) {
    uint8_t id = 0;
    if (!readRegs(addr, REG_WHO_AM_I, &id, 1)) continue;
    LOG("[imu] addr 0x%02X WHO_AM_I=0x%02X\n", addr, id);
    // NU-IMU product sheet: LSM6DS3TR. TR-C WHO_AM_I = 0x6A.
    if (id != 0x6A) continue;

    addr_ = addr;
    const uint8_t accelControl = IMU_LOW_POWER ? 0x38 : 0x48;
    const uint8_t gyroControl = IMU_LOW_POWER ? 0x34 : 0x44;
    const uint8_t accelMode = IMU_LOW_POWER ? 0x10 : 0;
    const uint8_t gyroMode = IMU_LOW_POWER ? 0x80 : 0;
    // ST LSM6DS3TR-C: CTRL6_C bit4 and CTRL7_G bit7 disable high-performance
    // mode. With ODR=52Hz this selects low-power operation, same full scales.
    ok_ = writeReg(addr, REG_CTRL3_C, 0x44)
       && writeReg(addr, REG_CTRL6_C, accelMode)
       && writeReg(addr, REG_CTRL7_G, gyroMode)
       && writeReg(addr, REG_CTRL1_XL, accelControl)
       && writeReg(addr, REG_CTRL2_G, gyroControl);
    uint8_t config[3] = {}, modes[2] = {};
    ok_ = ok_ && readRegs(addr, REG_CTRL1_XL, config, 3)
        && config[0] == accelControl && config[1] == gyroControl && config[2] == 0x44
        && readRegs(addr, REG_CTRL6_C, modes, 2)
        && modes[0] == accelMode && modes[1] == gyroMode;
    failures_ = 0;
    lastDataMs_ = millis();
    return ok_;
  }
  LOG("[imu] LSM6DS 계열을 찾지 못함 (Qwiic 연결/칩 종류 확인)\n");
  return false;
}

bool Imu::read(ImuPacket& out) {
  if (!ok_) return false;
  uint8_t b[12];
  uint8_t status = 0;
  if (!readRegs(addr_, 0x1E, &status, 1)) {
    if (++failures_ >= 3) ok_ = false;
    return false;
  }
  if ((status & 3) != 3) {
    failures_ = 0; // A successful no-data status breaks a run of bus errors.
    if ((uint32_t)(millis() - lastDataMs_) > 1000) ok_ = false;
    return false;
  } // Only publish fresh accel + gyro.
  if (!readRegs(addr_, REG_OUTX_L_G, b, sizeof(b))) {
    if (++failures_ >= 3) ok_ = false;
    return false;
  }
  failures_ = 0;
  auto i16 = [&](int i) { return (int16_t)(b[i] | (b[i + 1] << 8)); };
  lastDataMs_ = millis();
  out.t_ms = lastDataMs_;
  out.gx = i16(0);  out.gy = i16(2);  out.gz = i16(4);
  out.ax = i16(6);  out.ay = i16(8);  out.az = i16(10);
  return true;
}
