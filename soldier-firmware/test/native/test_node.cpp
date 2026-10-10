// Native tests for src/node. Run by tools/test.sh.
// With --encode, --rules or --pdr the binary instead reads inputs from stdin
// and prints results, so test/test_node_parity.py can compare it line by line
// with the Python reference in commander-hq/backend.

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "node/motion.h"
#include "node/packet.h"
#include "node/position.h"
#include "node/rules.h"
#include "node/schedule.h"

using namespace node;

namespace {
int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); ++failures; } } while (0)
bool near(float a, float b, float tolerance = 1e-3f) { return fabsf(a - b) <= tolerance; }
constexpr float PI = 3.14159265f;

void testEncode() {
  // docs/DATA_SPEC.md example.
  const NodePacket p{PacketType::Alert, 3, 7, 2000, AlertCode::HrSpikeImmobile, 141, 3456, 2, 1234, -56, 12, 1};
  uint8_t out[PACKET_SIZE];
  encode(p, out);
  const uint8_t expected[PACKET_SIZE] = {0x11, 0x03, 0x07, 0x00, 0xd0, 0x07, 0x01, 0x8d, 0x80,
                                         0x0d, 0x02, 0xd2, 0x04, 0xc8, 0xff, 0x0c, 0x01, 0x47};
  CHECK(memcmp(out, expected, PACKET_SIZE) == 0);

  uint8_t advert[ADVERT_SIZE];
  buildAdvert(out, advert);
  const uint8_t head[] = {0x02, 0x01, 0x06, 0x15, 0xff, 0xff, 0xff};
  CHECK(memcmp(advert, head, sizeof(head)) == 0);
  CHECK(memcmp(advert + sizeof(head), out, PACKET_SIZE) == 0);
}

void testClamps() {
  CHECK(toByte(-3) == 0 && toByte(254.6f) == 255 && toByte(999) == 255 && toByte(NAN) == 0);
  CHECK(toInt16(40000) == INT16_MAX && toInt16(-40000) == INT16_MIN && toInt16(-12.6f) == -13 && toInt16(NAN) == 0);
}

void testActivity() {
  ActivityMeter meter;
  for (int i = 0; i < 10; ++i) meter.add(0, 0, 16384);
  ActivityMeter::Second s = meter.roll();
  CHECK(!s.valid);                                   // too few samples
  for (int i = 0; i < 50; ++i) meter.add(0, 0, 16384);
  s = meter.roll();
  CHECK(s.valid && near(s.activity, 0) && near(s.peakG, 1) && !s.saturated);
  for (int i = 0; i < 60; ++i) meter.add(0, 0, 18022);  // 1.1g
  s = meter.roll();                                  // window: 60 still + 60 moving... previous second had 50 still
  CHECK(s.valid && near(s.activity, 255 * 0.1f * 60 / 110, 0.05f));
  for (int i = 0; i < 60; ++i) meter.add(0, 0, 18022);
  s = meter.roll();
  CHECK(near(s.activity, 25.5f, 0.05f));
  meter.add(INT16_MAX, 0, 0);
  CHECK(meter.roll().saturated);
  meter.add(0, INT16_MIN, 0);
  CHECK(meter.roll().saturated);
  for (int i = 0; i < 100; ++i) meter.add(0, 0, -32000);  // ~-1.95g: still 1.95g magnitude, not saturated
  s = meter.roll();
  CHECK(!s.saturated && near(s.peakG, 1.953f, 0.01f));
}

void testHeading() {
  const int32_t one = 1073741824, half = 759250125;  // cos(45deg) in Q30
  CHECK(near(headingFromQuaternion(OrientationPacket{0, one, 0, 0, 0}), 0));
  // Yaw +90deg (counter-clockwise, turned left) is heading -90deg.
  CHECK(near(headingFromQuaternion(OrientationPacket{0, half, 0, 0, half}), -PI / 2));
}

void walk(Pdr& pdr, uint32_t& tMs, int steps, float heading) {
  for (int i = 0; i < steps; ++i) {
    pdr.update(tMs, 0.9f, heading);
    pdr.update(tMs + 100, 1.3f, heading);
    tMs += 500;
  }
}

