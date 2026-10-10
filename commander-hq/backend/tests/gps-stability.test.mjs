import assert from 'node:assert/strict';
import test from 'node:test';
import {MotionTracker, GpsStabilizer} from '../app/static/gps-stability.mjs';

const startMs = 1700000000000;
const metresPerDegree = 111319.49079327358;
const makeFix = (second, east = 0, north = 0, overrides = {}) => ({device_id: 'Phone-1',
  fix_unix_ms: startMs + second * 1000, lat: north / metresPerDegree, lon: east / metresPerDegree,
  accuracy_m: 8, speed_mps: null, motion_state: 'unknown', motion_age_ms: null, ...overrides});
const eastM = fix => fix.lon * metresPerDegree;
const quietEvent = () => ({acceleration: {x: 0.02, y: -0.01, z: 0.01}, rotationRate: {alpha: 0, beta: 0, gamma: 0}});
const variance = values => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
};

test('quiet motion requires a regular observation window; reset and staleness invalidate it', () => {
  const tracker = new MotionTracker();
  assert.deepEqual(tracker.telemetry(startMs), {motion_state: 'unknown', motion_unix_ms: null,
    motion_age_ms: null, linear_accel_rms_mps2: null, rotation_rate_rms_dps: null});
  tracker.sample(quietEvent(), startMs);
  assert.equal(tracker.telemetry(startMs).motion_state, 'unknown');
  for (let i = 1; i <= 22; i++) tracker.sample(quietEvent(), startMs + i * 100);
  assert.equal(tracker.telemetry(startMs + 2200).motion_state, 'still');
  assert.equal(tracker.telemetry(startMs + 3700).motion_state, 'still');
  const stale = tracker.telemetry(startMs + 3701);
  assert.equal(stale.motion_state, 'unknown');
  assert.equal(stale.linear_accel_rms_mps2, null);
  tracker.reset();
  assert.equal(tracker.telemetry(startMs + 3800).motion_unix_ms, null);
});

test('sparse, missing, non-finite or gravity-only data never invent stillness', () => {
  const tracker = new MotionTracker();
  for (let i = 0; i <= 20; i++) tracker.sample(quietEvent(), startMs + i * 500);
  assert.equal(tracker.telemetry(startMs + 10000).motion_state, 'unknown');
  for (let i = 0; i <= 30; i++) tracker.sample({acceleration: {x: 0, y: 0, z: 0}}, startMs + 11000 + i * 100);
  assert.equal(tracker.telemetry(startMs + 14000).motion_state, 'unknown');
  const invalid = tracker.sample({acceleration: {x: NaN, y: 0, z: 0}}, startMs + 14100);
  assert.equal(invalid.motion_state, 'unknown');
  assert.equal(invalid.motion_unix_ms, startMs + 14100);
  assert.equal(invalid.linear_accel_rms_mps2, null);
  assert.equal(tracker.sample({accelerationIncludingGravity: {x: 0, y: 0, z: 9.8}}, startMs + 14200).motion_state, 'unknown');
});

test('observed motion reacts promptly and telemetry stays finite and bounded', () => {
  const tracker = new MotionTracker();
  const acceleration = tracker.sample({acceleration: {x: 1, y: 0, z: 0}}, startMs);
  assert.equal(acceleration.motion_state, 'moving');
  assert.equal(acceleration.rotation_rate_rms_dps, null);
  const rotation = tracker.sample({acceleration: {x: 0, y: 0, z: 0}, rotationRate: {alpha: 90, beta: 0, gamma: 0}}, startMs + 100);
  assert.equal(rotation.motion_state, 'moving');
  const large = tracker.sample({acceleration: {x: 200, y: 200, z: 200}, rotationRate: {alpha: 2000, beta: 2000, gamma: 2000}}, startMs + 1000);
  assert.ok(large.linear_accel_rms_mps2 <= 200);
  assert.ok(large.rotation_rate_rms_dps <= 2000);
  assert.equal(tracker.sample({acceleration: {x: Infinity, y: 0, z: 0}}, startMs + 1100).linear_accel_rms_mps2, null);
  assert.equal(tracker.telemetry(startMs + 2 * 86400000).motion_age_ms, 86400000);
  assert.equal(tracker.telemetry(startMs + 2 * 86400000).motion_state, 'unknown');
  assert.equal(tracker.sample(quietEvent(), 253402300800000).motion_unix_ms, null);
});

