#include "imu.h"
#include "comm/i2c_bus.h"
#include "core/log.h"
#include "vendor/motionapps612.h"
#include <initializer_list>
#include <string.h>

namespace { I2cBus bus; }
void Imu::fail() {
  state_ = State::Offline; fresh_ = false;
  LOG("[imu] DMP offline; retrying initialization\n");
}
bool Imu::checked(uint8_t reg, uint8_t value) {
  uint8_t actual = 0;
  return bus.write(addr_, reg, value) && bus.read(addr_, reg, &actual, 1) && actual == value;
}
bool Imu::begin() {
  state_ = State::Offline; fresh_ = false;
  loaded_ = 0; failures_ = 0; stillness_.reset();
  bus.begin();
  for (uint8_t addr : {0x68, 0x69}) {
    uint8_t id = 0;
    if (!bus.read(addr, 0x75, &id, 1) || id != 0x68) continue;
    addr_ = addr;
    if (!bus.write(addr_, 0x6B, 0x80)) return false;
    sinceMs_ = millis(); state_ = State::ResetWait;
    LOG("[imu] MPU6050 at 0x%02X; loading DMP 6.12; keep still\n", addr_);
    return true;
  }
  LOG("[imu] MPU6050 not found; check PB21/PB20, power and AD0\n");
  return false;
}
bool Imu::uploadChunk() {
  const uint8_t bank = loaded_ >> 8, offset = loaded_ & 255;
  const uint16_t left = sizeof(DMP_FIRMWARE) - loaded_;
  const uint8_t count = left < 16 ? left : 16;
  uint8_t verify[16];
  if (!bus.write(addr_, 0x6D, bank) || !bus.write(addr_, 0x6E, offset)
      || !bus.writeBlock(addr_, 0x6F, DMP_FIRMWARE + loaded_, count)
      || !bus.write(addr_, 0x6D, bank) || !bus.write(addr_, 0x6E, offset)
      || !bus.read(addr_, 0x6F, verify, count)
      || memcmp(verify, DMP_FIRMWARE + loaded_, count)) return false;
  loaded_ += count;
  return true;
}
bool Imu::resetFifo() {
  fresh_ = false; stillness_.reset(); ++fifoResets_;
  // Stop DMP before resetting FIFO, then restart without reloading its image.
  return bus.write(addr_, 0x6A, 0x40) && bus.write(addr_, 0x6A, 0x44)
      && bus.write(addr_, 0x6A, 0xC0);
}
void Imu::poll() {
  const uint32_t now = millis();
  if (!active()) return;
  if (state_ == State::ResetWait) {
    if (uint32_t(now - sinceMs_) < 100) return;
    if (!bus.write(addr_, 0x6A, 0x07)) { fail(); return; }
    sinceMs_ = now; state_ = State::SignalWait; return;
  }
  if (state_ == State::SignalWait) {
    if (uint32_t(now - sinceMs_) < 100) return;
    // MotionApps 6.12 requires +/-2g and +/-2000dps, unlike raw-mode v2.
    if (!(checked(0x6B, 0x01) && checked(0x6C, 0x00) && checked(0x38, 0x00)
       && checked(0x23, 0x00) && checked(0x1C, 0x00) && checked(0x37, 0x80)
       && checked(0x19, 0x04) && checked(0x1A, 0x01) && checked(0x1B, 0x18)
       && checked(0x6A, 0x00))) { fail(); return; }
    state_ = State::Upload; return;
  }
  if (state_ == State::Upload) {
    // One bank-aligned block per loop; no multi-second blocking upload.
    if (!uploadChunk()) { fail(); return; }
    if (loaded_ == sizeof(DMP_FIRMWARE)) state_ = State::Start;
    return;
  }
  if (state_ == State::Start) {
    if (!(checked(0x70, 0x04) && checked(0x71, 0x00) && checked(0x38, 0x02)
       && resetFifo())) { fail(); return; }
    state_ = State::Settling; sinceMs_ = now; lastDataMs_ = now;
    LOG("[imu] DMP loaded; keep still for at least 10 seconds\n");
    return;
  }
  if (uint32_t(now - lastDataMs_) > 1000) { fail(); return; }
  if (uint32_t(now - lastPollMs_) < 5) return;
  lastPollMs_ = now;
  uint8_t status = 0, countBytes[2];
  if (!bus.read(addr_, 0x3A, &status, 1) || !bus.read(addr_, 0x72, countBytes, 2)) {
    fresh_ = false;
    if (++failures_ >= 3) fail();
    return;
  }
  const uint16_t count = uint16_t(countBytes[0]) << 8 | countBytes[1];
  if ((status & 0x10) || count > DMP_PACKET_BYTES * 4) {
    if (!resetFifo()) fail();
    return;
  }
  // A partial tail can be a packet in flight; do not mistake it for corruption.
  const uint8_t packets = count / DMP_PACKET_BYTES;
  for (uint8_t i = 0; i < packets && i < 2; ++i) {
    uint8_t bytes[DMP_PACKET_BYTES];
    // Each FIFO burst retains the existing 5ms transaction deadline.
    if (!bus.read(addr_, 0x74, bytes, 14) || !bus.read(addr_, 0x74, bytes + 14, 14)) {
      if (!resetFifo() || ++failures_ >= 3) fail();
      return;
    }
    ImuPacket sample;
    OrientationPacket quaternion;
    if (!decodeDmp(bytes, millis(), sample, quaternion)) {
      if (!resetFifo() || ++failures_ >= 3) fail();
      return;
    }
    failures_ = 0; lastDataMs_ = millis();
    if (state_ == State::Settling) {
      if (!stillness_.add(sample) || uint32_t(now - sinceMs_) < 10000) continue;
      state_ = State::Running;
      LOG("[imu] DMP ready; yaw reference is startup-relative\n");
    }
    sample_ = sample; orientation_ = quaternion; fresh_ = true;
  }
}
bool Imu::read(ImuPacket& out, OrientationPacket& orientation) {
  if (!ok() || !fresh_) return false;
  fresh_ = false; out = sample_; orientation = orientation_;
  return true;
}
