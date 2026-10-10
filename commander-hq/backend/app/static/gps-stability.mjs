/** Phone-local display stabilisation. Raw GPS fixes remain the source of truth. */
const finite = Number.isFinite;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const wrapLongitude = value => ((value + 180) % 360 + 360) % 360 - 180;
const DEG = Math.PI / 180;
const MOTION_FRESH_MS = 1500;
const QUIET_WINDOW_MS = 2000;
const MAX_SAMPLE_GAP_MS = 400;
const GPS_RESET_GAP_MS = 10000;

function vectorMagnitude(vector, names, limit) {
  if (!vector || !names.every(name => finite(vector[name]) && Math.abs(vector[name]) <= limit)) return null;
  return Math.min(limit, Math.hypot(...names.map(name => vector[name])));
}

/**
 * Motion is an observation, not proof of zero velocity: a phone moving steadily
 * can have little acceleration. No acceleration is integrated into position.
 * A quiet classification requires both linear acceleration and rotation rate;
 * missing gyro data can show acceleration, but cannot assert that we are still.
 */
export class MotionTracker {
  constructor() { this.reset(); }

  reset() {
    this.lastMs = null;
    this.quietSinceMs = null;
    this.accelerationSquared = null;
    this.rotationSquared = null;
    this.state = 'unknown';
  }

  sample(event, nowMs = Date.now()) {
    if (!finite(nowMs) || nowMs < 0 || nowMs > 253402300799999) { this.reset(); return this.telemetry(nowMs); }
    nowMs = Math.floor(nowMs);
    const acceleration = vectorMagnitude(event?.acceleration, ['x', 'y', 'z'], 200);
    const rotation = vectorMagnitude(event?.rotationRate, ['alpha', 'beta', 'gamma'], 2000);
    const elapsed = this.lastMs === null ? null : nowMs - this.lastMs;
    const contiguous = elapsed !== null && elapsed > 0 && elapsed <= MAX_SAMPLE_GAP_MS;
    if (acceleration === null) {
      this.lastMs = nowMs;
      this.accelerationSquared = null; this.rotationSquared = null;
      this.quietSinceMs = null; this.state = 'unknown';
      return this.telemetry(nowMs);
    }
    if (this.lastMs !== null && nowMs === this.lastMs) return this.telemetry(nowMs);
    this.lastMs = nowMs;

    // Time-based EWMA gives the same response at different browser event rates.
    const weight = contiguous ? 1 - Math.exp(-elapsed / 350) : 1;
    this.accelerationSquared = this.accelerationSquared === null ? acceleration ** 2
      : this.accelerationSquared + weight * (acceleration ** 2 - this.accelerationSquared);
    this.rotationSquared = rotation === null ? null : this.rotationSquared === null ? rotation ** 2
      : this.rotationSquared + weight * (rotation ** 2 - this.rotationSquared);
    const accelerationRms = Math.sqrt(this.accelerationSquared);
    const rotationRms = this.rotationSquared === null ? null : Math.sqrt(this.rotationSquared);
    const quiet = accelerationRms <= 0.18 && rotationRms !== null && rotationRms <= 4;
    if (!quiet || !contiguous) this.quietSinceMs = quiet ? nowMs : null;
    else if (this.quietSinceMs === null) this.quietSinceMs = nowMs;
    if (accelerationRms > 0.45 || (rotationRms !== null && rotationRms > 12)) this.state = 'moving';
    else if (quiet && nowMs - this.quietSinceMs >= QUIET_WINDOW_MS) this.state = 'still';
    else this.state = 'unknown';
    return this.telemetry(nowMs);
  }

  telemetry(nowMs = Date.now()) {
    const age = this.lastMs !== null && finite(nowMs) ? nowMs - this.lastMs : null;
    const fresh = age !== null && age >= 0 && age <= MOTION_FRESH_MS;
    return {
      motion_state: fresh ? this.state : 'unknown',
      motion_unix_ms: this.lastMs,
      motion_age_ms: age === null ? null : clamp(age, 0, 86400000),
      linear_accel_rms_mps2: fresh && this.accelerationSquared !== null
        ? Math.min(200, Math.sqrt(this.accelerationSquared)) : null,
      rotation_rate_rms_dps: fresh && this.rotationSquared !== null
        ? Math.min(2000, Math.sqrt(this.rotationSquared)) : null,
    };
  }
}

