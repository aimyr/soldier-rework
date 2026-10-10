#pragma once
#include <stdint.h>
#include "protocol/packets.h"

class NmeaParser {
public:
  void feed(char value, uint32_t nowMs);
  GpsPacket snapshot(uint32_t nowMs, uint32_t staleMs = 3000) const;
private:
  void parse(uint32_t nowMs);
  char buffer_[128]{};
  uint8_t length_ = 0;
  bool collecting_ = false;
  GpsPacket latest_{};
  uint32_t fixMs_ = 0, speedMs_ = 0;
  bool haveFix_ = false, haveSpeed_ = false, rmcVoid_ = false;
};