void testPdr() {
  Pdr pdr;
  uint32_t t = 1000;
  walk(pdr, t, 4, 0);
  const float stride = Pdr::WEINBERG_K * sqrtf(sqrtf(0.4f));
  CHECK(pdr.steps() == 4 && near(pdr.y(), 4 * stride));
  CHECK(near(pdr.x(), 0));
  const float y = pdr.y();
  walk(pdr, t, 2, -PI / 2);  // west
  CHECK(pdr.x() < -1 && near(pdr.y(), y));

  Pdr fast;
  CHECK(fast.update(0, 1.3f, 0));
  CHECK(!fast.update(50, 0.9f, 0));
  CHECK(!fast.update(100, 1.3f, 0));  // within 300 ms: ignored
  CHECK(fast.steps() == 1);
}

GeoFix fixAt(float northM, float eastM, int32_t lat0 = 520000000, int32_t lon0 = 134000000) {
  const float cosLat = cosf(lat0 * 1e-7f * PI / 180);
  return GeoFix{true, lat0 + int32_t(lroundf(northM / PositionFusion::METRES_PER_DEGREE * 1e7f)),
                lon0 + int32_t(lroundf(eastM / (PositionFusion::METRES_PER_DEGREE * cosLat) * 1e7f))};
}

void testPosition() {
  const GeoFix none{false, 0, 0};
  PositionFusion pos;
  pos.update(none, 3, 4);  // before any fix: PDR frame
  CHECK(near(pos.x(), 3) && near(pos.y(), 4) && !pos.usingGps());

  pos.update(fixAt(0, 0), 3, 4);  // first fix placed at the current estimate: no jump
  CHECK(near(pos.x(), 3, 0.05f) && near(pos.y(), 4, 0.05f) && pos.usingGps());
  pos.update(fixAt(10, 0), 3, 4);  // GPS moved 10 m north
  CHECK(near(pos.x(), 3, 0.05f) && near(pos.y(), 14, 0.05f));
  pos.update(none, 5, 4);  // GPS lost: continue from the last fix by the PDR change
  CHECK(!pos.usingGps() && near(pos.x(), 5, 0.05f) && near(pos.y(), 14, 0.05f));

  // Soldier started facing east: PDR "forward" (+y) is really east. GPS shows
  // a 20 m walk east while PDR shows 20 m forward, so the offset is 90deg.
  PositionFusion turned;
  turned.update(fixAt(0, 0), 0, 0);
  turned.update(fixAt(0, 20), 0, 20);
  CHECK(turned.headingCalibrated() && near(turned.x(), 20, 0.05f) && near(turned.y(), 0, 0.05f));
  turned.update(none, 0, 30);  // GPS lost; 10 m more "forward" is 10 m east
  CHECK(near(turned.x(), 30, 0.05f) && near(turned.y(), 0, 0.05f));

  PositionFusion ao;  // fixed area-of-operations origin
  ao.setOrigin(520000000, 134000000);
  ao.update(none, 50, 50);
  ao.update(fixAt(100, -20), 50, 50);
  CHECK(near(ao.x(), -20, 0.05f) && near(ao.y(), 100, 0.05f));

  PositionFusion still;  // GPS jitter without walking does not set a heading
  still.update(fixAt(0, 0), 0, 0);
  still.update(fixAt(16, 0), 0, 1);
  CHECK(!still.headingCalibrated());
}

void testSchedule() {
  Baseline b;
  for (uint32_t t = 0; t < 19; ++t) b.add(t, true, 70, true, 33.5f);
  CHECK(!b.done());
  b.add(19, true, 72, true, 33.5f);
  CHECK(b.done() && b.hrValid() && near(b.hrBpm(), 70.1f) && near(b.skinTempC(), 33.5f));

  Baseline partial;  // no pulse contact: completes on timeout, HR baseline invalid
  for (uint32_t t = 0; t <= Baseline::BASELINE_TIMEOUT_S; ++t) partial.add(t, false, 0, t % 2 == 0, 34);
  CHECK(partial.done() && !partial.hrValid() && partial.tempValid());

  CheckinTimer c;
  CHECK(!c.due(5));
  c.start(5);
  CHECK(c.due(5));
  c.schedule(5, -30);
  CHECK(!c.due(94) && c.due(95));
  c.schedule(UINT32_MAX - 10, 0);  // seconds counter wrap
  CHECK(!c.due(UINT32_MAX) && c.due(CHECKIN_PERIOD_S - 11));
}

