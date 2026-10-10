/** Pure GPS / rear-camera projection math; coordinates are east, north, up (metres). */
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const WGS84_A = 6378137;
const WGS84_E2 = 6.6943799901413165e-3;
const EPSILON = 1e-10;

const finite = Number.isFinite;
const normalizeHeading = (value) => ((value % 360) + 360) % 360;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mix = (a, b, ca, cb) => a.map((value, index) => ca * value + cb * b[index]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vectorValid = (v) => Array.isArray(v) && v.length === 3 && v.every(finite);

function positionFields(position) {
  if (!position) return null;
  const lat = position.lat ?? position.latitude;
  const lon = position.lon ?? position.longitude;
  if (!finite(lat) || !finite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat, lon,
    alt: position.alt_m ?? position.altitude,
    reference: position.alt_reference ?? position.altitudeReference ?? 'unknown',
    accuracy: position.alt_accuracy_m ?? position.altitude_accuracy_m ?? position.altitudeAccuracy,
  };
}

function surfaceEcef(latDeg, lonDeg) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const radius = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
  return [
    radius * Math.cos(lat) * Math.cos(lon),
    radius * Math.cos(lat) * Math.sin(lon),
    radius * (1 - WGS84_E2) * Math.sin(lat),
  ];
}

/**
 * Position fields: lat, lon, alt_m, alt_reference ('wgs84' / 'msl' / 'unknown'),
 * alt_accuracy_m. Browser latitude/longitude/altitude/altitudeAccuracy aliases work.
 * WGS84 surface ECEF -> ENU avoids longitude-wrap errors. For local AR, up is the
 * trusted height difference rather than the Earth's curvature below a tangent.
 * MSL and ellipsoid heights are never mixed. Explicit offset works in flat mode.
 */
export function relativePosition(observer, target, {
  useAltitude = true, altitudeOffsetM = 0, maxAltitudeAccuracyM = 15,
} = {}) {
  const origin = positionFields(observer);
  const destination = positionFields(target);
  if (!origin || !destination) return null;
  const start = surfaceEcef(origin.lat, origin.lon);
  const end = surfaceEcef(destination.lat, destination.lon);
  const difference = end.map((value, index) => value - start[index]);
  const lat = origin.lat * DEG;
  const lon = origin.lon * DEG;
  const east = dot(difference, [-Math.sin(lon), Math.cos(lon), 0]);
  const north = dot(difference, [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)]);
  const supportedDatum = origin.reference === 'wgs84' || origin.reference === 'msl';
  const validAltitude = (position) => finite(position.alt) && finite(position.accuracy)
    && position.accuracy >= 0 && position.accuracy <= maxAltitudeAccuracyM;
  const altitudeUsed = Boolean(useAltitude && supportedDatum
    && origin.reference === destination.reference && finite(maxAltitudeAccuracyM)
    && maxAltitudeAccuracyM >= 0 && validAltitude(origin) && validAltitude(destination));
  const up = (altitudeUsed ? destination.alt - origin.alt : 0)
    + (finite(altitudeOffsetM) ? altitudeOffsetM : 0);
  return {
    east, north, up, altitudeUsed,
    horizontalDistanceM: Math.hypot(east, north),
    distanceM: Math.hypot(east, north, up),
  };
}

/** Heading is clockwise from north; pitch positive looks up; roll tilts right up. */
export function cameraBasis({headingDeg, pitchDeg = 0, rollDeg = 0} = {}) {
  if (![headingDeg, pitchDeg, rollDeg].every(finite)) return null;
  const heading = headingDeg * DEG;
  const pitch = pitchDeg * DEG;
  const roll = rollDeg * DEG;
  const right = [Math.cos(heading), -Math.sin(heading), 0];
  const forward = [Math.sin(heading) * Math.cos(pitch), Math.cos(heading) * Math.cos(pitch), Math.sin(pitch)];
  const up = cross(right, forward);
  return {
    right: mix(right, up, Math.cos(roll), Math.sin(roll)),
    up: mix(up, right, Math.cos(roll), -Math.sin(roll)),
    forward,
  };
}

function viewportFields({width, height, horizontalFovDeg = 65, near = 0.25} = {}) {
  if (![width, height, horizontalFovDeg, near].every(finite)
    || width <= 0 || height <= 0 || horizontalFovDeg <= 0 || horizontalFovDeg >= 180 || near <= 0) return null;
  return {width, height, near, focal: width / (2 * Math.tan(horizontalFovDeg * DEG / 2))};
}

function cameraPoint(point, basis) {
  const position = Array.isArray(point) ? point : [point?.east, point?.north, point?.up];
  if (!vectorValid(position) || !basis || ![basis.right, basis.up, basis.forward].every(vectorValid)) return null;
  return [dot(position, basis.right), dot(position, basis.up), dot(position, basis.forward)];
}

function projectCameraPoint(point, viewport) {
  return {
    x: viewport.width / 2 + viewport.focal * point[0] / point[2],
    y: viewport.height / 2 - viewport.focal * point[1] / point[2],
    depth: point[2],
  };
}

/** Projects into a pinhole rear-camera viewport. Offscreen points remain unclipped. */
export function projectPoint(point, basis, viewport) {
  const view = viewportFields(viewport);
  const camera = cameraPoint(point, basis);
  if (!view || !camera || camera[2] < view.near) return null;
  return projectCameraPoint(camera, view);
}

