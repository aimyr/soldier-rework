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
  await ctx.addInitScript(({lat, lon, cameraDenied, motionDenied}) => {
    const state = window.__arSmoke = {
      lat, lon, altitude: 54, watchCalls: 0, watchDeliveries: 0,
      currentCalls: 0, clearCalls: 0, cameraCalls: 0, stopCalls: 0,
      watches: new Map(), tracks: [], cubes: [],
    };
    const position = () => ({timestamp: Date.now(), coords: {
      latitude: state.lat, longitude: state.lon, accuracy: 2,
      altitude: state.altitude, altitudeAccuracy: 1, heading: null, speed: 0,
    }});
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
    };
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission', {
      configurable: true, value: async () => motionDenied ? 'denied' : 'granted',
    });
    // Chromium without physical sensors emits its own initial null sample. Keep
    // that platform sample out of a test whose entire sensor source is mocked.
    for (const type of ['deviceorientation', 'deviceorientationabsolute']) {
      window.addEventListener(type, event => {
        if (!event.__arSmokeSensor) event.stopImmediatePropagation();
      }, true);
    }
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
            const xs = this.__smokePath.map(p => p[0]), ys = this.__smokePath.map(p => p[1]);
            state.cubes.push({width: Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys), points: this.__smokePath.length});
          }
        }
        return original.apply(this, args);
      };
    }
  }, {lat: origin.lat, lon: origin.lon, cameraDenied: false, motionDenied: false, ...mock});
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
  await ctx.route('**/api/gps', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({response, json: {...snapshot, devices: snapshot.devices.filter(d => ids.includes(d.device_id))}});
  });
}

async function begin(page, id, alpha = 0, absolute = true) {
  await page.locator('#device-id').fill(id);
  await page.locator('#start').click();
  await page.waitForFunction(() => document.getElementById('mode').textContent === 'LIVE · GPS AR');
  await page.evaluate(({alpha, absolute}) => window.__arSmoke.orient(alpha, absolute), {alpha, absolute});
}

const count = page => page.locator('#count').textContent();
const uploads = page => page.__gpsRequests.filter(r => r.method === 'POST').length;
const rows = async page => (await (await page.request.get(`${base}/api/gps`)).json()).devices;

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
    await page.screenshot({path: join(screenshots, filename), fullPage: true});
    await ctx.close();
    console.log(`PASS ${label} demo: three shrinking cubes, zero GPS/camera calls, screenshot saved`);
  }

  const ctxA = await context(), ctxB = await context();
  await filterParticipants(ctxA, ['Browser-A', 'Browser-B']);
  await filterParticipants(ctxB, ['Browser-A', 'Browser-B']);
  const pageA = await pageIn(ctxA), pageB = await pageIn(ctxB, {lat: northLatitude(20)});
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

  const relativeCtx = await context();
  await filterParticipants(relativeCtx, ['Browser-A', 'Browser-B', 'Browser-relative']);
  const relative = await pageIn(relativeCtx);
  await begin(relative, 'Browser-relative', 0, false);
  await eventually(() => relative.locator('#heading').textContent(), value => value === 'Heading —', 'Relative orientation requires calibration');
  await relative.locator('#settings').evaluate(node => { node.open = true; });
  await relative.locator('#known-heading').fill('0');
  await relative.locator('#calibrate').click();
  await eventually(() => relative.locator('#heading').textContent(), value => value === '0° · calibrated', 'Known north calibrates relative sensors');
  await eventually(() => rows(relative), devices => devices.some(d => d.device_id === 'Browser-relative' && d.camera_heading_deg === 0 && d.orientation_source === 'calibrated'), 'Calibrated camera pose reaches backend');
  await relative.waitForTimeout(600);
  await relative.evaluate(() => window.__arSmoke.orient(270, false));
  await eventually(() => relative.locator('#heading').textContent(), value => value === '90° · calibrated', 'Calibration offset follows rotation rather than freezing heading');
  await relative.locator('#start').click();
  console.log('PASS relative sensors: known-direction calibration publishes north and follows a 90° rotation');

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
        hidden: document.hidden,
        gps: document.getElementById('gps')?.textContent,
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
