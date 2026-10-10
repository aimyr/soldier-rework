#pragma once
#include "protocol/packets.h"

// Print rate-limited sensor snapshots to USB-UART for debugging.
// Units are explicit; invalid values retain the protocol sentinel values.
namespace SerialTelemetry {
void print(const OrientationPacket& packet);
void print(const ImuPacket& packet);
void print(const VitalsPacket& packet);
void print(const GpsPacket& packet);
}
