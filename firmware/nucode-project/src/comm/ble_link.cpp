#include "ble_link.h"
#include <BLEDevice.h>
#include <atomic>
#include <string.h>
#include "config.h"
#include "protocol/uuids.h"

namespace {
BLEService service(UUID_SERVICE);
BLECharacteristic imu(UUID_IMU), vitals(UUID_VITALS), gps(UUID_GPS), status(UUID_STATUS), orientation(UUID_ORIENTATION);
BLECharacteristic* chars[] = {&imu, &vitals, &gps, &status, &orientation};
std::atomic<bool> subscribed[5];
uint32_t drops = 0;
void subscription(BLECharacteristic* chr, uint8_t connection, uint16_t bits) {
  if (connection != 0) return;
  for (unsigned i = 0; i < 5; ++i)
    if (chars[i] == chr) subscribed[i].store((bits & GATT_CLIENT_CHAR_CONFIG_NOTIFY) != 0);
}
bool send(unsigned index, const void* data, uint8_t size) {
  if (!BLE.connected(0)) {
    for (auto& enabled : subscribed) enabled.store(false);
    return false;
  }
  if (!subscribed[index].load()) return false;
  uint8_t bytes[20];
  memcpy(bytes, data, size);
  if (!chars[index]->setData(bytes, size)) { ++drops; return false; }
  // The vendor API queues the notification but does not expose radio delivery
  // status. drops counts local failures only, not over-the-air packet loss.
  chars[index]->notify(0);
  return true;
}
}
bool BleLink::begin() {
  BLEAdvertData advertisement, scan;
  advertisement.addFlags(GAP_ADTYPE_FLAGS_GENERAL | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED);
  advertisement.addCompleteServices(BLEUUID(UUID_SERVICE));
  scan.addCompleteName(BLE_DEVICE_NAME);
  const uint8_t sizes[] = {sizeof(ImuPacket), sizeof(VitalsPacket), sizeof(GpsPacket), sizeof(StatusPacket), sizeof(OrientationPacket)};
  for (unsigned i = 0; i < 5; ++i) {
    chars[i]->setNotifyProperty(true);
    chars[i]->setBufferLen(sizes[i]);
    chars[i]->setCCCDCallback(subscription);
    service.addCharacteristic(*chars[i]);
  }
  BLE.init();
  BLE.setDeviceName(BLE_DEVICE_NAME);
  BLE.configAdvert()->setAdvData(advertisement);
  BLE.configAdvert()->setScanRspData(scan);
  BLE.configAdvert()->setMinInterval(250);
  BLE.configAdvert()->setMaxInterval(500);
  BLE.configServer(1);
  BLE.addService(service);
  BLE.beginPeripheral(); // Vendor handler restarts advertising on disconnect.
  return true; // The vendor initialization API has no success return value.
}
bool BleLink::connected() const { return BLE.connected(0); }
uint32_t BleLink::dropped() const { return drops; }
bool BleLink::sendImu(const ImuPacket& p) { return send(0, &p, sizeof(p)); }
bool BleLink::sendVitals(const VitalsPacket& p) { return send(1, &p, sizeof(p)); }
bool BleLink::sendGps(const GpsPacket& p) { return send(2, &p, sizeof(p)); }
bool BleLink::sendStatus(const StatusPacket& p) { return send(3, &p, sizeof(p)); }

bool BleLink::sendOrientation(const OrientationPacket& p) { return send(4, &p, sizeof(p)); }
