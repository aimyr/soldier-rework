#pragma once
#include "protocol/packets.h"

// Send sensor notifications using the onboard RTL8720DF BLE radio.
class BleLink {
public:
  bool begin();
  bool connected() const;
  bool sendOrientation(const OrientationPacket& p);
  bool sendImu(const ImuPacket& p);
  bool sendVitals(const VitalsPacket& p);
  bool sendStatus(const StatusPacket& p);
  uint32_t dropped() const;
  bool sendGps(const GpsPacket& p);
};
