// Run a backend first, then: npm install && npx playwright install chromium && npm test
// AR_BASE_URL selects the server; AR_SCREENSHOT_DIR selects the screenshot folder.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';

const base = (process.env.AR_BASE_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const screenshots = process.env.AR_SCREENSHOT_DIR ?? '/tmp';
const origin = {lat: 37.5665, lon: 126.978};
const northLatitude = metres => origin.lat + metres / 111000;
const browser = await chromium.launch({headless: true});
const contexts = [];
const pageErrors = [];

async function eventually(read, check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`${description}; latest value: ${JSON.stringify(value)}`);
}

async function context(options = {}) {
  const ctx = await browser.newContext({viewport: {width: 1280, height: 900}, ...options});
  contexts.push(ctx);
  return ctx;
}

async function pageIn(ctx, mock = {}) {
  // No operating-system camera or location permission is touched by these tests.
  await ctx.addInitScript(({lat, lon, accuracy, cameraDenied, motionDenied, imuDenied}) => {
    const state = window.__arSmoke = {
      lat, lon, accuracy, speed: 0, altitude: 54, watchCalls: 0, watchDeliveries: 0,
      currentCalls: 0, clearCalls: 0, cameraCalls: 0, stopCalls: 0,
      watches: new Map(), tracks: [], cubes: [], permissions: [], motionListeners: new Set(),
    };
    const position = () => state.lastPosition = {timestamp: state.frozenTimestamp ?? Date.now(), coords: {
      latitude: state.lat, longitude: state.lon, accuracy: state.accuracy,
      altitude: state.altitude, altitudeAccuracy: 1, heading: null, speed: state.speed,
    }};
    const deliver = callback => { state.watchDeliveries++; callback(position()); };
    Object.defineProperty(navigator, 'geolocation', {configurable: true, value: {
      watchPosition(success) {
        const id = ++state.watchCalls;
        state.watches.set(id, success);
        setTimeout(() => { if (state.watches.has(id)) deliver(success); }, 20);
        return id;
      },
      clearWatch(id) { state.clearCalls++; state.watches.delete(id); },
      getCurrentPosition(success) {
        state.currentCalls++;
        setTimeout(() => success(position()), 20);
      },
    }});
    state.move = (newLat, newLon = state.lon) => {
      state.lat = newLat; state.lon = newLon;
      for (const callback of state.watches.values()) deliver(callback);
      return state.lastPosition;
    };
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission', {
      configurable: true, value: async () => {
        state.permissions.push({type: 'orientation', active: navigator.userActivation.isActive});
        return motionDenied ? 'denied' : 'granted';
      },
    });
    Object.defineProperty(DeviceMotionEvent, 'requestPermission', {
      configurable: true, value: async () => {
        state.permissions.push({type: 'motion', active: navigator.userActivation.isActive});
        return imuDenied ? 'denied' : 'granted';
      },
    });
    // Chromium without physical sensors emits its own initial null sample. Keep
    // that platform sample out of a test whose entire sensor source is mocked.
    for (const type of ['deviceorientation', 'deviceorientationabsolute', 'devicemotion']) {
      window.addEventListener(type, event => {
        if (!event.__arSmokeSensor) event.stopImmediatePropagation();
      }, true);
    }
    const addListener = window.addEventListener.bind(window), removeListener = window.removeEventListener.bind(window);
    window.addEventListener = (type, callback, options) => {
      if (type === 'devicemotion') state.motionListeners.add(callback);
      return addListener(type, callback, options);
    };
    window.removeEventListener = (type, callback, options) => {
      if (type === 'devicemotion') state.motionListeners.delete(callback);
      return removeListener(type, callback, options);
    };
    state.motion = (acceleration = 0, rotation = 0) => {
      const event = new DeviceMotionEvent('devicemotion', {
        acceleration: {x: acceleration, y: 0, z: 0},
        rotationRate: {alpha: rotation, beta: 0, gamma: 0}, interval: 100,
      });
      Object.defineProperty(event, '__arSmokeSensor', {value: true});
      window.dispatchEvent(event);
    };
    state.startMotion = (acceleration = 0, rotation = 0) => {
      clearInterval(state.motionTimer);
      state.motion(acceleration, rotation);
      state.motionTimer = setInterval(() => state.motion(acceleration, rotation), 100);
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable: true, value: async constraints => {
      state.cameraCalls++;
      if (cameraDenied) throw new DOMException('Camera access denied', 'NotAllowedError');
      if (constraints.video?.facingMode?.exact !== 'environment') throw new Error('Rear camera was not requested');
      const source = document.createElement('canvas');
      source.width = 1280; source.height = 720;
      const paint = () => {
        const c = source.getContext('2d');
        c.fillStyle = '#15263a'; c.fillRect(0, 0, source.width, source.height);
        c.fillStyle = '#294454'; c.fillRect(0, source.height / 2, source.width, source.height / 2);
      };
      paint();
      const paintTimer = setInterval(paint, 100);
      const stream = source.captureStream(10);
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings.bind(track);
      track.getSettings = () => ({...settings(), facingMode: 'environment'});
      const stop = track.stop.bind(track);
      track.stop = () => { state.stopCalls++; clearInterval(paintTimer); stop(); };
      state.tracks.push(track);
      return stream;
    }});
    state.orient = (alpha, absolute = true, extra = {}) => {
      const event = new DeviceOrientationEvent(absolute ? 'deviceorientationabsolute' : 'deviceorientation', {
        alpha, beta: 90, gamma: 0, absolute,
      });
      Object.defineProperty(event, '__arSmokeSensor', {value: true});
      for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, {value});
      window.dispatchEvent(event);
    };
    state.nullOrientation = () => {
      const event = new DeviceOrientationEvent('deviceorientationabsolute', {
        alpha: null, beta: null, gamma: null, absolute: true,
      });
      Object.defineProperty(event, '__arSmokeSensor', {value: true});
      window.dispatchEvent(event);
    };

    // Capture the actual rendered cube path, excluding labels and the source video.
    const proto = CanvasRenderingContext2D.prototype;
    const overlay = c => c.canvas.id === 'overlay';
    for (const method of ['beginPath', 'clearRect', 'moveTo', 'lineTo', 'stroke']) {
      const original = proto[method];
      proto[method] = function (...args) {
        if (overlay(this)) {
          if (method === 'clearRect') state.cubes = [];
          if (method === 'beginPath') this.__smokePath = [];
          if (method === 'moveTo' || method === 'lineTo') this.__smokePath?.push([args[0], args[1]]);
          if (method === 'stroke' && this.__smokePath?.length) {
            const transform = this.getTransform(), ratio = Math.min(devicePixelRatio || 1, 2);
            const points = this.__smokePath.map(([x, y]) => [
              (transform.a * x + transform.c * y + transform.e) / ratio,
              (transform.b * x + transform.d * y + transform.f) / ratio,
            ]);
            const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
            state.cubes.push({width: Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys), points: this.__smokePath.length,
              centerX: (Math.max(...xs) + Math.min(...xs)) / 2,
              centerY: (Math.max(...ys) + Math.min(...ys)) / 2});
          }
        }
        return original.apply(this, args);
      };
    }
  }, {lat: origin.lat, lon: origin.lon, accuracy: 2, cameraDenied: false, motionDenied: false, imuDenied: false, ...mock});
  const page = await ctx.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const requests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/gps') requests.push({method: request.method(), body: request.postData()});
  });
  page.__gpsRequests = requests;
  await page.goto(`${base}/ar`);
  await page.waitForFunction(() => Boolean(window.__arSmoke) && document.getElementById('device-id').value);
  return page;
}

