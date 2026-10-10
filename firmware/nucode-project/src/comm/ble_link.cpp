#include "ble_link.h"
#include <bluefruit.h>
#include <atomic>
#include <queue.h>
#include <task.h>
#include <string.h>
#include "config.h"
#include "core/log.h"
#include "protocol/uuids.h"

namespace {
BLEService        svc(UUID_SERVICE);
BLECharacteristic chImu(UUID_IMU);
BLECharacteristic chVitals(UUID_VITALS);
BLECharacteristic chGps(UUID_GPS);
BLECharacteristic chStatus(UUID_STATUS);

struct Pending {
  BLECharacteristic* characteristic;
  uint32_t queuedMs;
  uint32_t generation;
  uint16_t connection;
  uint8_t length;
  uint8_t data[20];
};
QueueHandle_t pending = nullptr;
std::atomic<uint32_t> dropped{0};
std::atomic<uint32_t> generation{0};
void transmit(void*) {
  Pending packet;
  for (;;) {
    if (xQueueReceive(pending, &packet, portMAX_DELAY) != pdPASS) continue;
    if (!Bluefruit.connected() || packet.generation != generation.load()
        || packet.connection != Bluefruit.connHandle()
        || (uint32_t)(millis() - packet.queuedMs) > 500) {
      ++dropped; continue;
    }
    if (!packet.characteristic->notifyEnabled(packet.connection)) continue;
    if (!packet.characteristic->notify(packet.connection, packet.data, packet.length)) ++dropped;
  }
}
bool enqueue(BLECharacteristic& characteristic, const void* data, uint8_t length) {
  if (!pending || !Bluefruit.connected() || !characteristic.notifyEnabled()) return false;
  Pending packet{&characteristic, millis(), generation.load(), Bluefruit.connHandle(), length, {0}};
  memcpy(packet.data, data, length);
  if (xQueueSend(pending, &packet, 0) == pdPASS) return true;
  ++dropped; // Bounded memory, never block acquisition when the PC is slow.
  return false;
}

void onConnect(uint16_t)               { LOG("[ble] connected\n"); }
void onDisconnect(uint16_t, uint8_t r) { ++generation; LOG("[ble] disconnected (0x%02X)\n", r); }
}  // namespace

bool BleLink::begin() {
  // Every packet fits the mandatory MTU. Reserve a short event and enough
  // notifications to batch the 50Hz stream at 30-50ms connection intervals.
  Bluefruit.configPrphConn(23, 6, 8, 1);
  if (!Bluefruit.begin()) return false;
  if (!Bluefruit.Periph.setConnInterval(BLE_CONN_MIN_UNITS, BLE_CONN_MAX_UNITS)) return false;
  Bluefruit.autoConnLed(false);
  ledOff(LED_CONN);
  if (!Bluefruit.setTxPower(BLE_TX_POWER_DBM)) return false;
  Bluefruit.setName(BLE_DEVICE_NAME);
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);

  if (svc.begin() != ERROR_NONE) return false;

  chImu.setProperties(CHR_PROPS_NOTIFY);
  chImu.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chImu.setFixedLen(sizeof(ImuPacket));
  if (chImu.begin() != ERROR_NONE) return false;

  chVitals.setProperties(CHR_PROPS_NOTIFY);
  chVitals.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chVitals.setFixedLen(sizeof(VitalsPacket));
  if (chVitals.begin() != ERROR_NONE) return false;

  chGps.setProperties(CHR_PROPS_NOTIFY);
  chGps.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chGps.setFixedLen(sizeof(GpsPacket));
  if (chGps.begin() != ERROR_NONE) return false;

  chStatus.setProperties(CHR_PROPS_NOTIFY | CHR_PROPS_READ);
  chStatus.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chStatus.setFixedLen(sizeof(StatusPacket));
  if (chStatus.begin() != ERROR_NONE) return false;

  pending = xQueueCreate(8, sizeof(Pending));
  if (!pending) return false;
  if (xTaskCreate(transmit, "ble_tx", 768, nullptr, 1, nullptr) != pdPASS) {
    vQueueDelete(pending); pending = nullptr; return false;
  }

  if (!Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE)
      || !Bluefruit.Advertising.addTxPower()
      || !Bluefruit.Advertising.addService(svc)
      || !Bluefruit.ScanResponse.addName()) return false;
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(BLE_ADV_FAST_UNITS, BLE_ADV_SLOW_UNITS);
  Bluefruit.Advertising.setFastTimeout(BLE_ADV_FAST_SECONDS);
  return Bluefruit.Advertising.start(0);
}

bool BleLink::connected() const { return Bluefruit.connected(); }

uint32_t BleLink::dropped() const { return ::dropped.load(); }
bool BleLink::sendImu(const ImuPacket& p) { return enqueue(chImu, &p, sizeof(p)); }
bool BleLink::sendVitals(const VitalsPacket& p) { return enqueue(chVitals, &p, sizeof(p)); }
bool BleLink::sendGps(const GpsPacket& p) { return enqueue(chGps, &p, sizeof(p)); }
bool BleLink::sendStatus(const StatusPacket& p) {
  chStatus.write(&p, sizeof(p));
  return enqueue(chStatus, &p, sizeof(p));
}
