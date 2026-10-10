import {relativePosition, cameraBasis, projectPoint, cubeSegments, orientationFromEvent, alignmentCorrection} from './ar-math.mjs?v=alignment-1';
import {MotionTracker, GpsStabilizer} from './gps-stability.mjs?v=stability-2';

const $ = id => document.getElementById(id);
const video = $('camera'), canvas = $('overlay'), ctx = canvas.getContext('2d');
const finite = v => typeof v === 'number' && Number.isFinite(v);
const wrap = v => ((v % 360) + 360) % 360;
const angleDelta = (a, b) => ((a - b + 540) % 360) - 180;
const number = (id, fallback, min, max) => {
  const value = Number($(id).value);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
};
let mode = 'idle', generation = 0, stream = null, watchId = null, timers = [], animation = null;
let ownFix = null, ownFixReceivedAt = 0, pose = null, poseAt = 0, lastEvent = null;
let calibrationOffset = null, webkitOffset = null, webkitOffsetAt = 0, devices = [], uploadBusy = false, pollBusy = false, fixRequestBusy = false;
let manualFov = false;
let networkMessage = '', sensorMessage = '', cameraWarning = '', lastHud = 0;
let alignmentChoices = '', targetRelativeCalibration = false;
const requests = new Set();
const motionTracker = new MotionTracker(), gpsStabilizer = new GpsStabilizer();
let motionAccess = 'unknown';