function validFix(fix) {
  return fix && typeof fix.device_id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(fix.device_id)
    && finite(fix.lat) && Math.abs(fix.lat) <= 90 && finite(fix.lon) && Math.abs(fix.lon) <= 180
    && Number.isInteger(fix.fix_unix_ms) && fix.fix_unix_ms >= 0
    && fix.fix_unix_ms <= 253402300799999 && finite(fix.accuracy_m) && fix.accuracy_m >= 0;
}

function localFrame(fix) {
  const sin = Math.sin(fix.lat * DEG);
  const denominator = Math.sqrt(1 - 6.6943799901413165e-3 * sin * sin);
  return {
    lat: fix.lat, lon: fix.lon,
    northScale: DEG * 6378137 * (1 - 6.6943799901413165e-3) / denominator ** 3,
    eastScale: DEG * 6378137 / denominator * Math.max(1e-8, Math.abs(Math.cos(fix.lat * DEG))),
  };
}

function toLocal(frame, fix) {
  return {x: wrapLongitude(fix.lon - frame.lon) * frame.eastScale, y: (fix.lat - frame.lat) * frame.northScale};
}

function displayFix(state, fix) {
  return {...fix, lat: clamp(state.frame.lat + state.y / state.frame.northScale, -90, 90),
    lon: wrapLongitude(state.frame.lon + state.x / state.frame.eastScale)};
}

/**
 * Per-device 2-D GPS smoothing for the viewing phone. Only new GPS timestamps
 * count as measurements. Copies keep all original accuracy, age and timestamps;
 * never upload these display positions instead of the raw fix.
 */
export class GpsStabilizer {
  constructor() { this.devices = new Map(); }

  reset(id) {
    if (id === undefined) this.devices.clear();
    else this.devices.delete(id);
  }

  initialise(fix, nowMs) {
    // Bound storage even if callers never explicitly remove departed devices.
    if (!this.devices.has(fix.device_id) && this.devices.size >= 256) {
      let oldestId, oldestTime = Infinity;
      for (const [id, state] of this.devices) {
        if (state.receivedMs < oldestTime) { oldestId = id; oldestTime = state.receivedMs; }
      }
      this.devices.delete(oldestId);
    }
    const state = {frame: localFrame(fix), x: 0, y: 0, rawX: 0, rawY: 0,
      timestampMs: fix.fix_unix_ms, acceptedMs: fix.fix_unix_ms, receivedMs: nowMs,
      accuracy: fix.accuracy_m, candidate: null, steps: []};
    this.devices.set(fix.device_id, state);
    return {...fix};
  }