RuleSample still(uint32_t t, float hr) {
  return RuleSample{t, true, hr, true, 33.5f, 1.0f, true, 2, 0, AlertCode::None};
}

void testRules() {
  NodeRules noPulse;  // HR 0 = no reading: must not look like a low heart rate
  noPulse.setBaseline(false, 0, true, 33.5f);
  for (uint32_t t = 0; t < 30; ++t) {
    RuleSample s = still(t, 0);
    s.hrValid = false;
    CHECK(noPulse.evaluate(s) == AlertCode::None);
  }

  NodeRules noImu;  // unknown activity is not immobility
  noImu.setBaseline(true, 70, true, 33.5f);
  for (uint32_t t = 0; t < 30; ++t) {
    RuleSample s = still(t, 30);
    s.activityValid = false;
    CHECK(noImu.evaluate(s) == AlertCode::None);
  }

  NodeRules noBaseline;  // HR spike needs a baseline
  for (uint32_t t = 0; t < 30; ++t) CHECK(noBaseline.evaluate(still(t, 150)) == AlertCode::None);

  NodeRules fall;
  fall.setBaseline(true, 70, true, 33.5f);
  RuleSample hit = still(0, 80);
  hit.accelPeakG = 3;
  CHECK(fall.evaluate(hit) == AlertCode::None);
  AlertCode code = AlertCode::None;
  uint32_t t = 1;
  for (; t <= 10 && code == AlertCode::None; ++t) code = fall.evaluate(still(t, 80));
  CHECK(code == AlertCode::FallImmobile && t - 1 == 10);
  CHECK(fall.evaluate(still(11, 80)) == AlertCode::None);  // 60 s cooldown
  CHECK(fall.evaluate(still(70, 80)) == AlertCode::FallImmobile);
}

// ---- parity modes -----------------------------------------------------------

int emitEncode() {
  long f[12];
  while (scanf("%ld %ld %ld %ld %ld %ld %ld %ld %ld %ld %ld %ld",
               &f[0], &f[1], &f[2], &f[3], &f[4], &f[5], &f[6], &f[7], &f[8], &f[9], &f[10], &f[11]) == 12) {
    const NodePacket p{PacketType(f[0]), uint8_t(f[1]), uint16_t(f[2]), uint16_t(f[3]), AlertCode(f[4]),
                       uint8_t(f[5]), int16_t(f[6]), uint8_t(f[7]), int16_t(f[8]), int16_t(f[9]),
                       uint8_t(f[10]), uint8_t(f[11])};
    uint8_t out[PACKET_SIZE];
    encode(p, out);
    for (uint8_t b : out) printf("%02x", b);
    printf("\n");
  }
  return 0;
}

int emitRules(float restingHr, float restingTemp) {
  NodeRules rules;
  rules.setBaseline(true, restingHr, true, restingTemp);
  unsigned long t;
  float hr, temp, accel, activity, gas;
  while (scanf("%lu %f %f %f %f %f", &t, &hr, &temp, &accel, &activity, &gas) == 6) {
    const RuleSample s{uint32_t(t), true, hr, true, temp, accel, true, activity, gas, AlertCode::None};
    printf("%d\n", int(rules.evaluate(s)));
  }
  return 0;
}

int emitPdr() {
  Pdr pdr;
  unsigned long t;
  float accel, heading;
  while (scanf("%lu %f %f", &t, &accel, &heading) == 3) {
    pdr.update(uint32_t(t), accel, heading);
    printf("%.6f %.6f %lu\n", pdr.x(), pdr.y(), (unsigned long)pdr.steps());
  }
  return 0;
}
}  // namespace

int main(int argc, char** argv) {
  if (argc > 1 && strcmp(argv[1], "--encode") == 0) return emitEncode();
  if (argc > 3 && strcmp(argv[1], "--rules") == 0) return emitRules(strtof(argv[2], nullptr), strtof(argv[3], nullptr));
  if (argc > 1 && strcmp(argv[1], "--pdr") == 0) return emitPdr();
  testEncode();
  testClamps();
  testActivity();
  testHeading();
  testPdr();
  testPosition();
  testSchedule();
  testRules();
  if (failures) return 1;
  puts("node: all tests passed");
  return 0;
}