test('a null event immediately invalidates motion even within the same millisecond', () => {
  const tracker = new MotionTracker();
  assert.equal(tracker.sample({acceleration: {x: 1, y: 0, z: 0}}, startMs).motion_state, 'moving');
  const invalid = tracker.sample({acceleration: null}, startMs);
  assert.equal(invalid.motion_state, 'unknown');
  assert.equal(invalid.linear_accel_rms_mps2, null);
  assert.equal(invalid.motion_unix_ms, startMs);
});

test('quiet GPS jitter has less display variance without changing raw accuracy or timestamps', () => {
  const filter = new GpsStabilizer();
  const input = [], output = [];
  for (let second = 0; second < 100; second++) {
    const jitter = 3 * Math.sin(second * 1.9) + 2 * Math.sin(second * 0.7);
    const fix = makeFix(second, jitter, 0, {motion_state: 'still', motion_age_ms: 50});
    const before = {...fix};
    const display = filter.position(fix, startMs + second * 1000);
    assert.deepEqual(fix, before);
    assert.equal(display.accuracy_m, fix.accuracy_m);
    assert.equal(display.fix_unix_ms, fix.fix_unix_ms);
    if (second >= 20) { input.push(jitter); output.push(eastM(display)); }
  }
  assert.ok(variance(output) < variance(input) * 0.3);
});

test('walking with fresh motion or GPS speed follows promptly; quiet samples cannot override GPS movement', () => {
  for (const telemetry of [
    {motion_state: 'moving', motion_age_ms: 0},
    {motion_state: 'still', motion_age_ms: 0, speed_mps: 1.5},
  ]) {
    const filter = new GpsStabilizer();
    for (let second = 0; second < 40; second++) {
      const truth = second * 1.5;
      const display = filter.position(makeFix(second, truth, 0, telemetry), startMs + second * 1000);
      assert.ok(truth - eastM(display) < 1, 'moving marker must stay close to its current GPS point');
    }
  }
});

test('GPS-only and stale IMU remain usable; even apparent stillness never freezes a walking marker', () => {
  for (const telemetry of [
    {}, {motion_state: 'still', motion_age_ms: 1600}, {motion_state: 'still', motion_age_ms: 0},
  ]) {
    const filter = new GpsStabilizer();
    let display;
    for (let second = 0; second <= 40; second++) {
      display = filter.position(makeFix(second, second * 1.5, 0, telemetry), startMs + second * 1000);
      assert.ok(second * 1.5 - eastM(display) < 6, 'quiet acceleration is not zero velocity');
      if (second > 8) assert.ok(second * 1.5 - eastM(display) < 1,
        'sustained GPS travel must override apparent IMU stillness without a speed reading');
    }
    assert.ok(eastM(display) > 54);
  }
});

test('duplicate and older measurements cannot move the estimate or strengthen an old fix', () => {
  const filter = new GpsStabilizer();
  filter.position(makeFix(0), startMs);
  const display = filter.position(makeFix(1, 8), startMs + 1000);
  for (let i = 0; i < 20; i++) {
    const duplicate = filter.position(makeFix(1, 200), startMs + 1000 + i * 1000);
    assert.equal(duplicate.lat, display.lat);
    assert.equal(duplicate.lon, display.lon);
    assert.equal(duplicate.fix_unix_ms, startMs + 1000);
  }
  const old = filter.position(makeFix(0, -200), startMs + 22000);
  assert.equal(old.lon, display.lon);
  // Receiving duplicates did not conceal a real acquisition gap.
  assert.equal(filter.position(makeFix(2, 12), startMs + 23000).lon, makeFix(2, 12).lon);
});

