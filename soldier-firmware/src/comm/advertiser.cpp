#include "advertiser.h"
#include <BLEDevice.h>
#include "config.h"

extern "C" {
#include "gap.h"
#include "gap_le.h"
#include "gap_msg.h"
}

namespace {
bool advertising() {
  T_GAP_DEV_STATE state;
  le_get_gap_param(GAP_PARAM_DEV_STATE, &state);
  return state.gap_adv_state != GAP_ADV_STATE_IDLE;
}
}

bool Advertiser::begin() {
  // Flags only until the first packet. The vendor stack starts advertising by
  // itself once ready; update() stops it.
  uint8_t flags[] = {0x02, 0x01, 0x06};
  BLE.init();
  BLE.configAdvert()->setAdvType(GAP_ADTYPE_ADV_NONCONN_IND);
  BLE.configAdvert()->setMinInterval(ADV_INTERVAL_MIN_MS);
  BLE.configAdvert()->setMaxInterval(ADV_INTERVAL_MAX_MS);
  BLE.configAdvert()->setAdvData(flags, sizeof(flags));
  BLE.beginPeripheral();  // Blocks until the stack is ready; no success return value.
  return true;
}

void Advertiser::send(const uint8_t packet[node::PACKET_SIZE]) {
  node::buildAdvert(packet, advert_);
  pending_ = true;
}

void Advertiser::update(uint32_t nowMs) {
  if (state_ == State::Bursting) {
    if (nowMs - burstStartMs_ < ADV_BURST_MS) return;
    BLE.configAdvert()->stopAdv();
    lastStopMs_ = nowMs;
    state_ = State::Idle;
    return;
  }
  // Start and stop complete asynchronously; parameters can only change while idle.
  if (advertising()) {
    if (nowMs - lastStopMs_ >= 100) {
      BLE.configAdvert()->stopAdv();
      lastStopMs_ = nowMs;
    }
    return;
  }
  if (!pending_) return;
  BLE.configAdvert()->setAdvData(advert_, sizeof(advert_));
  BLE.configAdvert()->updateAdvertParams();
  BLE.configAdvert()->startAdv();
  pending_ = false;
  burstStartMs_ = nowMs;
  state_ = State::Bursting;
  ++sent_;
}

uint32_t Advertiser::addressHash() const {
  uint8_t address[6] = {};
  gap_get_param(GAP_PARAM_BD_ADDR, address);
  uint32_t hash = 2166136261u;  // FNV-1a
  for (uint8_t byte : address) hash = (hash ^ byte) * 16777619u;
  return hash;
}
