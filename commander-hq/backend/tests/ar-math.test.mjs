import assert from 'node:assert/strict';
import test from 'node:test';
import {relativePosition, cameraBasis, projectPoint, cubeSegments, orientationFromEvent} from '../app/static/ar-math.mjs';

const close = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const vectorClose = (actual, expected, epsilon) => actual.forEach((value, index) => close(value, expected[index], epsilon));
const view = {width: 800, height: 600, horizontalFovDeg: 90};
const northCamera = cameraBasis({headingDeg: 0});
const gps = (lat, lon, alt_m = 0, alt_reference = 'wgs84', alt_accuracy_m = 1) => ({lat, lon, alt_m, alt_reference, alt_accuracy_m});
const extent = (segments) => {
  const points = segments.flat();
  return {width: Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)),
    height: Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y))};
};

test('WGS84 ENU gives cardinal signs, known equatorial metre scales, and valid zero coordinates', () => {
  const origin = gps(0, 0);
  const east = relativePosition(origin, gps(0, 0.001));
  close(east.east, 111.319490787, 0.00001);
  close(east.north, 0);
  const north = relativePosition(origin, gps(0.001, 0));
  close(north.north, 110.574275817, 0.00001);
  close(north.east, 0);
  assert.ok(relativePosition(origin, gps(-0.001, 0)).north < 0);
  assert.ok(relativePosition(origin, gps(0, -0.001)).east < 0);
  const same = relativePosition(origin, origin);
  close(same.distanceM, 0);
  assert.equal(same.altitudeUsed, true);
});

test('antimeridian crosses locally, never around the world', () => {
  const east = relativePosition(gps(0, 179.999), gps(0, -179.999));
  close(east.east, 222.638981541, 0.00001);
  close(east.north, 0);
  const west = relativePosition(gps(0, -179.999), gps(0, 179.999));
  close(west.east, -east.east, 0.00001);
});

test('height requires matching supported datum and both finite acceptable uncertainties', () => {
  for (const datum of ['wgs84', 'msl']) {
    const relative = relativePosition(gps(37, 127, 10, datum), gps(37, 127, 14, datum));
    close(relative.up, 4);
    close(relative.distanceM, 4);
    assert.equal(relative.altitudeUsed, true);
  }
  const origin = gps(37, 127, 10);
  for (const target of [gps(37, 127, 14, 'msl'), gps(37, 127, 14, 'unknown'),
    gps(37, 127, 14, 'wgs84', 15.001), gps(37, 127, null), gps(37, 127, 14, 'wgs84', null),
    gps(37, 127, 14, 'wgs84', -1)]) {
    const relative = relativePosition(origin, target);
    close(relative.up, 0);
    assert.equal(relative.altitudeUsed, false);
  }
  assert.equal(relativePosition({...origin, alt_accuracy_m: 20}, gps(37, 127, 14)).altitudeUsed, false);
  assert.equal(relativePosition({...origin, alt_reference: 'unknown'}, gps(37, 127, 14, 'unknown')).altitudeUsed, false);
  close(relativePosition(origin, gps(37, 127, 14), {useAltitude: false}).up, 0);
  close(relativePosition(origin, gps(37, 127, 14), {altitudeOffsetM: -1.5}).up, 2.5);
  close(relativePosition(origin, gps(37, 127, 14), {useAltitude: false, altitudeOffsetM: 2}).up, 2);
  assert.equal(relativePosition(origin, gps(37, 127, 14, 'wgs84', 20), {maxAltitudeAccuracyM: 20}).altitudeUsed, true);
});

test('browser coordinate aliases, zero altitude / uncertainty, and invalid input', () => {
  const origin = {latitude: 0, longitude: 0, altitude: 0, altitudeReference: 'wgs84', altitudeAccuracy: 0};
  close(relativePosition(origin, {...origin, altitude: 1}).up, 1);
  assert.equal(relativePosition(origin, {lat: 91, lon: 0}), null);
  assert.equal(relativePosition(null, gps(0, 0)), null);
  assert.equal(relativePosition(gps(NaN, 0), gps(0, 0)), null);
  assert.equal(relativePosition(gps(0, 0), gps(0, Infinity)), null);
});