test('an isolated confident jump is suppressed, but a persistent new cluster is reacquired', () => {
  const filter = new GpsStabilizer();
  filter.position(makeFix(0, 0, 0, {accuracy_m: 2}), startMs);
  const outlier = filter.position(makeFix(1, 100, 0, {accuracy_m: 2}), startMs + 1000);
  assert.ok(Math.abs(eastM(outlier)) < 1);
  const recovered = filter.position(makeFix(2, 1, 0, {accuracy_m: 2}), startMs + 2000);
  assert.ok(eastM(recovered) < 2);
  filter.position(makeFix(3, 101, 0, {accuracy_m: 2}), startMs + 3000);
  filter.position(makeFix(4, 102, 0, {accuracy_m: 2}), startMs + 4000);
  const reacquired = filter.position(makeFix(5, 103, 0, {accuracy_m: 2}), startMs + 5000);
  assert.ok(Math.abs(eastM(reacquired) - 103) < 0.01);
});

test('fresh timestamps and receipt-time gaps reset an obsolete local estimate', () => {
  for (const [fixSecond, receiptSecond] of [[12, 12], [2, 12]]) {
    const filter = new GpsStabilizer();
    filter.position(makeFix(0), startMs);
    const fix = makeFix(fixSecond, 100);
    assert.deepEqual(filter.position(fix, startMs + receiptSecond * 1000), fix);
  }
});

test('zero coordinates and accuracy are valid, and longitude wrap takes the short path', () => {
  const zero = makeFix(0, 0, 0, {accuracy_m: 0});
  assert.deepEqual(new GpsStabilizer().position(zero, startMs), zero);
  const filter = new GpsStabilizer();
  const left = makeFix(0, 0, 0, {lon: 179.99999, motion_state: 'moving', motion_age_ms: 0});
  filter.position(left, startMs);
  const right = {...left, lon: -179.99999, fix_unix_ms: startMs + 1000};
  const display = filter.position(right, startMs + 1000);
  assert.ok(Math.abs(display.lon) > 179.9999, 'must not sweep across Greenwich');
  assert.ok(Number.isFinite(display.lat));
});

test('device identity, conflicts, invalid inputs and lifecycle resets do not contaminate other phones', () => {
  const filter = new GpsStabilizer();
  filter.position(makeFix(0), startMs);
  filter.position(makeFix(0, 40, 0, {device_id: 'Other'}), startMs);
  filter.position(makeFix(1, 3), startMs + 1000);
  assert.ok(Math.abs(eastM(filter.position(makeFix(1, 40, 0, {device_id: 'Other'}), startMs + 1000)) - 40) < 0.001);
  assert.equal(filter.position(makeFix(2, 4, 0, {lat: NaN}), startMs + 2000), null);
  assert.equal(filter.position(makeFix(2, 4, 0, {accuracy_m: -1}), startMs + 2000), null);
  const conflict = makeFix(2, 100, 0, {id_conflict: true});
  assert.deepEqual(filter.position(conflict, startMs + 2000), conflict);
  assert.deepEqual(filter.position(makeFix(3, 120), startMs + 3000), makeFix(3, 120));
  filter.reset('Other');
  assert.deepEqual(filter.position(makeFix(2, 60, 0, {device_id: 'Other'}), startMs + 2000), makeFix(2, 60, 0, {device_id: 'Other'}));
  filter.reset();
  assert.deepEqual(filter.position(makeFix(4, -100), startMs + 4000), makeFix(4, -100));
});

test('many transient devices remain bounded and an evicted device starts a fresh estimate', () => {
  const filter = new GpsStabilizer();
  for (let i = 0; i < 300; i++) filter.position(makeFix(0, i, 0, {device_id: `Phone-${i}`}), startMs + i);
  assert.equal(filter.devices.size, 256);
  const returning = makeFix(1, 900, 0, {device_id: 'Phone-0'});
  assert.deepEqual(filter.position(returning, startMs + 1000), returning);
});
