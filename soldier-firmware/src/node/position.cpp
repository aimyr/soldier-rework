#include "position.h"
#include <math.h>

namespace node {

namespace {
constexpr float DEG_TO_RAD = 3.14159265f / 180.0f;
}

void PositionFusion::setOrigin(int32_t latE7, int32_t lonE7) {
  lat0_ = latE7;
  lon0_ = lonE7;
  cosLat0_ = cosf(latE7 * 1e-7f * DEG_TO_RAD);
  originSet_ = true;
}

void PositionFusion::toLocal(int32_t latE7, int32_t lonE7, float& x, float& y) const {
  y = float(int64_t(latE7) - lat0_) * 1e-7f * METRES_PER_DEGREE;
  x = float(int64_t(lonE7) - lon0_) * 1e-7f * METRES_PER_DEGREE * cosLat0_;
}

void PositionFusion::update(const GeoFix& fix, float pdrX, float pdrY) {
  if (!fix.valid) {
    const float dx = pdrX - basePdrX_, dy = pdrY - basePdrY_;
    const float c = cosf(offset_), s = sinf(offset_);
    x_ = baseX_ + dx * c + dy * s;
    y_ = baseY_ - dx * s + dy * c;
    usingGps_ = false;
    return;
  }

  if (!originSet_) {
    // Place the origin so this first fix maps to the current estimate.
    const int32_t lat0 = fix.latE7 - int32_t(lroundf(y_ / METRES_PER_DEGREE * 1e7f));
    const float cosLat0 = cosf(lat0 * 1e-7f * DEG_TO_RAD);
    setOrigin(lat0, fix.lonE7 - int32_t(lroundf(x_ / (METRES_PER_DEGREE * cosLat0) * 1e7f)));
  }
  float gx, gy;
  toLocal(fix.latE7, fix.lonE7, gx, gy);

  if (anchored_) {
    const float gdx = gx - anchorGpsX_, gdy = gy - anchorGpsY_;
    if (sqrtf(gdx * gdx + gdy * gdy) >= CALIBRATE_GPS_M) {
      const float pdx = pdrX - anchorPdrX_, pdy = pdrY - anchorPdrY_;
      if (sqrtf(pdx * pdx + pdy * pdy) >= CALIBRATE_PDR_M) {
        offset_ = atan2f(gdx, gdy) - atan2f(pdx, pdy);  // bearings, clockwise from +y
        calibrated_ = true;
      }
      anchored_ = false;
    }
  }
  if (!anchored_) {
    anchorGpsX_ = gx; anchorGpsY_ = gy;
    anchorPdrX_ = pdrX; anchorPdrY_ = pdrY;
    anchored_ = true;
  }

  x_ = baseX_ = gx;
  y_ = baseY_ = gy;
  basePdrX_ = pdrX;
  basePdrY_ = pdrY;
  usingGps_ = true;
}

}  // namespace node
