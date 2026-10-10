#include "motion.h"
#include <math.h>

namespace node {

float accelMagnitudeG(int16_t ax, int16_t ay, int16_t az) {
  const float x = ax / ACCEL_LSB_PER_G, y = ay / ACCEL_LSB_PER_G, z = az / ACCEL_LSB_PER_G;
  return sqrtf(x * x + y * y + z * z);
}

void ActivityMeter::add(int16_t ax, int16_t ay, int16_t az) {
  const float g = accelMagnitudeG(ax, ay, az);
  sum_[1] += fabsf(g - 1.0f);
  if (count_[1] < UINT16_MAX) ++count_[1];
  if (g > peak_) peak_ = g;
  const int16_t limit = INT16_MAX;
  if (ax >= limit || ay >= limit || az >= limit || ax <= -limit || ay <= -limit || az <= -limit) saturated_ = true;
}

ActivityMeter::Second ActivityMeter::roll() {
  const uint32_t count = uint32_t(count_[0]) + count_[1];
  Second out{count >= MIN_SAMPLES, 0, peak_, saturated_};
  if (out.valid) {
    const float activity = 255.0f * (sum_[0] + sum_[1]) / count;
    out.activity = activity > 255 ? 255 : activity;
  }
  sum_[0] = sum_[1];
  count_[0] = count_[1];
  sum_[1] = 0;
  count_[1] = 0;
  peak_ = 0;
  saturated_ = false;
  return out;
}

float headingFromQuaternion(const OrientationPacket& q) {
  const float w = q.w / 1073741824.0f, x = q.x / 1073741824.0f;
  const float y = q.y / 1073741824.0f, z = q.z / 1073741824.0f;
  // ZYX yaw is counter-clockwise about z; heading is clockwise.
  const float yaw = atan2f(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return -yaw;
}

bool Pdr::update(uint32_t tMs, float accelG, float headingRad) {
  if (accelG < winMin_) winMin_ = accelG;
  if (accelG > winMax_) winMax_ = accelG;

  bool stepped = false;
  if (accelG > STEP_THRESHOLD_G && !above_) {
    above_ = true;
    if (!stepped_ || tMs - lastStepMs_ >= MIN_STEP_INTERVAL_MS) {
      const float range = winMax_ - winMin_;
      const float stride = range > 0 ? WEINBERG_K * sqrtf(sqrtf(range)) : DEFAULT_STRIDE_M;
      x_ += stride * sinf(headingRad);
      y_ += stride * cosf(headingRad);
      ++steps_;
      stepped_ = true;
      lastStepMs_ = tMs;
      stepped = true;
    }
    winMin_ = 9.9f;
    winMax_ = 0;
  } else if (accelG < REARM_G) {
    above_ = false;
  }
  return stepped;
}

}  // namespace node
