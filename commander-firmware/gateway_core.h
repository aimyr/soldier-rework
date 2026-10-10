#pragma once
// Board-independent gateway logic: advertisement parsing, packet validation,
// duplicate suppression and serial line formatting (docs/DATA_SPEC.md).
// No Arduino dependencies, so it is unit-tested natively (test/).

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace gw {

constexpr uint16_t COMPANY_ID = 0xFFFF;  // Bluetooth SIG ID reserved for testing / internal use
constexpr uint8_t PACKET_SIZE = 18;
constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr uint8_t AD_TYPE_MANUFACTURER = 0xFF;

// CRC-8, poly 0x07, init 0x00 (same as backend/app/protocol.py crc8).
inline uint8_t crc8(const uint8_t* data, size_t len) {
  uint8_t crc = 0;
  for (size_t i = 0; i < len; ++i) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; ++bit)
      crc = (crc & 0x80) ? static_cast<uint8_t>((crc << 1) ^ 0x07) : static_cast<uint8_t>(crc << 1);
  }
  return crc;
}

// Version nibble and CRC match. Length is fixed by the caller.
inline bool packetValid(const uint8_t* p) {
  return (p[0] >> 4) == PROTOCOL_VERSION && crc8(p, PACKET_SIZE - 1) == p[PACKET_SIZE - 1];
}

// Walks the AD structures of one advertisement. Copies the first valid
// packet found in manufacturer data with our company ID into out.
// Bounds-checked: input comes from any device in radio range.
inline bool extractPacket(const uint8_t* ad, size_t len, uint8_t out[PACKET_SIZE]) {
  size_t pos = 0;
  while (pos < len) {
    const uint8_t field = ad[pos];         // length of type + value
    if (field == 0) break;                 // zero length marks early end of data
    if (pos + 1 + field > len) break;      // truncated structure
    const uint8_t type = ad[pos + 1];
    const uint8_t* value = ad + pos + 2;
    const size_t valueLen = field - 1;
    if (type == AD_TYPE_MANUFACTURER && valueLen == 2u + PACKET_SIZE
        && static_cast<uint16_t>(value[0] | (value[1] << 8)) == COMPANY_ID
        && packetValid(value + 2)) {
      memcpy(out, value + 2, PACKET_SIZE);
      return true;
    }
    pos += 1 + field;
  }
  return false;
}

inline uint8_t soldierId(const uint8_t* p) { return p[1]; }
inline uint16_t sequence(const uint8_t* p) { return static_cast<uint16_t>(p[2] | (p[3] << 8)); }

// Nodes repeat each packet in a short advertising burst, and relays forward
// copies with a different hop count. The backend does not deduplicate, so
// only the first copy of each (soldier_id, seq) is forwarded.
class Deduper {
public:
  static constexpr uint32_t WINDOW_MS = 30000;
  static constexpr uint8_t HISTORY = 4;  // recent seqs per soldier; covers late relayed copies

  // True if this packet has not been forwarded within the window.
  bool accept(uint8_t sid, uint16_t seq, uint32_t nowMs) {
    Recent* recent = history_[sid];
    for (uint8_t i = 0; i < HISTORY; ++i) {
      if (recent[i].used && recent[i].seq == seq && static_cast<uint32_t>(nowMs - recent[i].atMs) < WINDOW_MS)
        return false;
    }
    recent[next_[sid]] = Recent{seq, nowMs, true};
    next_[sid] = static_cast<uint8_t>((next_[sid] + 1) % HISTORY);
    return true;
  }

private:
  struct Recent { uint16_t seq; uint32_t atMs; bool used; };
  Recent history_[256][HISTORY] = {};
  uint8_t next_[256] = {};
};

// "PKT:<36 hex>,RSSI:<dBm>" without line ending. Returns characters written.
// Size: "PKT:" + hex + ",RSSI:" + "-128" + NUL.
constexpr size_t LINE_SIZE = 4 + PACKET_SIZE * 2 + 6 + 4 + 1;
inline int formatLine(char* line, size_t size, const uint8_t* p, int8_t rssi) {
  static const char hex[] = "0123456789abcdef";
  if (size < LINE_SIZE) return -1;
  memcpy(line, "PKT:", 4);
  char* out = line + 4;
  for (uint8_t i = 0; i < PACKET_SIZE; ++i) {
    *out++ = hex[p[i] >> 4];
    *out++ = hex[p[i] & 0x0F];
  }
  const int tail = snprintf(out, size - (out - line), ",RSSI:%d", rssi);
  return tail < 0 ? -1 : static_cast<int>(out - line) + tail;
}

}  // namespace gw
