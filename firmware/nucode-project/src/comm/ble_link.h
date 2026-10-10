#pragma once
#include "protocol/packets.h"

// Send sensor notifications using the onboard nRF52840 BLE radio.
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
