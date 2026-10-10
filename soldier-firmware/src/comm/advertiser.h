#pragma once
#include <stdint.h>
#include "node/packet.h"

// Sends each packet as a short burst of non-connectable BLE advertisements
// (docs/DATA_SPEC.md section 5). Radio is silent between bursts.
class Advertiser {
public:
  bool begin();
  // Queue a packet; replaces one still waiting. Sent on the next update().
  void send(const uint8_t packet[node::PACKET_SIZE]);
  void update(uint32_t nowMs);
  uint32_t sent() const { return sent_; }
  // Board BLE address, for seeding random().
  uint32_t addressHash() const;

private:
  enum class State : uint8_t { Idle, Bursting };
  State state_ = State::Idle;
  uint8_t advert_[node::ADVERT_SIZE] = {};
  bool pending_ = false;
  uint32_t burstStartMs_ = 0, lastStopMs_ = 0, sent_ = 0;
};