async function filterParticipants(ctx, ids) {
  // Keep repeat runs isolated from other phones already sharing this backend.
  // POST requests still reach the real GPS store; only the displayed snapshot is filtered.
  const control = {staleIds: new Set(), latest: []};
  await ctx.route('**/api/gps', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const snapshot = await response.json();
    const devices = snapshot.devices.filter(d => ids.includes(d.device_id)).map(device =>
      control.staleIds.has(device.device_id) ? {...device, stale: true, fix_age_s: 60} : device);
    control.latest = devices;
    await route.fulfill({response, json: {...snapshot, devices}});
  });
  return control;
}

async function begin(page, id, alpha = 0, absolute = true) {
  await page.locator('#device-id').fill(id);
  await page.locator('#start').click();
  await page.waitForFunction(() => document.getElementById('mode').textContent === 'LIVE · GPS AR');
  await page.evaluate(({alpha, absolute}) => window.__arSmoke.orient(alpha, absolute), {alpha, absolute});
}

async function useRawGps(page) {
  await page.locator('#settings').evaluate(node => { node.open = true; });
  await page.locator('#use-stability').uncheck();
  await page.locator('#settings').evaluate(node => { node.open = false; });
}

const count = page => page.locator('#count').textContent();
const uploads = page => page.__gpsRequests.filter(r => r.method === 'POST').length;
const rows = async page => (await (await page.request.get(`${base}/api/gps`)).json()).devices;
const offsets = page => page.evaluate(() => ({yaw: Number(document.getElementById('yaw').value),
  pitch: Number(document.getElementById('pitch').value)}));