  position(fix, nowMs = Date.now()) {
    if (!validFix(fix) || !finite(nowMs) || nowMs < 0) return null;
    if (fix.id_conflict) { this.reset(fix.device_id); return {...fix}; }
    const state = this.devices.get(fix.device_id);
    if (!state) return this.initialise(fix, nowMs);
    // Repeated HTTP heartbeats must neither strengthen an old measurement nor
    // renew acquisition time. Out-of-order measurements cannot move the cube.
    if (fix.fix_unix_ms <= state.timestampMs) return displayFix(state, fix);
    if (fix.fix_unix_ms - state.timestampMs > GPS_RESET_GAP_MS
        || nowMs - state.receivedMs > GPS_RESET_GAP_MS || nowMs < state.receivedMs) {
      return this.initialise(fix, nowMs);
    }
    state.timestampMs = fix.fix_unix_ms; state.receivedMs = nowMs;
    const point = toLocal(state.frame, fix);
    const elapsedS = Math.max(0.001, (fix.fix_unix_ms - state.acceptedMs) / 1000);
    const speed = finite(fix.speed_mps) && fix.speed_mps >= 0 ? Math.min(20, fix.speed_mps) : null;
    const uncertainty = Math.max(12, 2.5 * Math.hypot(Math.max(1, state.accuracy), Math.max(1, fix.accuracy_m)));
    const allowance = uncertainty + Math.max(3, (speed ?? 0) + 2) * elapsedS;
    const displacement = Math.hypot(point.x - state.rawX, point.y - state.rawY);
    if (displacement > allowance) {
      const previousCandidate = state.candidate;
      const clusterRadius = Math.max(10, 2 * Math.hypot(previousCandidate?.accuracy ?? 0, fix.accuracy_m));
      const sameCluster = previousCandidate && fix.fix_unix_ms - previousCandidate.timestampMs <= GPS_RESET_GAP_MS
        && Math.hypot(point.x - previousCandidate.x, point.y - previousCandidate.y) <= clusterRadius;
      state.candidate = {x: point.x, y: point.y, accuracy: fix.accuracy_m,
        timestampMs: fix.fix_unix_ms, count: sameCluster ? previousCandidate.count + 1 : 1};
      // A new persistent cluster must be reacquired, including genuine moves
      // that the previous uncertainty/speed estimates failed to describe.
      if (state.candidate.count >= 3) return this.initialise(fix, nowMs);
      return displayFix(state, fix);
    }
    state.candidate = null;
    state.steps.push({x: point.x - state.rawX, y: point.y - state.rawY,
      elapsedS, timestampMs: fix.fix_unix_ms});
    state.steps = state.steps.filter(step => fix.fix_unix_ms - step.timestampMs < 8000).slice(-8);
    const netX = state.steps.reduce((sum, step) => sum + step.x, 0);
    const netY = state.steps.reduce((sum, step) => sum + step.y, 0);
    const pathDistance = state.steps.reduce((sum, step) => sum + Math.hypot(step.x, step.y), 0);
    const pathTimeS = state.steps.reduce((sum, step) => sum + step.elapsedS, 0);
    const netDistance = Math.hypot(netX, netY);
    // Repeated directional GPS travel can disprove IMU "still" even when speed
    // is unavailable. Isolated jitter and back-and-forth noise are not evidence.
    const coherentGpsTravel = state.steps.length >= 3 && netDistance > Math.max(2.5, fix.accuracy_m * 0.75)
      && netDistance / Math.max(0.001, pathDistance) >= 0.9 && netDistance / pathTimeS >= 0.5;
    const motionFresh = finite(fix.motion_age_ms) && fix.motion_age_ms >= 0 && fix.motion_age_ms <= MOTION_FRESH_MS;
    const motion = motionFresh ? fix.motion_state : 'unknown';
    const moving = motion === 'moving' || (speed !== null && speed >= 0.7) || coherentGpsTravel;
    const still = !moving && motion === 'still';
    // Even quiet IMU samples never freeze a position: constant velocity is not
    // observable with acceleration alone. Moving GPS overrides quiet sensors.
    const timeConstantS = moving ? 0.45 : still ? 4 : 1.2;
    const qualityScale = clamp(fix.accuracy_m / 8, 0.5, 4);
    const qualityChange = clamp((state.accuracy + 2) / (fix.accuracy_m + 2), 0.15, 1);
    const weight = clamp((1 - Math.exp(-elapsedS / (timeConstantS * qualityScale))) * qualityChange, 0.02, 1);
    state.x += weight * (point.x - state.x); state.y += weight * (point.y - state.y);
    state.rawX = point.x; state.rawY = point.y;
    state.acceptedMs = fix.fix_unix_ms; state.accuracy = fix.accuracy_m;
    if (Math.hypot(state.x, state.y) > 5000) {
      const display = displayFix(state, fix);
      state.frame = localFrame(display);
      state.x = 0; state.y = 0;
      const rawPoint = toLocal(state.frame, fix);
      state.rawX = rawPoint.x; state.rawY = rawPoint.y;
      return display;
    }
    return displayFix(state, fix);
  }
}
