#pragma once
#include "nmea_parser.h"
class Gps {
public:
  void begin();
  void poll();
  void snapshot(GpsPacket& out) const;
private:
  NmeaParser parser_;
};