test('camera cardinal headings place the correct target centrally and hide opposite targets', () => {
  for (const [headingDeg, point] of [[0, [0, 10, 0]], [90, [10, 0, 0]], [180, [0, -10, 0]], [270, [-10, 0, 0]]]) {
    const basis = cameraBasis({headingDeg});
    const projected = projectPoint(point, basis, view);
    close(projected.x, 400);
    close(projected.y, 300);
    close(projected.depth, 10);
    assert.equal(projectPoint(point.map((v) => -v), basis, view), null);
  }
  assert.ok(projectPoint([2, 10, 0], northCamera, view).x > 400);
  assert.ok(projectPoint([0, 10, 2], northCamera, view).y < 300);
});

test('camera pitch and roll change projection consistently', () => {
  const upward = cameraBasis({headingDeg: 0, pitchDeg: 45});
  const aligned = projectPoint([0, 10, 10], upward, view);
  close(aligned.x, 400);
  close(aligned.y, 300);
  assert.ok(projectPoint([0, 10, 0], upward, view).y > 300);
  const rolled = cameraBasis({headingDeg: 0, rollDeg: 90});
  vectorClose(rolled.right, [0, 0, 1]);
  vectorClose(rolled.up, [-1, 0, 0]);
  const east = projectPoint([2, 10, 0], rolled, view);
  close(east.x, 400);
  assert.ok(east.y > 300);
});

test('projection rejects invalid viewport, unknown heading and points before near plane', () => {
  assert.equal(cameraBasis({headingDeg: null}), null);
  assert.equal(projectPoint([0, 0.24, 0], northCamera, view), null);
  assert.notEqual(projectPoint([0, 0.25, 0], northCamera, view), null);
  assert.equal(projectPoint([0, 1, 0], northCamera, {...view, width: 0}), null);
  assert.equal(projectPoint([0, 1, 0], northCamera, {...view, horizontalFovDeg: 180}), null);
  assert.equal(projectPoint([0, 1, 0], null, view), null);
});

test('cube has twelve edges, constant physical size shrinks with distance, and supports yaw', () => {
  const near = cubeSegments({east: 0, north: 10, up: 0}, northCamera, view);
  const far = cubeSegments({east: 0, north: 20, up: 0}, northCamera, view);
  assert.equal(near.length, 12);
  assert.equal(far.length, 12);
  const nearExtent = extent(near), farExtent = extent(far);
  assert.ok(nearExtent.width > farExtent.width * 2);
  assert.ok(nearExtent.height > farExtent.height * 2);
  const yawed = cubeSegments({east: 0, north: 10, up: 0}, northCamera, view, {headingDeg: 45});
  assert.ok(extent(yawed).width > nearExtent.width);
  assert.deepEqual(cubeSegments({east: 0, north: -10, up: 0}, northCamera, view), []);
});

test('cube edges crossing the near plane are clipped without NaN or negative depth', () => {
  const clipped = cubeSegments({east: 0, north: 0.5, up: 0}, northCamera, view, {sizeM: 1});
  assert.equal(clipped.length, 8);
  assert.ok(clipped.flat().some((point) => point.depth === 0.25));
  for (const point of clipped.flat()) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.depth >= 0.25);
  }
  assert.deepEqual(cubeSegments({east: 0, north: 10, up: 0}, northCamera, view, {sizeM: 0}), []);
});

test('W3C portrait rear camera points north/east/south/west and pitch comes from optical axis', () => {
  for (const [alpha, heading] of [[0, 0], [270, 90], [180, 180], [90, 270]]) {
    const pose = orientationFromEvent({alpha, beta: 90, gamma: 0, absolute: true});
    close(pose.headingDeg, heading);
    close(pose.pitchDeg, 0);
    close(pose.rollDeg, 0);
    assert.equal(pose.source, 'absolute');
  }
  close(orientationFromEvent({alpha: 0, beta: 60, gamma: 0, absolute: true}).pitchDeg, -30);
  close(orientationFromEvent({alpha: 0, beta: 120, gamma: 0, absolute: true}).pitchDeg, 30);
  const downward = orientationFromEvent({alpha: 0, beta: 0, gamma: 0, absolute: true});
  close(downward.pitchDeg, -90);
  const downBasis = cameraBasis(downward);
  vectorClose(downBasis.forward, [0, 0, -1]);
  vectorClose(downBasis.right, [1, 0, 0]);
});

