#pragma once
#include <Arduino.h>
#include "protocol/packets.h"
#include "dmp_decode.h"
class Imu {
public:
  enum class State : uint8_t { Offline, ResetWait, SignalWait, Upload, Start, Settling, Running };
  bool begin();
  void poll();
  bool read(ImuPacket& out, OrientationPacket& orientation);
  bool ok() const { return state_ == State::Running; }
  bool active() const { return state_ != State::Offline; }
  State state() const { return state_; }
  uint32_t fifoResets() const { return fifoResets_; }
private:
  void fail();
  bool resetFifo();
  bool checked(uint8_t reg, uint8_t value);
  bool uploadChunk();
  State state_ = State::Offline;
  uint32_t sinceMs_ = 0, lastDataMs_ = 0, lastPollMs_ = 0, fifoResets_ = 0;
  uint16_t loaded_ = 0;
  uint8_t addr_ = 0, failures_ = 0;
  bool fresh_ = false;
  DmpStillness stillness_;
  ImuPacket sample_{};
  OrientationPacket orientation_{};
};
