#pragma once
// Motion processing for the node: activity level and pedestrian dead reckoning.
// PDR is a port of commander-hq/backend/app/analysis/pdr.py, with heading taken
// from the DMP quaternion instead of integrating gyro z.

#include <stdint.h>
#include "protocol/packets.h"

namespace node {

constexpr float ACCEL_LSB_PER_G = 16384;  // MPU6050 at +/-2g

// Activity = mean |(|accel| - 1g)| over the last 2 s, scaled so 1g = 255.
class ActivityMeter {
public:
  struct Second {
    bool valid;       // enough samples in the window
    float activity;   // 0..255
    float peakG;      // peak |accel| during the last second
    bool saturated;   // an axis hit the +/-2g limit, so the true peak is unknown and higher
  };
  static constexpr uint16_t MIN_SAMPLES = 25;  // per 2 s window (50Hz nominal = 100)

  void add(int16_t ax, int16_t ay, int16_t az);
  // Call once per second.
  Second roll();

private:
  float sum_[2] = {0, 0};   // [0] previous second, [1] current second
  uint16_t count_[2] = {0, 0};
  float peak_ = 0;
  bool saturated_ = false;
};

float accelMagnitudeG(int16_t ax, int16_t ay, int16_t az);

// Heading in radians, clockwise from the board's startup forward direction,
// assuming the board is mounted with its z axis vertical.
float headingFromQuaternion(const OrientationPacket& q);

class Pdr {
public:
  static constexpr float STEP_THRESHOLD_G = 1.15f;  // rising through this counts a step
  static constexpr float REARM_G = 1.0f;            // must fall below this before the next step
  static constexpr uint32_t MIN_STEP_INTERVAL_MS = 300;
  static constexpr float WEINBERG_K = 0.7f;         // calibrate per soldier over a known distance
  static constexpr float DEFAULT_STRIDE_M = 0.7f;

  // Feed one IMU sample. Returns true when a step was detected.
  bool update(uint32_t tMs, float accelG, float headingRad);
  // Position in metres in the startup frame: +y = startup forward, +x = right.
  float x() const { return x_; }
  float y() const { return y_; }
  uint32_t steps() const { return steps_; }

private:
  float x_ = 0, y_ = 0;
  uint32_t steps_ = 0;
  bool stepped_ = false;
  uint32_t lastStepMs_ = 0;
  bool above_ = false;
  float winMin_ = 9.9f, winMax_ = 0;
};

}  // namespace node
