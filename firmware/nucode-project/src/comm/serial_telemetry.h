#pragma once
#include "protocol/packets.h"

// Mirror every published sensor packet to USB CDC, independently of BLE.
// Units are explicit; invalid values retain the protocol sentinel values.
namespace SerialTelemetry {
void print(const ImuPacket& packet);
void print(const VitalsPacket& packet);
void print(const GpsPacket& packet);
void print(const StatusPacket& packet);
}
