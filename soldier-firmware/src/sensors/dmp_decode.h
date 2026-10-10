#pragma once
#include <stdlib.h>
#include "mpu6050_decode.h"
constexpr uint8_t DMP_PACKET_BYTES = 28;
inline int32_t dmpWord(const uint8_t* b) {
  const uint32_t raw = uint32_t(b[0]) << 24 | uint32_t(b[1]) << 16 | uint32_t(b[2]) << 8 | b[3];
  return raw <= INT32_MAX ? int32_t(raw) : int32_t(int64_t(raw) - 4294967296LL);
}
inline bool decodeDmp(const uint8_t* b, uint32_t timestamp, ImuPacket& imu, OrientationPacket& q) {
  q = {timestamp, dmpWord(b), dmpWord(b+4), dmpWord(b+8), dmpWord(b+12)};
  const double scale = 1073741824.0;
  const double w=q.w/scale, x=q.x/scale, y=q.y/scale, z=q.z/scale;
  const double norm = w*w+x*x+y*y+z*z;
  if (norm < 0.9 || norm > 1.1) return false;
  imu = {timestamp, mpuWord(b+16), mpuWord(b+18), mpuWord(b+20),
         mpuWord(b+22), mpuWord(b+24), mpuWord(b+26)};
  return true;
}
// Evidence of stillness, not proof: constant slow rotation can pass this check.
class DmpStillness {
public:
  void reset() { count_ = 0; }
  bool add(const ImuPacket& p) {
    const double a2 = double(p.ax)*p.ax + double(p.ay)*p.ay + double(p.az)*p.az;
    bool quiet = a2 > 0.9*0.9*16384*16384 && a2 < 1.1*1.1*16384*16384
      && abs(int(p.gx)) < 49 && abs(int(p.gy)) < 49 && abs(int(p.gz)) < 49;
    if (count_) quiet = quiet && abs(int(p.ax)-previous_.ax) < 328
       && abs(int(p.ay)-previous_.ay) < 328 && abs(int(p.az)-previous_.az) < 328;
    previous_ = p;
    count_ = quiet ? count_ + (count_ < 100) : 0;
    return count_ >= 100;
  }
private:
  uint16_t count_ = 0;
  ImuPacket previous_{};
};
