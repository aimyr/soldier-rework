#pragma once
#include <stdint.h>

// Internal sensor snapshots passed between drivers, node logic and serial
// telemetry. Not transmitted; the radio packet is node/packet.h.

// IMU packet (16 bytes)
//  accel: ±2 g -> 16384 LSB/g, gyro: ±2000 dps -> 16.4 LSB/(deg/s)
struct __attribute__((packed)) ImuPacket {
  uint32_t t_ms;
  int16_t  ax, ay, az;
  int16_t  gx, gy, gz;
};

// DMP quaternion: signed Q30, w/x/y/z order. Divide by 2^30.
struct __attribute__((packed)) OrientationPacket {
  uint32_t t_ms;
  int32_t w, x, y, z;
};
static_assert(sizeof(OrientationPacket) == 20, "OrientationPacket size");

// Vitals packet (10 bytes)
struct __attribute__((packed)) VitalsPacket {
  uint32_t t_ms;
  int16_t  temp_c_x100;  // Celsius * 100; INT16_MIN = invalid/not ready
  uint16_t bpm;          // 0 = unavailable
  uint16_t pulse_raw;    // 0..4095 (12bit)
};

static_assert(sizeof(ImuPacket) == 16, "ImuPacket size");
static_assert(sizeof(VitalsPacket) == 10, "VitalsPacket size");

// GPS packet (20 bytes), 1 Hz
struct __attribute__((packed)) GpsPacket {
  uint32_t t_ms;
  int32_t  lat_e7;     // Latitude * 1e7 (negative south)
  int32_t  lon_e7;     // Longitude * 1e7 (negative west)
  int32_t  alt_cm;     // Altitude above mean sea level, cm
  uint16_t speed_cms;  // Ground speed, cm/s
  uint8_t  fix;        // 0 = unavailable, 1 = valid fix
  uint8_t  sats;       // Number of satellites used
};
static_assert(sizeof(GpsPacket) == 20, "GpsPacket size");
