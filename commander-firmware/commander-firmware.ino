// Commander-side gateway on a NUCODE NU-87 Tiny DK (RTL8720DF).
// Passively scans BLE advertisements from soldier nodes and prints each new
// packet for the backend (docs/DATA_SPEC.md section 6):  PKT:<hex>,RSSI:<dBm>
// The gateway never transmits.

#include "BLEDevice.h"
#include <FreeRTOS.h>
#include <queue.h>
#include <atomic>
#include "gateway_core.h"

namespace {
constexpr uint32_t SERIAL_BAUD = 115200;        // backend C2_SERIAL_BAUD default
constexpr uint16_t SCAN_INTERVAL_MS = 100;      // window == interval: listen continuously
constexpr uint32_t STATS_PERIOD_MS = 10000;
constexpr uint8_t LED_RED = 2, LED_GREEN = 3, LED_BLUE = 1;  // NU-87 onboard RGB, active-high

struct Received { uint8_t packet[gw::PACKET_SIZE]; int8_t rssi; };
QueueHandle_t received = nullptr;
gw::Deduper deduper;

// Written by the BLE task, read by loop().
std::atomic<uint32_t> advertsSeen{0}, queueDrops{0};
uint32_t forwarded = 0, duplicates = 0;

// Runs in the BLE stack task: validate, copy, and hand off. No printing here.
void onScan(T_LE_CB_DATA* data) {
  const T_LE_SCAN_INFO* info = data->p_le_scan_info;
  ++advertsSeen;
  Received item;
  if (!gw::extractPacket(info->data, info->data_len, item.packet)) return;
  item.rssi = info->rssi;
  if (xQueueSendToBack(received, &item, 0) != pdPASS) ++queueDrops;
}

void led(bool r, bool g, bool b) {
  digitalWrite(LED_RED, r);
  digitalWrite(LED_GREEN, g);
  digitalWrite(LED_BLUE, b);
}
}  // namespace

void setup() {
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_BLUE, OUTPUT);
  led(false, false, true);  // blue: starting BLE
  Serial.begin(SERIAL_BAUD);
  received = xQueueCreate(32, sizeof(Received));
  if (!received) {
    Serial.println("GW,error=queue");
    led(true, false, false);
    for (;;) delay(1000);
  }
  BLE.init();
  BLEScan* scan = BLE.configScan();
  scan->setScanMode(GAP_SCAN_MODE_PASSIVE);
  scan->setScanInterval(SCAN_INTERVAL_MS);
  scan->setScanWindow(SCAN_INTERVAL_MS);
  // Controller duplicate filtering may hide new packets from an address it has
  // already reported; duplicates are removed per (soldier_id, seq) instead.
  scan->setScanDuplicateFilter(false);
  BLE.setScanCallback(onScan);
  BLE.beginCentral(0);  // scan only, no connections
  scan->startScan();
  Serial.println("GW,ready");
  led(false, false, false);
}

void loop() {
  static uint32_t lastStats = 0, flashUntil = 0;
  const uint32_t now = millis();
  Received item;
  while (xQueueReceive(received, &item, 0) == pdPASS) {
    if (!deduper.accept(gw::soldierId(item.packet), gw::sequence(item.packet), now)) {
      ++duplicates;
      continue;
    }
    char line[gw::LINE_SIZE];
    if (gw::formatLine(line, sizeof(line), item.packet, item.rssi) > 0) {
      Serial.println(line);
      ++forwarded;
      flashUntil = now + 50;
    }
  }
  if (now - lastStats >= STATS_PERIOD_MS) {
    lastStats = now;
    // The backend ignores non-PKT lines. adverts>0 shows the scanner is alive
    // whenever any BLE device is in range.
    Serial.print("GW,uptime_s="); Serial.print(now / 1000);
    Serial.print(",adverts="); Serial.print(advertsSeen.load());
    Serial.print(",forwarded="); Serial.print(forwarded);
    Serial.print(",duplicates="); Serial.print(duplicates);
    Serial.print(",queue_drops="); Serial.println(queueDrops.load());
  }
  // Blue flash per forwarded packet, otherwise a short green pulse every 2 s.
  if (static_cast<int32_t>(flashUntil - now) > 0) led(false, false, true);
  else led(false, now % 2000 < 40, false);
  delay(5);
}
