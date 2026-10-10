#pragma once
#include "protocol/packets.h"

// 내장 BLE(nRF52840)로 센서 데이터를 notify 한다.
class BleLink {
public:
  bool begin();
  bool connected() const;
  bool sendImu(const ImuPacket& p);
  bool sendVitals(const VitalsPacket& p);
  bool sendStatus(const StatusPacket& p);
  uint32_t dropped() const;
  bool sendGps(const GpsPacket& p);
};
