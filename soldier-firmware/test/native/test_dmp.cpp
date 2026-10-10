#include <cassert>
#include <cstdio>
#include <cstring>
#include <deque>
#include "sensors/imu.h"
#include "comm/i2c_bus.h"
#include "sensors/vendor/motionapps612.h"

uint32_t now = 0;
uint32_t millis() { return now; }
void logMessage(const char*, ...) {}
uint8_t registers_[256]{}, memory_[4096]{};
uint8_t bank_ = 0, offset_ = 0;
bool present = true, badVerify = false, nack = false, failTail = false;
std::deque<uint8_t> fifo;
void I2cBus::begin() {}
bool I2cBus::write(uint8_t address, uint8_t reg, uint8_t value) {
  if (!present || nack || address != 0x68) return false;
  registers_[reg] = value;
  if (reg == 0x6D) bank_ = value;
  if (reg == 0x6E) offset_ = value;
  if (reg == 0x6A && (value & 4)) fifo.clear();
  return true;
}
bool I2cBus::writeBlock(uint8_t address, uint8_t reg, const uint8_t* data, uint8_t count) {
  if (!present || nack || address != 0x68 || reg != 0x6F) return false;
  assert(count <= 16 && unsigned(offset_) + count <= 256);
  memcpy(memory_ + unsigned(bank_)*256 + offset_, data, count);
  offset_ += count;
  return true;
}
bool I2cBus::read(uint8_t address, uint8_t reg, uint8_t* data, uint8_t count) {
  if (!present || nack || address != 0x68) return false;
  if (reg == 0x75) { *data = 0x68; return true; }
  if (reg == 0x6F) {
    memcpy(data, memory_ + unsigned(bank_)*256 + offset_, count);
    offset_ += count;
    if (badVerify) data[0] ^= 1;
    return true;
  }
  if (reg == 0x72) { data[0]=fifo.size() >> 8; data[1]=fifo.size(); return true; }
  if (reg == 0x74) {
    if (failTail && fifo.size() == 14) { failTail=false; return false; }
    assert(fifo.size() >= count);
    for (unsigned i=0; i<count; ++i) { data[i]=fifo.front(); fifo.pop_front(); }
    return true;
  }
  memcpy(data, registers_ + reg, count);
  return true;
}
void packet(bool valid=true, bool moving=false) {
  uint8_t b[28]{};
  b[0] = valid ? 0x40 : 0; // Identity quaternion, Q30.
  b[20] = 0x40; // +1g Z in +/-2g range.
  if (moving) b[22] = 0x01;
  fifo.insert(fifo.end(), b, b+28);
}
void tick(Imu& imu, unsigned ms=10) { now += ms; imu.poll(); }
void boot(Imu& imu) {
  assert(imu.begin());
  for (int i=0; i<260 && imu.state()!=Imu::State::Settling; ++i) tick(imu, 5);
  assert(imu.state()==Imu::State::Settling);
  assert(memcmp(memory_, DMP_FIRMWARE, sizeof(DMP_FIRMWARE))==0);
  assert(registers_[0x1B]==0x18 && registers_[0x1C]==0);
  assert(registers_[0x70]==4 && registers_[0x71]==0);
}
int main() {
  Imu imu;
  present=false; assert(!imu.begin() && !imu.active()); present=true;
  badVerify=true; assert(imu.begin());
  for (int i=0; i<45; ++i) tick(imu,5);
  assert(!imu.active()); badVerify=false;
  boot(imu);
  ImuPacket raw; OrientationPacket q;
  for (int i=0; i<1100; ++i) { packet(true,true); tick(imu); }
  assert(!imu.ok() && !imu.read(raw,q)); // Motion blocks startup publishing.
  for (int i=0; i<100; ++i) { packet(); tick(imu); }
  assert(imu.ok() && imu.read(raw,q));
  assert(raw.az==16384 && q.w==1073741824 && q.t_ms==raw.t_ms);
  assert(!imu.read(raw,q)); // Never publish a sample twice.
  fifo.insert(fifo.end(), 10, 0); tick(imu);
  assert(!imu.read(raw,q) && fifo.size()==10); // Partial tail is not consumed.
  fifo.clear();
  const auto before=imu.fifoResets();
  for (int i=0; i<5; ++i) packet();
  tick(imu); assert(imu.fifoResets()==before+1 && fifo.empty());
  packet(); failTail=true; tick(imu);
  assert(fifo.empty() && !imu.read(raw,q));
  packet(); tick(imu); assert(imu.read(raw,q)); // Alignment restored.
  packet(false); tick(imu); assert(!imu.read(raw,q));
  packet(false); tick(imu);
  packet(false); tick(imu); assert(!imu.active());
  boot(imu);
  tick(imu,1001); assert(!imu.active()); // DMP data stopped.
  boot(imu); nack=true;
  tick(imu); tick(imu); tick(imu); assert(!imu.active()); nack=false;
  now=UINT32_MAX-500; boot(imu); // Initialization crosses millis wrap safely.
  for (int i=0; i<1000; ++i) { packet(); tick(imu); }
  assert(imu.ok());
  puts("DMP state, firmware verification, stillness and FIFO recovery tests passed");
}
