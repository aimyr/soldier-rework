#include "gps.h"
#include "config.h"
void Gps::begin() { Serial1.begin(GPS_BAUD); }
void Gps::poll() {
  // Bound each pass even if a module continuously sends garbage.
  for (unsigned i = 0; i < 128 && Serial1.available(); ++i)
    parser_.feed((char)Serial1.read(), millis());
}
void Gps::snapshot(GpsPacket& out) const {
  out = parser_.snapshot(millis(), GPS_STALE_MS);
}