test('landscape screen angle compensates physical phone roll and keeps optical heading', () => {
  // Top edge left: device Y points west, device X up, rear camera north.
  const left = orientationFromEvent({alpha: 90, beta: 0, gamma: -90, absolute: true}, 90);
  const right = orientationFromEvent({alpha: 270, beta: 0, gamma: 90, absolute: true}, 270);
  for (const pose of [left, right]) {
    close(pose.headingDeg, 0);
    close(pose.pitchDeg, 0);
    close(pose.rollDeg, 0);
    vectorClose(cameraBasis(pose).right, [1, 0, 0]);
    vectorClose(cameraBasis(pose).up, [0, 0, 1]);
  }
  const lockedPortrait = orientationFromEvent({alpha: 90, beta: 0, gamma: -90, absolute: true}, 0);
  close(lockedPortrait.rollDeg, 90);
});

test('combined rotations reproduce the full device frame rather than alpha-only heading', () => {
  const event = {alpha: 37, beta: 68, gamma: -24, absolute: true};
  const a = event.alpha * Math.PI / 180, b = event.beta * Math.PI / 180, g = event.gamma * Math.PI / 180;
  const deviceX = [Math.cos(a) * Math.cos(g) - Math.sin(a) * Math.sin(b) * Math.sin(g),
    Math.sin(a) * Math.cos(g) + Math.cos(a) * Math.sin(b) * Math.sin(g), -Math.cos(b) * Math.sin(g)];
  const deviceY = [-Math.sin(a) * Math.cos(b), Math.cos(a) * Math.cos(b), Math.sin(b)];
  const rear = [-Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g),
    -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g), -Math.cos(b) * Math.cos(g)];
  for (const screenAngle of [0, 90, 180, 270]) {
    const angle = screenAngle * Math.PI / 180;
    const expectedRight = deviceX.map((value, index) => Math.cos(angle) * value - Math.sin(angle) * deviceY[index]);
    const expectedUp = deviceX.map((value, index) => Math.sin(angle) * value + Math.cos(angle) * deviceY[index]);
    const basis = cameraBasis(orientationFromEvent(event, screenAngle));
    vectorClose(basis.forward, rear);
    vectorClose(basis.right, expectedRight);
    vectorClose(basis.up, expectedUp);
  }
});

test('Safari top-edge compass corrects world yaw, not directly rear-camera bearing', () => {
  const pose = orientationFromEvent({alpha: 50, beta: 60, gamma: 30, absolute: false,
    webkitCompassHeading: 90, webkitCompassAccuracy: 8});
  assert.equal(pose.source, 'webkit');
  // The top-edge has raw bearing 310; rear bearing differs because gamma is nonzero.
  const absolute = orientationFromEvent({alpha: 50, beta: 60, gamma: 30, absolute: true});
  close(pose.headingDeg, (absolute.headingDeg + 140) % 360);
  assert.notEqual(pose.headingDeg, 90);
  const verticalTop = orientationFromEvent({alpha: 0, beta: 90, gamma: 0,
    absolute: false, webkitCompassHeading: 90});
  assert.equal(verticalTop.headingDeg, null);
  assert.equal(verticalTop.source, 'relative');
  assert.equal(orientationFromEvent({alpha: 0, beta: 60, gamma: 0,
    webkitCompassHeading: 90, webkitCompassAccuracy: -1}).source, 'relative');
});

test('relative orientation needs a reusable calibration offset; absolute north never uses it', () => {
  const relative = orientationFromEvent({alpha: 30, beta: 90, gamma: 0, absolute: false});
  assert.equal(relative.headingDeg, null);
  assert.equal(relative.source, 'relative');
  close(relative.relativeAlphaDeg, 330);
  const offset = 90 - relative.relativeAlphaDeg;
  close(orientationFromEvent({alpha: 30, beta: 90, gamma: 0}, 0, offset).headingDeg, 90);
  const rotated = orientationFromEvent({alpha: 10, beta: 90, gamma: 0}, 0, offset);
  close(rotated.headingDeg, 110);
  assert.equal(rotated.source, 'calibrated');
  close(orientationFromEvent({alpha: 0, beta: 90, gamma: 0}, 0, 0).headingDeg, 0);
  close(orientationFromEvent({alpha: 0, beta: 90, gamma: 0, absolute: true}, 0, 45).headingDeg, 0);
  assert.equal(orientationFromEvent({alpha: null, beta: 90, gamma: 0}), null);
  assert.equal(orientationFromEvent({alpha: 0, beta: null, gamma: 0}), null);
  assert.equal(orientationFromEvent({alpha: NaN, beta: 90, gamma: 0}), null);
  assert.equal(orientationFromEvent(null), null);
  assert.equal(orientationFromEvent({alpha: 0, beta: 90, gamma: 0, heading: 123}).headingDeg, null);
});
