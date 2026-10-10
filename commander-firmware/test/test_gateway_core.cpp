// Native tests for gateway_core.h. Run with test/run.sh.
// Packet vectors were produced by commander-hq/backend/app/protocol.py encode().
// With --emit, prints gateway lines instead so run.sh can feed them to the backend parser.

#include "../gateway_core.h"
#include <stdlib.h>
#include <string.h>

namespace {
int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); ++failures; } } while (0)

// DATA_SPEC.md example: S3, seq 7, HR_SPIKE_IMMOBILE, 1 hop.
const uint8_t SPEC_PACKET[gw::PACKET_SIZE] = {
  0x11, 0x03, 0x07, 0x00, 0xd0, 0x07, 0x01, 0x8d, 0x80, 0x0d, 0x02, 0xd2, 0x04, 0xc8, 0xff, 0x0c, 0x01, 0x47};
// Check-in, soldier 255, seq 65535, negative temperature and x, max y.
const uint8_t EDGE_PACKET[gw::PACKET_SIZE] = {
  0x12, 0xff, 0xff, 0xff, 0x78, 0x00, 0x00, 0x3e, 0x6a, 0xff, 0x03, 0xff, 0xff, 0xff, 0x7f, 0x00, 0x00, 0x12};

// Flags + manufacturer data, as a soldier node advertises it.
size_t advert(uint8_t* out, const uint8_t* packet, uint16_t company = gw::COMPANY_ID) {
  const uint8_t head[] = {0x02, 0x01, 0x06, 2 + 1 + gw::PACKET_SIZE, gw::AD_TYPE_MANUFACTURER,
                          static_cast<uint8_t>(company), static_cast<uint8_t>(company >> 8)};
  memcpy(out, head, sizeof(head));
  memcpy(out + sizeof(head), packet, gw::PACKET_SIZE);
  return sizeof(head) + gw::PACKET_SIZE;
}

void testCrc() {
  CHECK(gw::crc8(SPEC_PACKET, gw::PACKET_SIZE - 1) == 0x47);
  CHECK(gw::crc8(EDGE_PACKET, gw::PACKET_SIZE - 1) == 0x12);
  CHECK(gw::packetValid(SPEC_PACKET));
}

void testExtract() {
  uint8_t ad[31], out[gw::PACKET_SIZE];
  size_t len = advert(ad, SPEC_PACKET);
  CHECK(len == 25);  // fits a legacy 31-byte advertisement
  CHECK(gw::extractPacket(ad, len, out));
  CHECK(memcmp(out, SPEC_PACKET, gw::PACKET_SIZE) == 0);
  CHECK(gw::soldierId(out) == 3 && gw::sequence(out) == 7);

  // Manufacturer data first, then a name: still found.
  uint8_t reordered[31];
  memcpy(reordered, ad + 3, len - 3);
  const uint8_t name[] = {0x03, 0x09, 'S', '3'};
  memcpy(reordered + len - 3, name, sizeof(name));
  CHECK(gw::extractPacket(reordered, len - 3 + sizeof(name), out));

  len = advert(ad, SPEC_PACKET, 0x004C);  // another company's data
  CHECK(!gw::extractPacket(ad, len, out));

  uint8_t corrupt[gw::PACKET_SIZE];
  memcpy(corrupt, SPEC_PACKET, sizeof(corrupt));
  corrupt[7] ^= 0x01;
  len = advert(ad, corrupt);
  CHECK(!gw::extractPacket(ad, len, out));

  memcpy(corrupt, SPEC_PACKET, sizeof(corrupt));
  corrupt[0] = 0x21;  // version 2
  corrupt[gw::PACKET_SIZE - 1] = gw::crc8(corrupt, gw::PACKET_SIZE - 1);
  len = advert(ad, corrupt);
  CHECK(!gw::extractPacket(ad, len, out));
}

void testMalformedAdverts() {
  uint8_t ad[31], out[gw::PACKET_SIZE];
  const size_t len = advert(ad, SPEC_PACKET);
  for (size_t cut = 0; cut < len; ++cut) CHECK(!gw::extractPacket(ad, cut, out));  // truncated
  const uint8_t overlong[] = {0x1e, 0xff, 0xff, 0xff};  // claims 30 bytes, has 3
  CHECK(!gw::extractPacket(overlong, sizeof(overlong), out));
  const uint8_t shortMsd[] = {0x02, 0xff, 0xff};  // too short for a company ID
  CHECK(!gw::extractPacket(shortMsd, sizeof(shortMsd), out));
  const uint8_t zeros[31] = {};
  CHECK(!gw::extractPacket(zeros, sizeof(zeros), out));
  CHECK(!gw::extractPacket(nullptr, 0, out));
  // Every length byte value in the first structure must stay in bounds (ASan checks reads).
  for (int field = 0; field < 256; ++field) {
    uint8_t probe[31] = {};
    probe[0] = static_cast<uint8_t>(field);
    probe[1] = gw::AD_TYPE_MANUFACTURER;
    gw::extractPacket(probe, sizeof(probe), out);
  }
}

void testDedupe() {
  gw::Deduper d;
  CHECK(d.accept(3, 7, 1000));
  CHECK(!d.accept(3, 7, 1100));    // burst repeat
  CHECK(!d.accept(3, 7, 1400));
  CHECK(d.accept(4, 7, 1100));     // other soldier, same seq
  CHECK(d.accept(3, 8, 2000));     // next packet
  CHECK(!d.accept(3, 7, 2100));    // late relayed copy of the previous packet
  CHECK(d.accept(3, 7, 1000 + gw::Deduper::WINDOW_MS));  // window expired (node rebooted, seq reused)

  gw::Deduper wrap;  // millis() wraps after ~49.7 days
  CHECK(wrap.accept(1, 1, 0xFFFFFF00u));
  CHECK(!wrap.accept(1, 1, 0x00000010u));

  gw::Deduper history;  // only the last HISTORY seqs are remembered
  for (uint16_t seq = 0; seq <= gw::Deduper::HISTORY; ++seq) CHECK(history.accept(9, seq, 100));
  CHECK(history.accept(9, 0, 100));
  CHECK(!history.accept(9, gw::Deduper::HISTORY, 100));
}

void testFormat() {
  char line[gw::LINE_SIZE];
  CHECK(gw::formatLine(line, sizeof(line), SPEC_PACKET, -63) == 49);
  CHECK(strcmp(line, "PKT:11030700d007018d800d02d204c8ff0c0147,RSSI:-63") == 0);
  CHECK(gw::formatLine(line, sizeof(line), EDGE_PACKET, -128) == 50);  // longest line fits
  CHECK(strcmp(line, "PKT:12ffffff7800003e6aff03ffffff7f000012,RSSI:-128") == 0);
  CHECK(gw::formatLine(line, sizeof(line) - 1, SPEC_PACKET, 0) == -1);
}
}  // namespace

int main(int argc, char** argv) {
  if (argc > 1 && strcmp(argv[1], "--emit") == 0) {
    char line[gw::LINE_SIZE];
    gw::formatLine(line, sizeof(line), SPEC_PACKET, -63);
    puts(line);
    gw::formatLine(line, sizeof(line), EDGE_PACKET, -128);
    puts(line);
    return 0;
  }
  testCrc();
  testExtract();
  testMalformedAdverts();
  testDedupe();
  testFormat();
  if (failures) return 1;
  puts("gateway_core: all tests passed");
  return 0;
}