const cubeCenter = page => page.evaluate(() => window.__arSmoke.cubes[0]);

async function assertCentered(page, description) {
  await eventually(() => page.evaluate(() => {
    const canvas = document.getElementById('overlay'), video = document.getElementById('camera');
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    const cameraCenter = {x: (box.width - width) / 2 + width / 2,
      y: (box.height - height) / 2 + height / 2};
    const cube = window.__arSmoke.cubes[0];
    return cube ? {dx: cube.centerX - cameraCenter.x, dy: cube.centerY - cameraCenter.y} : null;
  }), difference => difference && Math.abs(difference.dx) < 1 && Math.abs(difference.dy) < 1, description);
}

try {
  await mkdir(screenshots, {recursive: true});
  for (const [label, options, filename] of [
    ['desktop', {}, 'soldier-rework-ar-demo.png'],
    ['mobile', {viewport: {width: 390, height: 844}, screen: {width: 390, height: 844}, isMobile: true, deviceScaleFactor: 2}, 'soldier-rework-ar-demo-mobile.png'],
  ]) {
    const ctx = await context(options), page = await pageIn(ctx);
    await page.locator('#demo').click();
    await eventually(() => count(page), value => value === '3 in view', `${label} demo shows three participants`);
    const cubes = await page.evaluate(() => window.__arSmoke.cubes);
    assert.equal(cubes.length, 3);
    assert.ok(cubes.every(cube => cube.points === 24 && cube.width > 0 && cube.height > 0));
    assert.ok(cubes[0].width < cubes[1].width && cubes[1].width < cubes[2].width, 'Farther demo cubes are smaller');
    assert.equal(page.__gpsRequests.length, 0, 'Demo performs no GPS GET or POST requests');
    assert.equal(await page.evaluate(() => window.__arSmoke.cameraCalls + window.__arSmoke.watchCalls), 0);
    if (label === 'mobile') {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page has no horizontal overflow');
    }
    await page.locator('#alignment-target').selectOption('Robin');
    assert.equal(await page.locator('#align-target-camera').isVisible(), true, 'Selected participant exposes the camera alignment button');
    assert.equal(await page.locator('#align-target-camera').isDisabled(), false);
    await page.screenshot({path: join(screenshots, filename), fullPage: true});
    await ctx.close();
    console.log(`PASS ${label} demo: three shrinking cubes, zero GPS/camera calls, screenshot saved`);
  }

  const ctxA = await context(), ctxB = await context();
  const snapshotA = await filterParticipants(ctxA, ['Browser-A', 'Browser-B']);
  await filterParticipants(ctxB, ['Browser-A', 'Browser-B']);
  const pageA = await pageIn(ctxA), pageB = await pageIn(ctxB, {lat: northLatitude(20)});
  await useRawGps(pageA); await useRawGps(pageB);
  await begin(pageA, 'Browser-A', 0);
  await begin(pageB, 'Browser-B', 180);
  await eventually(() => rows(pageA), devices => ['Browser-A', 'Browser-B'].every(id => devices.some(d => d.device_id === id && d.orientation_source === 'absolute')), 'Backend receives both absolute camera poses');
  const initial = await rows(pageA);
  for (const [id, heading] of [['Browser-A', 0], ['Browser-B', 180]]) {
    const row = initial.find(d => d.device_id === id);
    assert.equal(row.camera_heading_deg, heading);
    assert.ok(Math.abs(row.camera_pitch_deg) < 1e-8);
    assert.ok(Math.abs(row.camera_roll_deg) < 1e-8);
    assert.equal(row.alt_m, 54); assert.equal(row.alt_reference, 'wgs84');
  }
  await eventually(() => count(pageA), value => value === '1 in view', 'A sees B and excludes itself');
  await eventually(() => count(pageB), value => value === '1 in view', 'B sees A and excludes itself');
  const near = await pageA.evaluate(() => window.__arSmoke.cubes[0].width);
  await pageB.evaluate(lat => window.__arSmoke.move(lat), northLatitude(40));
  await eventually(() => pageA.locator('#nearby').textContent(), value => value.includes('40 m'), 'Distance update reaches A');
  const far = await pageA.evaluate(() => window.__arSmoke.cubes[0].width);
  assert.ok(near / far > 1.8 && near / far < 2.4, `Cube perspective scales with distance: ${near} / ${far}`);
  console.log('PASS two phones: real GPS ingest, camera heading/pitch/roll/height, self exclusion, distance perspective');

  // The watch mock reports once at startup; it does not fabricate periodic fixes.
  // A single pose event must also remain valid while the phone is stationary.
  await pageA.waitForTimeout(11000);
  assert.equal(await count(pageA), '1 in view');
  assert.equal(await count(pageB), '1 in view');
  const stationaryA = await pageA.evaluate(() => ({current: window.__arSmoke.currentCalls, watch: window.__arSmoke.watchDeliveries}));
  const stationaryB = await pageB.evaluate(() => ({current: window.__arSmoke.currentCalls, watch: window.__arSmoke.watchDeliveries}));
  assert.ok(stationaryA.current >= 2 && stationaryB.current >= 2, 'Periodic fresh GPS acquisition keeps stationary phones active');
  assert.equal(stationaryA.watch, 1); assert.equal(stationaryB.watch, 2);
  const stationaryRows = await rows(pageA);
  assert.ok(stationaryRows.filter(d => ['Browser-A', 'Browser-B'].includes(d.device_id)).every(d => d.fix_age_s < 10));
  assert.match(await pageA.locator('#heading').textContent(), /^0° · absolute$/);
  console.log('PASS stationary phones: orientation persists beyond 3 s and GPS refresh persists beyond 10 s');

  assert.equal(await pageA.locator('#alignment-target').inputValue(), '');
  assert.equal(await pageA.locator('#align-target').isDisabled(), true, 'Alignment requires a selected participant');
  assert.equal(await pageA.locator('#align-target-camera').isVisible(), false);
  // The camera is physically aimed at B, but its sensors report a 20° yaw and
  // -10° pitch error. Alignment must move the actual rendered cube to the +.
  await pageA.evaluate(() => window.__arSmoke.orient(340, true, {beta: 80}));
  await eventually(() => pageA.locator('#heading').textContent(), value => value === '20° · absolute', 'Biased sensor heading is applied');
  const biasedCube = await cubeCenter(pageA);
  await pageA.locator('#alignment-target').selectOption('Browser-B');
  await eventually(() => pageA.locator('#align-target').isDisabled(), disabled => !disabled, 'Fresh selected participant allows alignment');
  assert.equal(await pageA.locator('#align-target-camera').isVisible(), true);
  assert.equal(await pageA.locator('#align-target-camera').isDisabled(), false);
  await pageA.locator('#align-target').click();
  assert.deepEqual(await offsets(pageA), {yaw: -20, pitch: 10});
  await assertCentered(pageA, 'Align-to-participant centers the rendered cube in the camera rectangle');
  const centeredCube = await cubeCenter(pageA);
  assert.ok(Math.abs(biasedCube.centerX - centeredCube.centerX) > 100, 'Yaw alignment corrects a visible horizontal error');
  assert.ok(Math.abs(biasedCube.centerY - centeredCube.centerY) > 50, 'Pitch alignment corrects a visible vertical error');
  await eventually(() => rows(pageA), devices => devices.some(d => d.device_id === 'Browser-A'
    && Math.abs(d.camera_heading_deg) < 0.1 && Math.abs(d.camera_pitch_deg) < 0.1), 'Alignment publishes the corrected pose without a new sensor event');
  for (const [direction, axis, sign] of [['left', 'centerX', -1], ['right', 'centerX', 1],
    ['up', 'centerY', -1], ['down', 'centerY', 1]]) {
    const before = await cubeCenter(pageA);
    await pageA.locator(`[data-nudge="${direction}"]`).click();
    await eventually(() => cubeCenter(pageA), after => after && sign * (after[axis] - before[axis]) > 2,
      `${direction} fine arrow moves the rendered cube in its labelled screen direction`);
  }
  await pageA.locator('#reset-alignment').click();
  assert.deepEqual(await offsets(pageA), {yaw: 0, pitch: 0});
  await eventually(() => rows(pageA), devices => devices.some(d => d.device_id === 'Browser-A'
    && Math.abs(d.camera_heading_deg - 20) < 0.1 && Math.abs(d.camera_pitch_deg + 10) < 0.1), 'Reset publishes the uncorrected pose without a new sensor event');
  await pageA.locator('#align-target-camera').click();
  await assertCentered(pageA, 'A second alignment replaces the previous correction');
  snapshotA.staleIds.add('Browser-B');
  await eventually(() => pageA.locator('#align-target').isDisabled(), disabled => disabled, 'A stale selected participant disables alignment');
  assert.equal(await pageA.locator('#align-target-camera').isDisabled(), true);
  assert.equal(await pageA.locator('#alignment-target').inputValue(), 'Browser-B', 'Stale selection remains identifiable');
  assert.equal(await pageA.locator('#alignment-target option[value="Browser-B"]').evaluate(option => option.disabled), true);
  snapshotA.staleIds.clear();
  await eventually(() => pageA.locator('#align-target').isDisabled(), disabled => !disabled, 'Fresh GPS restores selected participant alignment');
  await pageA.locator('#alignment-target').selectOption('');
  assert.equal(await pageA.locator('#align-target').isDisabled(), true);
  assert.equal(await pageA.locator('#align-target-camera').isVisible(), false);
  await pageA.locator('#reset-alignment').click();
  console.log('PASS participant alignment: rendered center, yaw/pitch correction, all four arrows, reset telemetry, stale/unselected controls');

  await pageA.evaluate(() => window.__arSmoke.orient(180));
  await eventually(() => count(pageA), value => value === '0 in view', 'Turning away removes the target');
  await pageA.evaluate(() => window.__arSmoke.nullOrientation());
  await eventually(() => pageA.locator('#heading').textContent(), value => value === 'Heading —', 'Null orientation invalidates the camera pose');
  for (const page of [pageA, pageB]) {
    await page.locator('#start').click();
    const state = await page.evaluate(() => ({tracksEnded: window.__arSmoke.tracks.every(t => t.readyState === 'ended'),
      watches: window.__arSmoke.watches.size, clearCalls: window.__arSmoke.clearCalls, stopCalls: window.__arSmoke.stopCalls}));
    assert.deepEqual(state, {tracksEnded: true, watches: 0, clearCalls: 1, stopCalls: 1});
  }
  const stoppedUploads = [uploads(pageA), uploads(pageB)];
  await pageA.waitForTimeout(1300);
  assert.deepEqual([uploads(pageA), uploads(pageB)], stoppedUploads, 'Stop prevents further uploads');
  console.log('PASS turning, null sensor data, Stop: camera tracks ended, geolocation cleared, uploads stopped');

  const deniedCtx = await context(), denied = await pageIn(deniedCtx, {cameraDenied: true});
  await denied.locator('#start').click();
  await eventually(() => denied.locator('#status').textContent(), value => value.includes('NotAllowedError'), 'Denied camera permission produces an error');
  assert.equal(await denied.locator('#mode').textContent(), 'STANDBY');
  assert.equal(uploads(denied), 0);
  assert.equal(await denied.evaluate(() => window.__arSmoke.watchCalls), 0);
  console.log('PASS camera permission denied: visible error, no location watch or uploads');

  // Resume the second real phone so the relative-sensor calibration has a fresh
  // participant reference throughout the test, independent of previous timing.
  await begin(pageB, 'Browser-B', 180);
  const relativeCtx = await context();
  await filterParticipants(relativeCtx, ['Browser-A', 'Browser-B', 'Browser-relative']);
  const relative = await pageIn(relativeCtx);
  await useRawGps(relative);
  await begin(relative, 'Browser-relative', 340, false);
  await eventually(() => relative.locator('#heading').textContent(), value => value === 'Heading —', 'Relative orientation requires calibration');
  await eventually(() => relative.locator('#alignment-target option[value="Browser-B"]').count(), value => value === 1, 'Fresh reference phone is available to relative sensors');
  assert.equal(await relative.locator('#align-target').isDisabled(), true, 'Relative alignment also requires a selected phone');
  await relative.locator('#alignment-target').selectOption('Browser-B');
  await eventually(() => relative.locator('#align-target').isDisabled(), disabled => !disabled, 'Relative orientation supports participant calibration');
  await relative.locator('#align-target').click();
  assert.deepEqual(await offsets(relative), {yaw: -20, pitch: 0});
  await assertCentered(relative, 'Participant alignment centers the cube with no absolute heading sensor');
  await eventually(() => rows(relative), devices => devices.some(d => d.device_id === 'Browser-relative'
    && d.camera_heading_deg === 0 && d.orientation_source === 'calibrated'), 'Participant alignment establishes and publishes a calibrated north frame');
  await relative.waitForTimeout(600);
  await relative.evaluate(() => window.__arSmoke.orient(250, false));
  await eventually(() => relative.locator('#heading').textContent(), value => value === '90° · calibrated', 'Participant calibration follows subsequent relative rotation');
  await relative.locator('#reset-alignment').click();
  assert.deepEqual(await offsets(relative), {yaw: 0, pitch: 0});
  await eventually(() => relative.locator('#heading').textContent(), value => value === 'Heading —', 'Reset removes a participant-created relative north frame');
  await relative.waitForTimeout(600);
  await relative.evaluate(() => window.__arSmoke.orient(0, false));
  console.log('PASS relative participant alignment: calibrated north, rendered cube center, following turns, reset removes north frame');

  // Keep the separate known-direction workflow covered after clearing the
  // participant calibration, so one path cannot mask a defect in the other.
  await relative.locator('#settings').evaluate(node => { node.open = true; });
  await relative.locator('#known-heading').fill('0');
  await relative.locator('#calibrate').click();
  await eventually(() => relative.locator('#heading').textContent(), value => value === '0° · calibrated', 'Known north calibrates relative sensors');
  await eventually(() => rows(relative), devices => devices.some(d => d.device_id === 'Browser-relative' && d.camera_heading_deg === 0 && d.orientation_source === 'calibrated'), 'Calibrated camera pose reaches backend');
  await relative.waitForTimeout(600);
  await relative.evaluate(() => window.__arSmoke.orient(270, false));
  await eventually(() => relative.locator('#heading').textContent(), value => value === '90° · calibrated', 'Calibration offset follows rotation rather than freezing heading');
  await relative.locator('#start').click();
  await pageB.locator('#start').click();
  console.log('PASS relative sensors: known-direction calibration publishes north and follows a 90° rotation');

  const fusionAContext = await context(), fusionBContext = await context(), rawContext = await context();
  const fusionASnapshot = await filterParticipants(fusionAContext, ['Fusion-A', 'Fusion-B']);
  await filterParticipants(fusionBContext, ['Fusion-A', 'Fusion-B']);
  const rawSnapshot = await filterParticipants(rawContext, ['Fusion-raw', 'Fusion-B']);
  const fusionA = await pageIn(fusionAContext, {accuracy: 8});
  const fusionB = await pageIn(fusionBContext, {lat: northLatitude(40), accuracy: 8});
  const rawViewer = await pageIn(rawContext, {accuracy: 8});
  assert.equal(await fusionA.locator('#use-stability').isChecked(), true, 'Stabilisation is enabled by default');
  await begin(fusionA, 'Fusion-A', 0); await begin(fusionB, 'Fusion-B', 180);
  await begin(rawViewer, 'Fusion-raw', 0);
  await eventually(() => count(rawViewer), value => value === '1 in view', 'Unknown IMU data does not block camera GPS AR');
  assert.match(await rawViewer.locator('#motion-status').textContent(), /нет свежих данных/);
  await useRawGps(rawViewer);
  for (const page of [fusionA, fusionB]) {
    assert.deepEqual(await page.evaluate(() => window.__arSmoke.permissions), [
      {type: 'orientation', active: true}, {type: 'motion', active: true},
    ], 'Both permissions are invoked while the Start click supplies user activation');
    await page.evaluate(() => window.__arSmoke.startMotion());
    await eventually(() => page.locator('#motion-status').textContent(), text => text.includes('покой'), 'Continuous quiet IMU samples establish stillness');
  }
  await eventually(() => rows(fusionA), devices => ['Fusion-A', 'Fusion-B'].every(id => devices.some(device =>
    device.device_id === id && device.motion_state === 'still' && device.motion_age_s < 1.5)), 'Both phones publish their own fresh motion samples');

  const eastLongitude = metres => origin.lon + metres / (111000 * Math.cos(origin.lat * Math.PI / 180));
  const stablePath = [], rawPath = [];
  for (const metres of [4, -4, 4, -4, 4, -4]) {
    const fix = await fusionB.evaluate(({lat, lon}) => window.__arSmoke.move(lat, lon),
      {lat: northLatitude(40), lon: eastLongitude(metres)});
    const backendRow = await eventually(() => rows(fusionA), devices => devices.some(device =>
      device.device_id === 'Fusion-B' && device.lon === fix.coords.longitude && device.fix_unix_ms >= fix.timestamp), 'Raw jitter fix reaches backend');
    const row = backendRow.find(device => device.device_id === 'Fusion-B');
    const uploaded = fusionB.__gpsRequests.filter(request => request.method === 'POST').map(request => JSON.parse(request.body))
      .findLast(body => body.fix_unix_ms === row.fix_unix_ms);
    assert.ok(uploaded, 'Backend GPS timestamp corresponds to a raw phone upload');
    assert.deepEqual([row.lat, row.lon, row.accuracy_m, row.fix_unix_ms],
      [uploaded.lat, uploaded.lon, uploaded.accuracy_m, uploaded.fix_unix_ms], 'Stabilisation never rewrites stored raw GPS fields');
    for (const snapshot of [fusionASnapshot, rawSnapshot]) {
      await eventually(() => snapshot.latest.find(device => device.device_id === 'Fusion-B'),
        device => device && device.lon === fix.coords.longitude && device.fix_unix_ms >= fix.timestamp, 'Viewer receives the jitter fix');
    }
    await fusionA.waitForTimeout(150);
    stablePath.push((await cubeCenter(fusionA)).centerX); rawPath.push((await cubeCenter(rawViewer)).centerX);
    await fusionA.waitForTimeout(450);
  }
  const travelled = path => path.slice(1).reduce((sum, point, index) => sum + Math.abs(point - path[index]), 0);
  assert.ok(travelled(stablePath) < travelled(rawPath) * 0.65,
    `Still-phone cube jitter is reduced: stable ${travelled(stablePath)}, raw ${travelled(rawPath)}`);
  console.log(`PASS IMU permissions, unknown fallback, two-phone telemetry, raw GPS preservation, stationary cube jitter reduction (${travelled(stablePath).toFixed(1)} px vs ${travelled(rawPath).toFixed(1)} px)`);

  await fusionB.evaluate(() => { window.__arSmoke.speed = 5; window.__arSmoke.startMotion(1, 25); });
  await eventually(() => fusionB.locator('#motion-status').textContent(), text => text.includes('движение'), 'Moving IMU is reflected in the HUD');
  const beforeTravel = (await cubeCenter(fusionA)).centerX;
  for (const metres of [2, 8, 14]) {
    const fix = await fusionB.evaluate(({lat, lon}) => window.__arSmoke.move(lat, lon),
      {lat: northLatitude(40), lon: eastLongitude(metres)});
    for (const snapshot of [fusionASnapshot, rawSnapshot]) {
      await eventually(() => snapshot.latest.find(device => device.device_id === 'Fusion-B'),
        device => device && device.lon === fix.coords.longitude && device.fix_unix_ms >= fix.timestamp, 'Viewer follows actual moving GPS');
    }
    await fusionA.waitForTimeout(600);
  }
  const movingStable = await cubeCenter(fusionA), movingRaw = await cubeCenter(rawViewer);
  assert.ok(movingStable.centerX - beforeTravel > 100, 'Moving participant is followed rather than frozen');
  assert.ok(Math.abs(movingStable.centerX - movingRaw.centerX) < 45, 'Moving mode has bounded display lag');
  const motionRows = await rows(fusionA);
  const stillRow = motionRows.find(device => device.device_id === 'Fusion-A');
  const movingRow = motionRows.find(device => device.device_id === 'Fusion-B');
  assert.equal(stillRow.motion_state, 'still'); assert.equal(stillRow.linear_accel_rms_mps2, 0);
  assert.equal(movingRow.motion_state, 'moving'); assert.ok(movingRow.linear_accel_rms_mps2 > 0.45);
  assert.ok(movingRow.rotation_rate_rms_dps > 12);
  for (const row of [stillRow, movingRow]) {
    assert.ok(row.motion_unix_ms <= Date.now() && Date.now() - row.motion_unix_ms < 2500);
  }
  console.log('PASS moving IMU/GPS: cube follows travel with bounded lag and telemetry remains attached to the correct phone');

  const frozenTimestamp = await fusionA.evaluate(({lat, lon}) => {
    const fix = window.__arSmoke.move(lat, lon);
    window.__arSmoke.frozenTimestamp = fix.timestamp;
    return fix.timestamp;
  }, origin);
  await fusionA.waitForTimeout(11100);
  await eventually(() => count(fusionA), value => value === '0 in view', 'Fresh IMU does not keep old GPS cubes alive');
  assert.match(await fusionA.locator('#gps').textContent(), /stale/);
  assert.match(await fusionA.locator('#motion-status').textContent(), /покой/);
  const staleRow = (await rows(fusionA)).find(device => device.device_id === 'Fusion-A');
  assert.equal(staleRow.fix_unix_ms, frozenTimestamp); assert.ok(staleRow.fix_age_s > 10 && staleRow.stale);
  const expiredUploadCount = uploads(fusionA);
  await fusionA.waitForTimeout(1300);
  assert.equal(uploads(fusionA), expiredUploadCount, 'Sensor updates do not restart uploads with expired GPS');
  await fusionA.locator('#start').click();
  assert.equal(await fusionA.evaluate(() => window.__arSmoke.motionListeners.size), 0, 'Stop removes the IMU listener');
  assert.equal(await fusionA.locator('#motion-status').textContent(), 'IMU —');
  await fusionA.evaluate(() => { window.__arSmoke.frozenTimestamp = null; });
  const restartUploadIndex = fusionA.__gpsRequests.length;
  await begin(fusionA, 'Fusion-A', 0);
  await eventually(() => fusionA.__gpsRequests.slice(restartUploadIndex).filter(request => request.method === 'POST'),
    requests => requests.length > 0, 'Restart sends a fresh GPS fix');
  const restartedMotion = fusionA.__gpsRequests.slice(restartUploadIndex).filter(request => request.method === 'POST')
    .map(request => JSON.parse(request.body));
  assert.equal(restartedMotion[0].motion_state, 'unknown', 'Restart clears the prior stillness classification');
  for (const page of [fusionA, fusionB, rawViewer]) {
    await page.locator('#start').click();
    assert.equal(await page.evaluate(() => window.__arSmoke.motionListeners.size), 0);
    assert.ok(await page.evaluate(() => window.__arSmoke.tracks.every(track => track.readyState === 'ended')));
    assert.equal(await page.evaluate(() => window.__arSmoke.watches.size), 0);
  }
  const fusionStoppedUploads = [fusionA, fusionB, rawViewer].map(uploads);
  await fusionA.waitForTimeout(1300);
  assert.deepEqual([fusionA, fusionB, rawViewer].map(uploads), fusionStoppedUploads);
  console.log('PASS GPS age independence, IMU listener cleanup, reset on restart, no uploads after Stop');

  const imuDeniedContext = await context(), imuDeniedPage = await pageIn(imuDeniedContext, {imuDenied: true});
  await begin(imuDeniedPage, 'Fusion-denied', 0);
  await imuDeniedPage.evaluate(() => window.__arSmoke.startMotion(1, 25));
  await eventually(() => rows(imuDeniedPage), devices => devices.some(device => device.device_id === 'Fusion-denied'), 'IMU denial still allows raw GPS sharing');
  const deniedMotionRow = (await rows(imuDeniedPage)).find(device => device.device_id === 'Fusion-denied');
  assert.equal(deniedMotionRow.motion_state, 'unknown'); assert.equal(deniedMotionRow.motion_unix_ms, null);
  assert.equal(deniedMotionRow.camera_heading_deg, 0);
  assert.equal(await imuDeniedPage.locator('#mode').textContent(), 'LIVE · GPS AR');
  await eventually(() => imuDeniedPage.locator('#motion-status').textContent(), text => text.includes('нет доступа'), 'Denied IMU access appears in the HUD');
  assert.equal(await imuDeniedPage.evaluate(() => window.__arSmoke.motionListeners.size), 0);
  await imuDeniedPage.locator('#start').click();
  console.log('PASS IMU permission denied: camera and raw GPS sharing continue, denied motion samples are ignored');

  assert.deepEqual(pageErrors, [], 'No unhandled browser runtime errors');
  console.log('AR browser smoke checks passed.');
} catch (error) {
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      if (page.isClosed()) continue;
      console.error('Browser failure state:', await page.evaluate(() => ({
        mode: document.getElementById('mode')?.textContent,
        heading: document.getElementById('heading')?.textContent,
        count: document.getElementById('count')?.textContent,
        status: document.getElementById('status')?.textContent,
        nearby: document.getElementById('nearby')?.textContent,
        alignment: document.getElementById('alignment-message')?.textContent,
        alignmentTarget: document.getElementById('alignment-target')?.value,
        yaw: document.getElementById('yaw')?.value, pitch: document.getElementById('pitch')?.value,
        cubes: window.__arSmoke?.cubes,
        hidden: document.hidden,
        gps: document.getElementById('gps')?.textContent,
        motion: document.getElementById('motion-status')?.textContent,
        calls: window.__arSmoke && {watch: window.__arSmoke.watchCalls, current: window.__arSmoke.currentCalls,
          clear: window.__arSmoke.clearCalls, stop: window.__arSmoke.stopCalls},
      })));
      console.error('Latest GPS uploads:', page.__gpsRequests?.filter(r => r.method === 'POST').slice(-2));
    }
  }
  throw error;
} finally {
  await Promise.allSettled(contexts.map(ctx => ctx.close()));
  await browser.close();
}
