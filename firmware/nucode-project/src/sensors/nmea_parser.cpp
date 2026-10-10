#include "nmea_parser.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

namespace {
int hex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}
bool number(const char* text, double low, double high, double& value) {
  if (!*text) return false;
  // NMEA decimal syntax only; reject whitespace, exponent, nan and inf.
  const char* p = text;
  if (*p == '-') ++p;
  bool digit = false, dot = false;
  for (; *p; ++p) {
    if (*p >= '0' && *p <= '9') { digit = true; continue; }
    if (*p == '.' && !dot) { dot = true; continue; }
    return false;
  }
  if (!digit) return false;
  char* end;
  value = strtod(text, &end);
  return !*end && isfinite(value) && value >= low && value <= high;
}
bool coordinate(const char* text, const char* hemi, bool lat, int32_t& out) {
  double value;
  if (strlen(hemi) != 1 || !(lat ? (*hemi == 'N' || *hemi == 'S') : (*hemi == 'E' || *hemi == 'W'))
      || !number(text, 0, lat ? 9000 : 18000, value)) return false;
  const int degrees = (int)(value / 100);
  const double minutes = value - degrees * 100;
  if (minutes >= 60) return false;
  out = (int32_t)llround((degrees + minutes / 60) * 1e7);
  if (*hemi == 'S' || *hemi == 'W') out = -out;
  return true;
}
}
void NmeaParser::feed(char value, uint32_t nowMs) {
  if (value == '$') { collecting_ = true; length_ = 0; }
  if (!collecting_) return;
  if (value == '\r' || value == '\n') {
    buffer_[length_] = 0;
    collecting_ = false;
    parse(nowMs);
  } else if (length_ < sizeof(buffer_) - 1) {
    buffer_[length_++] = value;
  } else {
    collecting_ = false; length_ = 0;
  }
}
void NmeaParser::parse(uint32_t nowMs) {
  char* star = strchr(buffer_, '*');
  if (!star || strlen(star) != 3 || hex(star[1]) < 0 || hex(star[2]) < 0) return;
  uint8_t checksum = 0;
  for (char* p = buffer_ + 1; p < star; ++p) checksum ^= (uint8_t)*p;
  if (checksum != (hex(star[1]) * 16 + hex(star[2]))) return;
  *star = 0;
  char* fields[20] = {buffer_};
  uint8_t count = 1;
  for (char* p = buffer_; *p; ++p) {
    if (*p == ',') {
      if (count == 20) return;
      *p = 0; fields[count++] = p + 1;
    }
  }
  if (strlen(fields[0]) != 6) return;
  const char* type = fields[0] + 3;
  if (!strcmp(type, "GGA") && count >= 11) {
    double quality, satellites, altitude;
    int32_t latitude, longitude;
    if (!number(fields[6], 0, 8, quality) || floor(quality) != quality) return;
    if (quality == 0) { haveFix_ = false; return; }
    // Quality 6 is dead reckoning, 7/8 are manual/simulation, not GNSS fixes.
    if (quality > 5) { haveFix_ = false; return; }
    if (!coordinate(fields[2], fields[3], true, latitude)
        || !coordinate(fields[4], fields[5], false, longitude)
        || !number(fields[7], 0, 99, satellites) || floor(satellites) != satellites
        || !number(fields[9], -10000, 100000, altitude) || strcmp(fields[10], "M")) {
      haveFix_ = false; return;
    }
    latest_.lat_e7 = latitude; latest_.lon_e7 = longitude;
    latest_.alt_cm = (int32_t)lround(altitude * 100);
    latest_.sats = (uint8_t)satellites;
    haveFix_ = true; fixMs_ = nowMs;
  } else if (!strcmp(type, "RMC") && count >= 8) {
    rmcVoid_ = strcmp(fields[2], "A") != 0;
    speedMs_ = nowMs;
    double knots;
    haveSpeed_ = !rmcVoid_ && number(fields[7], 0, 1273, knots);
    latest_.speed_cms = haveSpeed_ ? (uint16_t)lround(knots * 51.444444) : 0;
  }
}
GpsPacket NmeaParser::snapshot(uint32_t nowMs, uint32_t staleMs) const {
  GpsPacket out = latest_;
  out.t_ms = nowMs;
  out.fix = haveFix_ && (uint32_t)(nowMs - fixMs_) < staleMs
      && !(rmcVoid_ && (uint32_t)(nowMs - speedMs_) < staleMs);
  if (!out.fix) { out.lat_e7 = out.lon_e7 = out.alt_cm = 0; out.sats = 0; }
  if (!out.fix || !haveSpeed_ || (uint32_t)(nowMs - speedMs_) >= staleMs) out.speed_cms = 0;
  return out;
}
