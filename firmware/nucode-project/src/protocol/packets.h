#pragma once
#include <stdint.h>

// BLE packet definitions. All fields are little-endian, with no padding.
// Keep these definitions synchronized with the PC decoder in tools/protocol.py.

// IMU packet (16 bytes)
//  accel: ±4 g  -> 8192 LSB/g,  gyro: ±500 dps -> 65.5 LSB/(deg/s)
struct __attribute__((packed)) ImuPacket {
  uint32_t t_ms;
  int16_t  ax, ay, az;
  int16_t  gx, gy, gz;
};

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

// Status v2, 16 bytes. Flags: bit0 IMU online, bit1 analog task ready,
// bit2 temperature valid, bit3 BPM available, bit4 GPS fix, bit5 GPS enabled.
struct __attribute__((packed)) StatusPacket {
  uint32_t t_ms;
  uint16_t version;
  uint16_t flags;
  uint32_t tx_dropped;
  uint32_t sample_gaps;
};
static_assert(sizeof(StatusPacket) == 16, "StatusPacket size");
