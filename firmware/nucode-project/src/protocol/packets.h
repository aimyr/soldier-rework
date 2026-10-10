#pragma once
#include <stdint.h>

// BLE로 전송하는 패킷 정의. 모든 값은 little-endian, 패딩 없음.
// PC 쪽 파서(tools/ble_receiver.py)와 반드시 같이 수정할 것.

// IMU 패킷 (16 bytes)
//  accel: ±4 g  -> 0.122 mg/LSB,  gyro: ±500 dps -> 17.5 mdps/LSB
struct __attribute__((packed)) ImuPacket {
  uint32_t t_ms;
  int16_t  ax, ay, az;
  int16_t  gx, gy, gz;
};

// Vitals 패킷 (10 bytes)
struct __attribute__((packed)) VitalsPacket {
  uint32_t t_ms;
  int16_t  temp_c_x100;  // Celsius * 100; INT16_MIN = invalid/not ready
  uint16_t bpm;          // 0 = 측정 불가
  uint16_t pulse_raw;    // 0..4095 (12bit)
};

static_assert(sizeof(ImuPacket) == 16, "ImuPacket size");
static_assert(sizeof(VitalsPacket) == 10, "VitalsPacket size");

// GPS 패킷 (20 bytes), 1 Hz
struct __attribute__((packed)) GpsPacket {
  uint32_t t_ms;
  int32_t  lat_e7;     // 위도 * 1e7 (남위 음수)
  int32_t  lon_e7;     // 경도 * 1e7 (서경 음수)
  int32_t  alt_cm;     // 해발고도 cm
  uint16_t speed_cms;  // 지상속도 cm/s
  uint8_t  fix;        // 0 = 미수신, 1 = 2D/3D fix
  uint8_t  sats;       // 사용 위성 수
};
static_assert(sizeof(GpsPacket) == 20, "GpsPacket size");

// Status v1, 16 bytes. Flags: bit0 IMU online, bit1 analog task ready,
// bit2 temperature valid, bit3 BPM available, bit4 GPS fix, bit5 GPS enabled.
struct __attribute__((packed)) StatusPacket {
  uint32_t t_ms;
  uint16_t version;
  uint16_t flags;
  uint32_t tx_dropped;
  uint32_t sample_gaps;
};
static_assert(sizeof(StatusPacket) == 16, "StatusPacket size");