function persistentId() {
  let stored;
  try { stored = localStorage.getItem('squad_gps_device_id'); } catch { /* private browsing */ }
  if (stored && /^[A-Za-z0-9_-]{1,32}$/.test(stored)) return stored;
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), v => v.toString(16).padStart(2, '0')).join('');
  const prefix = /iPhone/i.test(navigator.userAgent) ? 'iPhone' : /Android/i.test(navigator.userAgent) ? 'Android' : 'Phone';
  const id = `${prefix}-${suffix}`;
  try { localStorage.setItem('squad_gps_device_id', id); } catch { /* use for this session */ }
  return id;
}
$('device-id').value = persistentId();

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function currentPose() {
  const raw = mode === 'demo' ? {headingDeg: wrap(number('demo-yaw', 0, -180, 180)),
    pitchDeg: number('demo-pitch', 0, -60, 60), rollDeg: 0, source: 'demo'} : pose;
  // Orientation events are change notifications, not periodic sensor heartbeats.
  // A stationary pose stays valid until null data, page hiding or Stop.
  if (!raw || !finite(raw.headingDeg)) return null;
  return {...raw, headingDeg: wrap(raw.headingDeg + number('yaw', 0, -180, 180)),
    pitchDeg: Math.max(-90, Math.min(90, raw.pitchDeg + number('pitch', 0, -90, 90)))};
}
function fixFresh() {
  return ownFix && Date.now() - ownFixReceivedAt < 10000 && Date.now() - ownFix.fix_unix_ms < 10000;
}
function updateLiveStatus() {
  if (mode !== 'live') return;
  const problems = [cameraWarning, sensorMessage, networkMessage].filter(Boolean);
  if (!fixFresh()) problems.push('Waiting for a fresh GPS fix. Go outdoors; no cubes are drawn until GPS is ready.');
  if (!currentPose()) problems.push('Camera heading unavailable. Allow motion access, or set a known direction below if relative orientation is available.');
  if (ownFix && ownFix.accuracy_m > 25) problems.push(`GPS uncertainty ±${Math.round(ownFix.accuracy_m)} m; markers are approximate.`);
  status(problems.join(' ') || 'Sharing GPS and camera direction. Other phones on /ar or /gps appear here.', problems.length > 0);
}
function screenAngle() { return screen.orientation?.angle ?? window.orientation ?? 0; }
function onMotion(event) {
  if (mode !== 'live' && mode !== 'starting') return;
  motionTracker.sample(event);
}
function updateMotionStatus() {
  const sample = motionTracker.telemetry();
  const labels = {still: 'покой', moving: 'движение', unknown: 'нет свежих данных'};
  $('motion-status').textContent = mode === 'demo' ? 'IMU · demo' : mode !== 'live' ? 'IMU —'
    : motionAccess === 'denied' ? 'IMU · нет доступа' : `IMU · ${labels[sample.motion_state]}`;
}
function onOrientation(event) {
  if (mode !== 'live' && mode !== 'starting') return;
  if (pose?.source === 'absolute' && event.absolute !== true && !finite(event.webkitCompassHeading)) return;
  const raw = orientationFromEvent(event, screenAngle(), calibrationOffset);
  if (!raw) { pose = null; lastEvent = null; return; }
  if (raw.source === 'webkit') {
    webkitOffset = angleDelta(raw.headingDeg, raw.relativeAlphaDeg);
    webkitOffsetAt = Date.now();
  } else if (raw.source === 'relative' && finite(webkitOffset)) {
    // The top edge has no bearing when exactly upright. Keep the last north
    // alignment as a relative calibration through that singularity.
    raw.headingDeg = wrap(raw.relativeAlphaDeg + webkitOffset);
    raw.source = Date.now() - webkitOffsetAt < 3000 ? 'webkit' : 'calibrated';
  }
  if (pose?.source === 'absolute' && raw.source === 'relative') return;
  lastEvent = event;
  if (pose && raw.source === pose.source && finite(pose.headingDeg) && finite(raw.headingDeg) && Date.now() - poseAt < 500) {
    raw.headingDeg = wrap(pose.headingDeg + angleDelta(raw.headingDeg, pose.headingDeg) * 0.4);
    raw.pitchDeg = pose.pitchDeg + (raw.pitchDeg - pose.pitchDeg) * 0.4;
    raw.rollDeg = pose.rollDeg + angleDelta(raw.rollDeg, pose.rollDeg) * 0.4;
  }
  pose = raw;
  poseAt = Date.now();
}
async function request(url, options = {}) {
  const controller = new AbortController();
  requests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {...options, signal: controller.signal, cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); requests.delete(controller); }
}
function payload() {
  if (!fixFresh()) return null;
  const camera = currentPose();
  return {...ownFix, ...motionTracker.telemetry(), fix_age_ms: Math.max(0, Date.now() - ownFix.fix_unix_ms),
    camera_heading_deg: camera?.headingDeg ?? null, camera_pitch_deg: camera?.pitchDeg ?? null,
    camera_roll_deg: camera?.rollDeg ?? null, orientation_unix_ms: camera ? poseAt : Date.now(),
    orientation_age_ms: camera ? Math.max(0, Date.now() - poseAt) : 0,
    orientation_source: camera ? camera.source : 'none'};
}
async function upload() {
  const body = payload();
  if (mode !== 'live' || uploadBusy || !body) return;
  const token = generation;
  uploadBusy = true;
  try {
    const response = await request('/api/gps', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    if (token !== generation) return;
    networkMessage = response.accepted === false ? `GPS update rejected: ${response.reason ?? 'out-of-order fix'}.` : '';
    if (response.id_conflict) networkMessage = 'Another phone is using this ID. Stop and choose a unique Phone ID.';
  } catch (error) { if (token === generation) networkMessage = `Upload failed (${error.message}). Check the laptop connection.`; }
  finally { if (token === generation) { uploadBusy = false; updateLiveStatus(); } }
}
async function poll() {
  if (mode !== 'live' || pollBusy) return;
  const token = generation;
  pollBusy = true;
  try {
    const snapshot = await request('/api/gps');
    if (token !== generation) return;
    devices = Array.isArray(snapshot.devices) ? snapshot.devices : [];
    const receivedAt = Date.now();
    devices.forEach(device => { device.snapshot_received_ms = receivedAt; });
    updateNearby();
  } catch (error) {
    if (token === generation) { networkMessage = `Participant update failed (${error.message}).`; updateLiveStatus(); }
  } finally { if (token === generation) pollBusy = false; }
}
function targets() {
  if (!fixFresh() && mode !== 'demo') return [];
  return devices.filter(d => d.device_id !== ownFix.device_id && !d.id_conflict && !d.offline && !d.stale &&
    finite(d.lat) && finite(d.lon) && (mode === 'demo' || (d.fix_age_s ?? d.age_s ?? 999) + (Date.now() - (d.snapshot_received_ms ?? 0)) / 1000 < 10));
}
function relative(target) {
  return relativePosition(displayPosition(ownFix), displayPosition(target), {useAltitude: $('use-height').checked,
    altitudeOffsetM: -number('altitude-offset', 0, -100, 100), maxAltitudeAccuracyM: number('max-alt-error', 15, 1, 50)});
}
function displayPosition(fix) {
  if (!fix || mode === 'demo' || !$('use-stability').checked) return fix;
  const elapsedMs = Math.max(0, Date.now() - (fix.snapshot_received_ms ?? Date.now()));
  const sample = fix === ownFix ? {...fix, ...motionTracker.telemetry()} : {...fix,
    motion_age_ms: finite(fix.motion_age_s) ? fix.motion_age_s * 1000 + elapsedMs : null};
  // Stabilization affects this phone's display only. Uploads and the GPS store
  // retain the original coordinates, timestamp and reported uncertainty.
  return gpsStabilizer.position(sample) ?? fix;
}
function updateNearby() {
  const list = $('nearby');
  list.replaceChildren();
  const nearby = targets().sort((a, b) => relative(a).distanceM - relative(b).distanceM);
  updateAlignmentTargets(nearby);
  for (const target of nearby) {
    const p = relative(target), card = document.createElement('div');
    card.className = 'participant';
    const icon = document.createElement('i'), name = document.createElement('strong'), text = document.createElement('span');
    icon.textContent = '◇'; name.textContent = target.device_id;
    text.textContent = `${Math.round(p.distanceM)} m · ±${Math.round(target.accuracy_m ?? 0)} m${p.altitudeUsed ? ` · Δh ${p.up >= 0 ? '+' : ''}${p.up.toFixed(1)} m` : ' · flat height'}`;
    card.append(icon, name, text); list.append(card);
  }
}
function alignmentPose() {
  if (currentPose()) return currentPose();
  // A visual reference can supply north alignment when the phone only has
  // relative orientation. The captured alpha still follows subsequent turns.
  if (mode === 'live' && pose && finite(pose.relativeAlphaDeg)) {
    return {...pose, headingDeg: wrap(pose.relativeAlphaDeg + number('yaw', 0, -180, 180)),
      pitchDeg: Math.max(-90, Math.min(90, pose.pitchDeg + number('pitch', 0, -90, 90)))};
  }
  return null;
}
function updateAlignmentTargets(nearby = targets()) {
  const picker = $('alignment-target'), selected = picker.value;
  const eligible = nearby.filter(target => {
    const distance = relative(target).distanceM;
    return distance >= 2 && distance <= 2000;
  });
  const ids = eligible.map(target => target.device_id).sort();
  const key = JSON.stringify([ids, selected && !ids.includes(selected) ? selected : '']);
  if (key !== alignmentChoices) {
    picker.replaceChildren(new Option('Выбери телефон', ''));
    for (const id of ids) picker.add(new Option(id, id));
    if (selected && !ids.includes(selected)) {
      const missing = new Option(`${selected} — нет свежего GPS`, selected);
      missing.disabled = true; picker.add(missing);
    }
    picker.value = selected;
    alignmentChoices = key;
  }
  const target = eligible.find(device => device.device_id === picker.value);
  const ready = (mode === 'demo' || (mode === 'live' && fixFresh())) && Boolean(alignmentPose());
  $('align-target').disabled = !target || !ready;
  $('align-target-camera').disabled = !target || !ready;
  $('align-target-camera').hidden = !selected || (mode !== 'live' && mode !== 'demo');
  $('align-target-camera').textContent = selected ? `Совместить с ${selected}` : 'Совместить';
  document.querySelectorAll('[data-nudge]').forEach(button => { button.disabled = !ready || !currentPose(); });
  if (mode !== 'live' && mode !== 'demo') {
    $('alignment-quality').textContent = 'Сначала включи камеру и GPS. У участника должна быть открыта страница GPS или AR.';
  } else if (!ready) {
    $('alignment-quality').textContent = 'Ждём свежий GPS и датчики движения на этом телефоне.';
  } else if (target) {
    const p = relative(target);
    $('alignment-quality').textContent = `${target.device_id}: ${Math.round(p.distanceM)} м. GPS здесь ±${Math.round(ownFix.accuracy_m)} м, у участника ±${Math.round(target.accuracy_m ?? 0)} м. При движении или дрейфе GPS повтори совмещение.`;
  } else {
    $('alignment-quality').textContent = selected ? 'У выбранного телефона нет свежего GPS или он слишком близко. Дождись обновления.' : 'Выбери телефон участника со свежим GPS. Для первого совмещения отойдите хотя бы на 10–20 метров.';
  }
}
function setAlignment(yawDeg, pitchDeg) {
  $('yaw').value = String(Math.round(angleDelta(yawDeg, 0) * 10) / 10);
  $('pitch').value = String(Math.round(Math.max(-90, Math.min(90, pitchDeg)) * 10) / 10);
  for (const id of ['yaw', 'pitch']) $(id).dispatchEvent(new Event('input'));
  if (mode === 'live') upload();
}
function alignTarget() {
  const target = targets().find(device => device.device_id === $('alignment-target').value);
  const camera = alignmentPose();
  if (!target || !camera || (mode !== 'demo' && !fixFresh())) {
    $('alignment-message').textContent = 'Для совмещения нужны свежие координаты обоих телефонов и датчики движения.';
    return;
  }
  const correction = alignmentCorrection(relative(target), camera,
    {yawDeg: number('yaw', 0, -180, 180), pitchDeg: number('pitch', 0, -90, 90)});
  if (!correction) {
    $('alignment-message').textContent = 'Отойдите дальше 2 метров, держи камеру ближе к горизонту и попробуй ещё раз. При большой вертикальной поправке сначала нажми «Сбросить поправку».';
    return;
  }
  if (mode === 'live' && !currentPose()) {
    calibrationOffset = 0; targetRelativeCalibration = true;
    pose = {...pose, headingDeg: pose.relativeAlphaDeg, source: 'calibrated'};
  }
  setAlignment(correction.yawDeg, correction.pitchDeg);
  $('alignment-message').textContent = `Совмещено с ${target.device_id}. Поправка направления ${$('yaw').value}°, наклона ${$('pitch').value}°. Она действует на все кубы; GPS может снова сместиться.`;
}
function nudge(direction) {
  const camera = currentPose();
  if (!camera) return;
  // Move the cubes in screen directions, including a rolled camera. Heading
  // sensitivity falls with pitch, so account for it near the horizon.
  const roll = camera.rollDeg * Math.PI / 180;
  const [x, y] = {left: [-0.5, 0], right: [0.5, 0], up: [0, -0.5], down: [0, 0.5]}[direction];
  const eastShift = x * Math.cos(roll) + y * Math.sin(roll);
  const upShift = x * Math.sin(roll) - y * Math.cos(roll);
  const yaw = number('yaw', 0, -180, 180) - eastShift / Math.max(0.1, Math.cos(camera.pitchDeg * Math.PI / 180));
  const pitch = number('pitch', 0, -90, 90) - upShift;
  setAlignment(yaw, pitch);
  $('alignment-message').textContent = `Ручная поправка: направление ${$('yaw').value}°, наклон ${$('pitch').value}°. Для повторного совмещения наведи + на человека.`;
}
function contentRect() {
  const box = canvas.getBoundingClientRect();
  if (mode !== 'live' || !video.videoWidth || !video.videoHeight) return {x: 0, y: 0, width: box.width, height: box.height};
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const width = video.videoWidth * scale, height = video.videoHeight * scale;
  return {x: (box.width - width) / 2, y: (box.height - height) / 2, width, height};
}
function resize() {
  const box = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}
new ResizeObserver(resize).observe($('view'));
function draw(time) {
  animation = requestAnimationFrame(draw);
  const box = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, box.width, box.height);
  const camera = currentPose(), valid = (mode === 'demo' || fixFresh()) && camera;
  let inView = 0, heightUsed = 0;
  if (valid) {
    const rect = contentRect(), viewport = {...rect, horizontalFovDeg: number('fov', 65, 25, 100), near: 0.25};
    const basis = cameraBasis(camera);
    ctx.save(); ctx.translate(rect.x, rect.y);
    ctx.beginPath(); ctx.rect(0, 0, rect.width, rect.height); ctx.clip();
    const ordered = targets().map(target => ({target, p: relative(target)})).sort((a, b) => b.p.distanceM - a.p.distanceM);
    for (const {target, p} of ordered) {
      if (p.distanceM < 2 || p.distanceM > 2000) continue;
      const center = projectPoint(p, basis, viewport);
      if (!center || center.x < -100 || center.y < -100 || center.x > rect.width + 100 || center.y > rect.height + 100) continue;
      const heading = target.orientation_source !== 'none' && finite(target.camera_heading_deg) ? target.camera_heading_deg : target.heading_compass_deg ?? 0;
      const segments = cubeSegments(p, basis, viewport, {sizeM: number('cube-size', 1.8, 0.5, 5), headingDeg: heading});
      ctx.strokeStyle = '#459bff'; ctx.lineWidth = 1.35; ctx.shadowColor = '#398bff'; ctx.shadowBlur = 4;
      ctx.beginPath();
      for (const [a, b] of segments) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      ctx.stroke(); ctx.shadowBlur = 0;
      // Label stays legible; the actual cube keeps its physical perspective size.
      ctx.font = '11px system-ui, sans-serif';
      const label = `${target.device_id} · ${Math.round(p.distanceM)} m`;
      const tw = ctx.measureText(label).width, x = Math.max(4, Math.min(rect.width - tw - 14, center.x - tw / 2 - 6));
      const y = Math.max(18, Math.min(rect.height - 12, center.y + 26));
      ctx.fillStyle = '#071629d9'; ctx.fillRect(x, y - 13, tw + 12, 20);
      ctx.fillStyle = '#a6d1ff'; ctx.fillText(label, x + 6, y + 1);
      inView++; if (p.altitudeUsed) heightUsed++;
    }
    ctx.restore();
  }
  if (time - lastHud > 500) {
    lastHud = time;
    $('count').textContent = `${inView} in view`;
    $('heading').textContent = camera ? `${Math.round(camera.headingDeg)}° · ${camera.source}` : 'Heading —';
    $('gps').textContent = ownFix ? `GPS ±${Math.round(ownFix.accuracy_m)} m${!fixFresh() && mode !== 'demo' ? ' · stale' : ''}` : 'GPS —';
    $('height').textContent = heightUsed ? `Height · ${heightUsed} markers` : 'Height · flat fallback';
    updateNearby(); updateLiveStatus();
    updateMotionStatus();
  }
}
function stop(message = 'Stopped. Camera and GPS sharing are off.') {
  generation++; mode = 'idle';
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null;
  timers.forEach(clearInterval); timers = [];
  requests.forEach(c => c.abort()); requests.clear();
  window.removeEventListener('deviceorientation', onOrientation);
  window.removeEventListener('deviceorientationabsolute', onOrientation);
  window.removeEventListener('devicemotion', onMotion);
  motionTracker.reset(); gpsStabilizer.reset(); motionAccess = 'unknown';
  if (animation !== null) cancelAnimationFrame(animation); animation = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ownFix = null; devices = []; pose = null; lastEvent = null; calibrationOffset = null; webkitOffset = null; webkitOffsetAt = 0; targetRelativeCalibration = false;
  networkMessage = ''; sensorMessage = ''; cameraWarning = ''; uploadBusy = false; pollBusy = false; fixRequestBusy = false;
  $('view').className = ''; $('welcome').hidden = false; $('demo-settings').hidden = true;
  $('device-id').disabled = false; $('start').disabled = false; $('demo').disabled = false;
  $('start').textContent = 'Start camera + GPS'; $('start').classList.remove('stop');
  $('mode').textContent = 'STANDBY'; $('count').textContent = '0 in view';
  $('heading').textContent = 'Heading —'; $('gps').textContent = 'GPS —'; $('height').textContent = 'Height —';
  $('nearby').replaceChildren(); updateAlignmentTargets([]); updateMotionStatus(); status(message);
}
function activate(nextMode) {
  mode = nextMode; $('view').className = nextMode; $('welcome').hidden = true;
  $('start').disabled = false; $('start').textContent = 'Stop'; $('start').classList.add('stop');
  $('device-id').disabled = true;
  $('mode').textContent = nextMode === 'demo' ? 'DEMO · NO GPS UPLOADS' : 'LIVE · GPS AR';
  resize(); animation = requestAnimationFrame(draw);
}
function updateAutoFov() {
  if (manualFov || !video.videoWidth || !video.videoHeight) return;
  const ratio = video.videoWidth / video.videoHeight;
  $('fov').value = String(Math.round(2 * Math.atan(Math.tan(65 * Math.PI / 360) * Math.min(1, ratio)) * 180 / Math.PI));
  $('fov-value').textContent = `${$('fov').value}°`;
}
video.addEventListener('resize', updateAutoFov);
async function start() {
  if (mode !== 'idle') { stop(); return; }
  if (!window.isSecureContext) { status('Use a trusted HTTPS address. Camera, GPS and orientation need a secure connection on phones.', true); return; }
  const id = $('device-id').value.trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) { status('Use a Phone ID with 1–32 letters, numbers, hyphens or underscores.', true); return; }
  if (!navigator.mediaDevices?.getUserMedia || !navigator.geolocation) { status('This browser does not support camera or geolocation. Try Safari on iPhone or Chrome on Android.', true); return; }
  try { localStorage.setItem('squad_gps_device_id', id); } catch { /* session identity */ }
  mode = 'starting'; const token = ++generation;
  motionTracker.reset(); gpsStabilizer.reset(); motionAccess = 'unknown';
  $('start').disabled = true; $('demo').disabled = true; $('device-id').disabled = true;
  status('Allow camera, location and motion access to start.');
  // Invoke iOS permission while the button click still supplies user activation.
  let orientationPermission;
  try { orientationPermission = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'
    ? DeviceOrientationEvent.requestPermission(true) : Promise.resolve('granted'); }
  catch { orientationPermission = Promise.resolve('denied'); }
  let motionPermission;
  try { motionPermission = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function'
    ? DeviceMotionEvent.requestPermission() : Promise.resolve('granted'); }
  catch { motionPermission = Promise.resolve('denied'); }
  try {
    const [permission, motionResult] = await Promise.all([
      orientationPermission.catch(() => 'denied'), motionPermission.catch(() => 'denied')]);
    if (token !== generation) return;
    motionAccess = motionResult;
    if (motionResult === 'granted') window.addEventListener('devicemotion', onMotion);
    if (permission !== 'granted') sensorMessage = 'Motion permission denied. Enable it in browser settings and restart to draw cubes.';
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
    const acquired = await navigator.mediaDevices.getUserMedia({video: {facingMode: {exact: 'environment'}, width: {ideal: 1280}, height: {ideal: 720}}, audio: false});
    if (token !== generation) { acquired.getTracks().forEach(t => t.stop()); return; }
    stream = acquired; video.srcObject = stream;
    const settings = stream.getVideoTracks()[0].getSettings();
    if (settings.facingMode && settings.facingMode !== 'environment') throw new Error('Rear camera required');
    await video.play();
    if (token !== generation) return;
    updateAutoFov();
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (mode === 'live') stop('Camera disconnected. Start again to reconnect.'); });
    activate('live'); $('demo').disabled = false;
    const acceptPosition = position => {
      if (token !== generation || mode !== 'live') return;
      const c = position.coords;
      if (![c.latitude, c.longitude, c.accuracy, position.timestamp].every(finite)) return;
      ownFix = {device_id: id, device_name: /iPhone/i.test(navigator.userAgent) ? 'iPhone AR' : /Android/i.test(navigator.userAgent) ? 'Android AR' : 'Phone AR',
        fix_unix_ms: Math.round(position.timestamp), lat: c.latitude, lon: c.longitude, accuracy_m: c.accuracy,
        heading_gps_deg: finite(c.heading) ? c.heading : null, speed_mps: finite(c.speed) ? Math.max(0, c.speed) : null,
        heading_compass_deg: null, compass_accuracy_deg: finite(lastEvent?.webkitCompassAccuracy) && lastEvent.webkitCompassAccuracy >= 0 ? lastEvent.webkitCompassAccuracy : null,
        alt_m: finite(c.altitude) ? c.altitude : null, alt_accuracy_m: finite(c.altitudeAccuracy) ? c.altitudeAccuracy : null, alt_reference: 'wgs84'};
      ownFixReceivedAt = Date.now(); sensorMessage = permission === 'granted' ? '' : sensorMessage;
      upload(); updateLiveStatus();
    };
    const gpsError = error => {
      if (token !== generation) return;
      if (error.code !== 1 && fixFresh()) return;
      ownFix = null;
      sensorMessage = `GPS ${error.code === 1 ? 'permission denied. Allow location and restart.' : error.code === 3 ? 'timed out. Try outdoors.' : 'unavailable. Try outdoors.'}`;
      updateLiveStatus();
    };
    const gpsOptions = {enableHighAccuracy: true, maximumAge: 0, timeout: 10000};
    watchId = navigator.geolocation.watchPosition(acceptPosition, gpsError, gpsOptions);
    const refreshFix = () => {
      if (mode !== 'live' || fixRequestBusy) return;
      fixRequestBusy = true;
      navigator.geolocation.getCurrentPosition(position => {
        if (token !== generation) return;
        fixRequestBusy = false; acceptPosition(position);
      }, error => {
        if (token !== generation) return;
        fixRequestBusy = false; gpsError(error);
      }, gpsOptions);
    };
    timers.push(setInterval(upload, 1000), setInterval(poll, 1000), setInterval(refreshFix, 5000));
    poll(); updateLiveStatus();
  } catch (error) {
    if (token !== generation) return;
    stop();
    status(`Could not start the rear camera (${error.name ?? error.message}). Allow camera access and use a phone with a rear camera.`, true);
  }
}
function demo() {
  stop();
  ownFix = {device_id: 'Demo-you', lat: 37.5665, lon: 126.978, accuracy_m: 3, alt_m: 35, alt_accuracy_m: 2, alt_reference: 'wgs84', fix_unix_ms: Date.now()};
  ownFixReceivedAt = Date.now();
  const sample = (id, north, east, height, heading) => ({...ownFix, device_id: id,
    lat: ownFix.lat + north / 111000, lon: ownFix.lon + east / (111000 * Math.cos(ownFix.lat * Math.PI / 180)),
    alt_m: ownFix.alt_m + height, camera_heading_deg: heading, orientation_age_s: 0, fix_age_s: 0});
  devices = [sample('Alex', 18, -6, 0, 45), sample('Sam', 42, 7, 0, 120), sample('Robin', 85, 30, 12, 15)];
  activate('demo'); $('demo-settings').hidden = false; $('settings').open = true;
  status('Demo with three simulated phones at different distances. No camera, GPS or network requests. Change direction and tilt below.');
  updateNearby();
}
$('start').addEventListener('click', start); $('demo').addEventListener('click', demo);
$('alignment-target').addEventListener('change', () => updateAlignmentTargets());
$('align-target').addEventListener('click', alignTarget);
$('align-target-camera').addEventListener('click', alignTarget);
$('reset-alignment').addEventListener('click', () => {
  if (targetRelativeCalibration) {
    calibrationOffset = null; targetRelativeCalibration = false;
    if (lastEvent) { const event = lastEvent; pose = null; onOrientation(event); }
  }
  setAlignment(0, 0);
  $('alignment-message').textContent = 'Поправка совмещения сброшена. Выбери участника и наведи + на него, чтобы совместить снова.';
  updateAlignmentTargets();
});
document.querySelectorAll('[data-nudge]').forEach(button => button.addEventListener('click', () => nudge(button.dataset.nudge)));
$('use-stability').addEventListener('change', () => {
  gpsStabilizer.reset();
  $('alignment-message').textContent = 'Режим GPS изменён. Если куб сместился, повтори совмещение по человеку.';
});
$('calibrate').addEventListener('click', () => {
  if (mode !== 'live' || !lastEvent) { status('Start on a phone and allow motion access before setting a direction.', true); return; }
  const known = number('known-heading', 0, 0, 359), raw = orientationFromEvent(lastEvent, screenAngle());
  if (!raw) return;
  if (finite(raw.headingDeg)) {
    $('yaw').value = String(Math.round(angleDelta(known, raw.headingDeg))); $('yaw').dispatchEvent(new Event('input'));
  } else {
    calibrationOffset = angleDelta(known, raw.relativeAlphaDeg); targetRelativeCalibration = false; $('yaw').value = '0'; $('yaw').dispatchEvent(new Event('input'));
  }
  pose = null; onOrientation(lastEvent);
  status('Direction set. Keep the phone away from magnets; repeat if markers drift.');
});
for (const [input, output] of [['fov', 'fov-value'], ['yaw', 'yaw-value'], ['pitch', 'pitch-value'], ['demo-yaw', 'demo-yaw-value'], ['demo-pitch', 'demo-pitch-value']]) {
  $(input).addEventListener('input', () => {
    $(output).textContent = `${$(input).value}°`;
    if (input === 'fov') manualFov = true;
    // A manual correction changes the shared camera pose even if the physical
    // phone is stationary and emits no further orientation events.
    if (input === 'yaw' || input === 'pitch') poseAt = Math.max(Date.now(), poseAt + 1);
  });
}
updateAlignmentTargets([]);
document.addEventListener('visibilitychange', () => { if (document.hidden && mode !== 'idle') stop('Paused while the page is hidden. Start again to resume camera and GPS sharing.'); });
window.addEventListener('pagehide', () => stop());
