// Run the backend, then AR_BASE_URL=https://127.0.0.1:8443 npm run test:gps
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base = (process.env.AR_BASE_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const deviceId = `GPS-Smoke-${Date.now()}`;
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({ignoreHTTPSErrors: true});
const pageErrors = [], uploads = [];

async function eventually(read, check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

try {
  // Prove GPS collection survives unavailable map/CDN resources. All sensor and
  // permission surfaces are mocked; no physical device permissions are touched.
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin
    ? route.continue() : route.abort());
  await context.addInitScript(() => {
    const state = window.__gpsSmoke = {
      currentCalls: 0, watchCalls: 0, watchDeliveries: 0, clearCalls: 0,
      permissionCalls: 0, cameraCalls: 0, hold: false, pending: null,
      watches: new Map(), wakeCalls: 0, releaseCalls: 0,
      motionPermissionCalls: 0, motionDenied: false, motionListeners: new Set(), motionTimer: null,
    };
    const position = (latitude = 37.5665) => ({timestamp: Date.now(), coords: {
      latitude, longitude: 126.978, accuracy: 3, altitude: 52,
      altitudeAccuracy: 1, heading: null, speed: 0,
    }});
    Object.defineProperty(navigator, 'geolocation', {configurable: true, value: {
      watchPosition(success) {
        const id = ++state.watchCalls;
        state.watches.set(id, success);
        setTimeout(() => {
          if (state.watches.has(id)) { state.watchDeliveries++; success(position()); }
        }, 20);
        return id;
      },
      clearWatch(id) { state.clearCalls++; state.watches.delete(id); },
      getCurrentPosition(success, failure, options) {
        state.currentCalls++;
        if (options.maximumAge !== 0 || !options.enableHighAccuracy || options.timeout !== 10000)
          throw new Error('Periodic refresh must request a fresh high-accuracy fix');
        if (state.hold) state.pending = success;
        else setTimeout(() => success(position()), 20);
      },
    }});
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission', {configurable: true, value: async () => {
      state.permissionCalls++;
      await new Promise(resolve => setTimeout(resolve, 100));
      return 'granted';
    }});
    Object.defineProperty(DeviceMotionEvent, 'requestPermission', {configurable: true, value: async () => {
      state.motionPermissionCalls++;
      await new Promise(resolve => setTimeout(resolve, 100));
      return state.motionDenied ? 'denied' : 'granted';
    }});
    for (const type of ['deviceorientation', 'deviceorientationabsolute', 'devicemotion']) {
      window.addEventListener(type, event => {
        if (!event.__gpsSensor) event.stopImmediatePropagation();
      }, true);
    }
    const addListener = window.addEventListener.bind(window), removeListener = window.removeEventListener.bind(window);
    window.addEventListener = (type, listener, ...args) => {
      if (type === 'devicemotion') state.motionListeners.add(listener);
      return addListener(type, listener, ...args);
    };
    window.removeEventListener = (type, listener, ...args) => {
      if (type === 'devicemotion') state.motionListeners.delete(listener);
      return removeListener(type, listener, ...args);
    };
    state.startMotion = () => {
      state.motionTimer ??= setInterval(() => {
        const event = new DeviceMotionEvent('devicemotion', {acceleration: {x: 0, y: 0, z: 0},
          accelerationIncludingGravity: {x: 0, y: 0, z: 9.8}, rotationRate: {alpha: 0, beta: 0, gamma: 0}, interval: 100});
        Object.defineProperty(event, '__gpsSensor', {value: true});
        window.dispatchEvent(event);
      }, 100);
    };
    state.compass = () => {
      const event = new DeviceOrientationEvent('deviceorientation');
      Object.defineProperties(event, {__gpsSensor: {value: true},
        webkitCompassHeading: {value: 35}, webkitCompassAccuracy: {value: 4}});
      window.dispatchEvent(event);
    };
    state.deliverOldGetter = () => { const callback = state.pending; state.pending = null; callback(position(50)); };
    Object.defineProperty(navigator, 'wakeLock', {configurable: true, value: {request: async () => {
      state.wakeCalls++;
      return {released: false, release() { this.released = true; state.releaseCalls++; }};
    }}});
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable: true, value: () => {
      state.cameraCalls++;
      throw new Error('/gps must not request a camera');
    }});
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/gps' && request.method() === 'POST')
      uploads.push(JSON.parse(request.postData()));
  });
  await page.goto(`${base}/gps`);
  await page.waitForFunction(() => document.getElementById('dev').value);
  await page.locator('#dev').fill(deviceId);
  // Two clicks while permission is pending must not create duplicate watches.
  await page.evaluate(() => { const button = document.getElementById('startBtn'); button.click(); button.click(); });
  await eventually(() => page.locator('#netPill').textContent(), text => text === 'LIVE', 'Initial fix uploaded');
  await page.evaluate(() => { window.__gpsSmoke.compass(); window.__gpsSmoke.startMotion(); });
  await page.waitForTimeout(11000);
  const stationary = await page.evaluate(() => ({current: window.__gpsSmoke.currentCalls,
    watches: window.__gpsSmoke.watchCalls, deliveries: window.__gpsSmoke.watchDeliveries,
    permission: window.__gpsSmoke.permissionCalls, camera: window.__gpsSmoke.cameraCalls,
    motionPermission: window.__gpsSmoke.motionPermissionCalls, motionListeners: window.__gpsSmoke.motionListeners.size}));
  assert.ok(stationary.current >= 2);
  assert.deepEqual({...stationary, current: 2}, {current: 2, watches: 1, deliveries: 1, permission: 1, camera: 0,
    motionPermission: 1, motionListeners: 1});
  const rows = async () => (await (await page.request.get(`${base}/api/gps`)).json()).devices;
  const fresh = (await rows()).find(row => row.device_id === deviceId);
  assert.ok(fresh.fix_age_s < 10 && !fresh.stale, 'Stationary GPS fix remains fresh on the real backend');
  assert.equal(fresh.heading_compass_deg, 35, 'Periodic fixes include current compass data');
  assert.equal(fresh.motion_state, 'still', 'Phone IMU still state reaches the real backend');
  assert.ok(fresh.motion_age_s < 1.5 && fresh.linear_accel_rms_mps2 === 0 && fresh.rotation_rate_rms_dps === 0);
  assert.equal(await page.locator('#motion').textContent(), 'STILL');
  console.log('PASS stationary /gps: periodic fresh fixes, compass and phone IMU still telemetry, no camera or map dependency');

  await page.evaluate(() => { window.__gpsSmoke.hold = true; });
  await page.waitForFunction(() => Boolean(window.__gpsSmoke.pending), {timeout: 7000});
  await page.locator('#startBtn').click();
  const stopped = {uploads: uploads.length, getters: await page.evaluate(() => window.__gpsSmoke.currentCalls)};
  await page.waitForTimeout(5200);
  assert.equal(uploads.length, stopped.uploads, 'Stop prevents uploads');
  assert.equal(await page.evaluate(() => window.__gpsSmoke.currentCalls), stopped.getters, 'Stop clears periodic acquisition');
  assert.equal(await page.evaluate(() => window.__gpsSmoke.watches.size), 0);
  assert.equal(await page.evaluate(() => window.__gpsSmoke.motionListeners.size), 0, 'Stop removes motion listener');
  assert.equal(await page.locator('#netPill').textContent(), 'IDLE');
  assert.equal(await page.locator('#motion').textContent(), 'UNKNOWN', 'Continued sensor events after Stop cannot update IMU state');

  // Browser geolocation cannot cancel getCurrentPosition. Its old callback must
  // remain excluded even after the next run has begun and can accept new fixes.
  await page.evaluate(() => { window.__gpsSmoke.hold = false; });
  await page.locator('#startBtn').click();
  await eventually(() => uploads.length, count => count > stopped.uploads, 'Restart uploads its new watch fix');
  const restartedUploads = uploads.length;
  await page.evaluate(() => window.__gpsSmoke.deliverOldGetter());
  await page.waitForTimeout(400);
  assert.equal(uploads.length, restartedUploads, 'Getter callback from a previous run cannot enqueue');
  assert.ok(uploads.every(fix => fix.lat === 37.5665), 'Stale callback cannot replace current coordinates');
  await page.locator('#startBtn').click();
  assert.equal(await page.evaluate(() => window.__gpsSmoke.motionListeners.size), 0);
  assert.deepEqual(await page.evaluate(() => ({clear: window.__gpsSmoke.clearCalls,
    wake: window.__gpsSmoke.wakeCalls, release: window.__gpsSmoke.releaseCalls})), {clear: 2, wake: 2, release: 2});
  assert.deepEqual(pageErrors, []);
  console.log('PASS /gps Stop/restart: watch cleared, refresh stopped, old getter ignored, wake locks released');

  for (const unavailable of ['denied', 'missing']) {
    const fallback = await context.newPage();
    fallback.on('pageerror', error => pageErrors.push(error.message));
    await fallback.goto(`${base}/gps`);
    await fallback.waitForFunction(() => document.getElementById('dev').value);
    await fallback.locator('#dev').fill(`${deviceId}-${unavailable}`.slice(0, 32));
    await fallback.evaluate(mode => {
      if (mode === 'denied') { window.__gpsSmoke.motionDenied = true; window.__gpsSmoke.startMotion(); }
      else Object.defineProperty(window, 'DeviceMotionEvent', {configurable: true, value: undefined});
    }, unavailable);
    await fallback.locator('#startBtn').click();
    await eventually(() => fallback.locator('#netPill').textContent(), text => text === 'LIVE', `GPS works with ${unavailable} motion sensor`);
    await eventually(() => fallback.locator('#motion').textContent(), text => text === (unavailable === 'denied' ? 'DENIED' : 'UNAVAILABLE'), 'Optional IMU status is visible');
    assert.equal(await fallback.evaluate(() => window.__gpsSmoke.motionListeners.size), 0);
    const id = await fallback.locator('#dev').inputValue();
    const row = (await rows()).find(device => device.device_id === id);
    assert.equal(row.motion_state, 'unknown');
    assert.equal(row.motion_unix_ms, null);
    await fallback.locator('#startBtn').click();
    await fallback.close();
  }
  assert.deepEqual(pageErrors, []);
  console.log('PASS denied/missing motion permission: GPS still uploads and IMU remains optional');
  console.log('GPS browser smoke checks passed.');
} finally {
  await context.close();
  await browser.close();
}
