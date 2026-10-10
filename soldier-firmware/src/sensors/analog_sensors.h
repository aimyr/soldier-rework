#pragma once
#include "protocol/packets.h"

// One FreeRTOS task owns the ADC, so temperature and pulse reads cannot race.
class AnalogSensors {
public:
  bool begin();
  bool snapshot(VitalsPacket& packet, uint32_t& gaps);
};
