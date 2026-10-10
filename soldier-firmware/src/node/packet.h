#pragma once
// Over-the-air packet and advertisement (docs/DATA_SPEC.md sections 2 and 5).
// encode() must match commander-hq/backend/app/protocol.py encode().

#include <math.h>
#include <stdint.h>
#include <string.h>

namespace node {

constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr uint8_t PACKET_SIZE = 18;
constexpr uint8_t ADVERT_SIZE = 25;
constexpr uint16_t COMPANY_ID = 0xFFFF;  // Bluetooth SIG ID for testing / internal use

enum class PacketType : uint8_t { Alert = 0x1, Checkin = 0x2 };

enum class AlertCode : uint8_t {
  None = 0x00,
  HrSpikeImmobile = 0x01,
  HrLowImmobile = 0x02,
  FallImmobile = 0x03,
  HeatStrain = 0x04,
  HazardEnv = 0x05,
  SitrepContact = 0x10,
  SitrepSos = 0x12,
};

// Values sent when a sensor has no valid reading.
constexpr uint8_t HR_UNAVAILABLE = 0;
constexpr int16_t TEMP_UNAVAILABLE = INT16_MIN;

struct NodePacket {
  PacketType type;
  uint8_t soldierId;
  uint16_t seq;
  uint16_t tS;
  AlertCode code;
  uint8_t hrBpm;
  int16_t skinTempCx100;
  uint8_t activity;
  int16_t xDm;
  int16_t yDm;
  uint8_t gas;
  uint8_t hops;
};

// CRC-8, poly 0x07, init 0x00.
inline uint8_t crc8(const uint8_t* data, uint8_t len) {
  uint8_t crc = 0;
  for (uint8_t i = 0; i < len; ++i) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; ++bit)
      crc = (crc & 0x80) ? static_cast<uint8_t>((crc << 1) ^ 0x07) : static_cast<uint8_t>(crc << 1);
  }
  return crc;
}

inline void put16(uint8_t* out, uint16_t value) {
  out[0] = static_cast<uint8_t>(value);
  out[1] = static_cast<uint8_t>(value >> 8);
}

inline void encode(const NodePacket& p, uint8_t out[PACKET_SIZE]) {
  out[0] = static_cast<uint8_t>((PROTOCOL_VERSION << 4) | (static_cast<uint8_t>(p.type) & 0x0F));
  out[1] = p.soldierId;
  put16(out + 2, p.seq);
  put16(out + 4, p.tS);
  out[6] = static_cast<uint8_t>(p.code);
  out[7] = p.hrBpm;
  put16(out + 8, static_cast<uint16_t>(p.skinTempCx100));
  out[10] = p.activity;
  put16(out + 11, static_cast<uint16_t>(p.xDm));
  put16(out + 13, static_cast<uint16_t>(p.yDm));
  out[15] = p.gas;
  out[16] = p.hops;
  out[17] = crc8(out, PACKET_SIZE - 1);
}

// Flags + manufacturer data, ready for the advertising payload.
inline void buildAdvert(const uint8_t packet[PACKET_SIZE], uint8_t out[ADVERT_SIZE]) {
  const uint8_t head[] = {0x02, 0x01, 0x06, 1 + 2 + PACKET_SIZE, 0xFF,
                          static_cast<uint8_t>(COMPANY_ID), static_cast<uint8_t>(COMPANY_ID >> 8)};
  memcpy(out, head, sizeof(head));
  memcpy(out + sizeof(head), packet, PACKET_SIZE);
}

inline uint8_t toByte(float value) {
  if (!(value > 0)) return 0;
  return value >= 255 ? 255 : static_cast<uint8_t>(lroundf(value));
}

inline int16_t toInt16(float value) {
  if (value != value) return 0;  // NaN
  if (value <= -32768) return INT16_MIN;
  if (value >= 32767) return INT16_MAX;
  return static_cast<int16_t>(lroundf(value));
}

}  // namespace node