/** A fixed physical-size wireframe cube, yawed by its participant's camera heading. */
export function cubeSegments(relative, basis, viewport, {sizeM = 1.8, headingDeg = 0} = {}) {
  const view = viewportFields(viewport);
  if (!view || !finite(sizeM) || sizeM <= 0 || !finite(headingDeg)
    || !cameraPoint(relative, basis)) return [];
  const half = sizeM / 2;
  const heading = headingDeg * DEG;
  const right = [Math.cos(heading), -Math.sin(heading), 0];
  const forward = [Math.sin(heading), Math.cos(heading), 0];
  const center = [relative.east, relative.north, relative.up];
  const corners = [];
  for (let vertex = 0; vertex < 8; vertex++) {
    const x = (vertex & 1 ? half : -half);
    const y = (vertex & 2 ? half : -half);
    const z = (vertex & 4 ? half : -half);
    const point = [center[0] + x * right[0] + y * forward[0], center[1] + x * right[1] + y * forward[1], center[2] + z];
    corners.push(cameraPoint(point, basis));
  }
  const segments = [];
  for (let vertex = 0; vertex < 8; vertex++) {
    for (const bit of [1, 2, 4]) {
      if (vertex & bit) continue;
      let start = corners[vertex];
      let end = corners[vertex | bit];
      if (start[2] < view.near && end[2] < view.near) continue;
      if (start[2] < view.near) {
        const t = (view.near - start[2]) / (end[2] - start[2]);
        start = [start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1]), view.near];
      } else if (end[2] < view.near) {
        const t = (view.near - end[2]) / (start[2] - end[2]);
        end = [end[0] + t * (start[0] - end[0]), end[1] + t * (start[1] - end[1]), view.near];
      }
      segments.push([projectCameraPoint(start, view), projectCameraPoint(end, view)]);
    }
  }
  return segments;
}

const headingOf = (vector) => normalizeHeading(Math.atan2(vector[0], vector[1]) * RAD);

/**
 * W3C intrinsic Z-X'-Y'' device -> earth rotation; rear optical axis is -device Z.
 * https://www.w3.org/TR/orientation-event/#worked-example
 * screenAngle uses screen.orientation.angle (counter-clockwise), or legacy equivalent.
 *
 * calibrationHeadingDeg is a constant clockwise yaw OFFSET, not a fixed heading.
 * At calibration set offset = knownCameraHeading - result.relativeAlphaDeg, then
 * reuse that offset. Without north-referenced sensors or calibration headingDeg
 * remains null. GPS coordinates.heading is a travel course and is never read here.
 */
export function orientationFromEvent(event, screenAngle = 0, calibrationHeadingDeg = null) {
  if (!event || ![event.alpha, event.beta, event.gamma, screenAngle].every(finite)) return null;
  const alpha = event.alpha * DEG;
  const beta = event.beta * DEG;
  const gamma = event.gamma * DEG;
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const cb = Math.cos(beta), sb = Math.sin(beta);
  const cg = Math.cos(gamma), sg = Math.sin(gamma);
  const deviceX = [ca * cg - sa * sb * sg, sa * cg + ca * sb * sg, -cb * sg];
  const deviceY = [-sa * cb, ca * cb, sb];
  const deviceZ = [ca * sg + sa * sb * cg, sa * sg - ca * sb * cg, cb * cg];
  const angle = screenAngle * DEG;
  const right = mix(deviceX, deviceY, Math.cos(angle), -Math.sin(angle));
  const forward = deviceZ.map((value) => -value);
  const horizontal = Math.hypot(forward[0], forward[1]);
  // At a vertical optical axis, choose yaw from screen-right to avoid NaNs and
  // preserve the exact frame; compass bearing itself has no meaning at the pole.
  const relativeAlphaDeg = horizontal > EPSILON
    ? headingOf(forward) : normalizeHeading(Math.atan2(-right[1], right[0]) * RAD);
  const pitchDeg = Math.asin(Math.max(-1, Math.min(1, forward[2]))) * RAD;
  const unrolled = cameraBasis({headingDeg: relativeAlphaDeg, pitchDeg});
  const rollDeg = Math.atan2(dot(right, unrolled.up), dot(right, unrolled.right)) * RAD;
  let headingDeg = null;
  let source = 'relative';
  const topHorizontal = Math.hypot(deviceY[0], deviceY[1]);
  const compassValid = finite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0
    && event.webkitCompassHeading < 360
    && (!finite(event.webkitCompassAccuracy) || event.webkitCompassAccuracy >= 0);
  if (compassValid && topHorizontal > EPSILON) {
    // Safari reports the natural-orientation top edge, not the rear optical axis.
    const offset = event.webkitCompassHeading - headingOf(deviceY);
    headingDeg = normalizeHeading(relativeAlphaDeg + offset);
    source = 'webkit';
  } else if (event.absolute === true) {
    headingDeg = relativeAlphaDeg;
    source = 'absolute';
  } else if (finite(calibrationHeadingDeg)) {
    headingDeg = normalizeHeading(relativeAlphaDeg + calibrationHeadingDeg);
    source = 'calibrated';
  }
  return {headingDeg, pitchDeg, rollDeg, source, relativeAlphaDeg};
}
