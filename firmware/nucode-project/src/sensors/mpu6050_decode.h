#pragma once
#include "protocol/packets.h"

inline int16_t mpuWord(const uint8_t* p) {
  const uint16_t raw = (uint16_t(p[0]) << 8) | p[1];
  return raw < 0x8000 ? int16_t(raw) : int16_t(int32_t(raw) - 65536);
}
// MPU register order is big-endian accel, temperature, gyro. The wire protocol
// is little-endian and deliberately excludes the IMU's internal temperature.
inline ImuPacket decodeMpu6050(const uint8_t* bytes, uint32_t timestamp) {
  return {timestamp, mpuWord(bytes), mpuWord(bytes + 2), mpuWord(bytes + 4),
          mpuWord(bytes + 8), mpuWord(bytes + 10), mpuWord(bytes + 12)};
}
