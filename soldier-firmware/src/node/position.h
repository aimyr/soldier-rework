#pragma once
// Node position in metres east (x) and north (y) of an origin.
// GPS when it has a fix; otherwise dead reckoning continues from the last GPS
// position. PDR heading is relative to startup, so its offset to true north is
// learned by comparing GPS and PDR tracks while walking.
//
// Origin: a fixed area-of-operations point if set, otherwise the power-on
// position (the first GPS fix is placed so the estimate does not jump).

#include <stdint.h>

namespace node {

struct GeoFix {
  bool valid;
  int32_t latE7;
  int32_t lonE7;
};

class PositionFusion {
public:
  static constexpr float METRES_PER_DEGREE = 111319.49f;  // WGS84 equator, equirectangular
  static constexpr float CALIBRATE_GPS_M = 15;   // GPS track length used to learn PDR heading
  static constexpr float CALIBRATE_PDR_M = 7.5f; // minimum PDR movement over the same track

  void setOrigin(int32_t latE7, int32_t lonE7);
  // Call once per second with the latest GPS state and PDR position (PDR frame).
  void update(const GeoFix& fix, float pdrX, float pdrY);

  float x() const { return x_; }
  float y() const { return y_; }
  bool usingGps() const { return usingGps_; }
  bool headingCalibrated() const { return calibrated_; }

private:
  void toLocal(int32_t latE7, int32_t lonE7, float& x, float& y) const;

  bool originSet_ = false;
  int32_t lat0_ = 0, lon0_ = 0;
  float cosLat0_ = 1;
  float x_ = 0, y_ = 0;
  bool usingGps_ = false;
  // Fallback: last GPS position and the PDR position at that moment.
  float baseX_ = 0, baseY_ = 0, basePdrX_ = 0, basePdrY_ = 0;
  // PDR-to-north rotation, radians clockwise.
  float offset_ = 0;
  bool calibrated_ = false;
  bool anchored_ = false;
  float anchorGpsX_ = 0, anchorGpsY_ = 0, anchorPdrX_ = 0, anchorPdrY_ = 0;
};

}  // namespace node
