/**
 * LoadForm floating widget — orbital "sun + planets" capture remote.
 *
 * The sun (this window) holds capture controls + live transcript. Planet chips
 * are spawned as separate layer-shell windows by the Rust backend, each at an
 * exact screen position computed relative to the sun. This is Wayland-native:
 * layer-shell surfaces CAN be positioned at absolute coordinates, unlike
 * regular Wayland windows.
 *
 * When the sun is dragged, JS tracks its new screen position and tells Rust to
 * re-anchor every planet relative to it — so the planets follow the sun like
 * a solar system.
 *
 * ─── Demo mode ───────────────────────────────────────────────────────────
 * Tap the orbit button (or press "D" while the widget has focus) to run a
 * simulated extraction: planets pop in one-by-one as if a broker call were
 * being transcribed. Tap it again to clear.
 */

// ─── Tauri helpers ────────────────────────────────────────────────────────

function tauriInvoke(cmd, args = {}) {
  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.core) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  return Promise.reject(new Error('Tauri runtime not available.'));
}

function tauriListen(event, handler) {
  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.event) {
    return window.__TAURI__.event.listen(event, handler);
  }
  return Promise.resolve();
}

// ─── Field metadata (mirrors src/main.js) ─────────────────────────────────

const FIELDS = [
  { key: 'pickup_location', label: 'Pickup', icon: 'map-pin' },
  { key: 'pickup_datetime', label: 'PU Time', icon: 'calendar' },
  { key: 'pickup_type', label: 'PU Type', icon: 'package' },
  { key: 'pickup_window', label: 'PU Window', icon: 'clock' },
  { key: 'stops', label: 'Stops', icon: 'route' },
  { key: 'delivery_location', label: 'Delivery', icon: 'flag' },
  { key: 'delivery_datetime', label: 'DEL Time', icon: 'calendar-check' },
  { key: 'delivery_type', label: 'DEL Type', icon: 'package-check' },
  { key: 'delivery_window', label: 'DEL Window', icon: 'clock' },
  { key: 'commodity', label: 'Commodity', icon: 'package' },
  { key: 'equipment_type', label: 'Equipment', icon: 'truck' },
  { key: 'rate', label: 'Rate', icon: 'dollar-sign' },
  { key: 'weight', label: 'Weight', icon: 'weight' },
  { key: 'trailer_instructions', label: 'Trailer', icon: 'list' },
  { key: 'additional_notes', label: 'Notes', icon: 'sticky-note' },
];

// ─── Orbit geometry ────────────────────────────────────────────────────────
//
// Planet screen positions are computed relative to the sun's top-left corner.
// The sun is ~300px wide × ~190px tall, so its center is roughly at (150, 95).
// Planets sit on a single circle of fixed radius around that center.

const SUN_W = 300;
const SUN_H = 190;
const SUN_CX = SUN_W / 2;
const SUN_CY = SUN_H / 2;
const PLANET_W = 150;
const PLANET_H = 70;

// One perfect circle: every planet sits on the same radius, evenly spaced, so
// the constellation reads as a single clean orbit rather than nested rings.
//
// One slot per field, starting at 12 o'clock and going clockwise. The radius
// comes from the no-overlap constraint — the chord between adjacent slots,
// 2·r·sin(π/slots), has to clear the planet width:
//   2 · 390 · sin(180°/15) = 162px  >  150px wide  ✓
const ORBIT_SLOTS = FIELDS.length;
const TOTAL_SLOTS = ORBIT_SLOTS;
const ORBIT_R_PREFERRED = 390;

/**
 * Orbit radius, shrunk if the monitor is too small to hold the full circle.
 * Keeps the ring inside the screen instead of letting the clamp flatten one
 * side of it against an edge.
 */
function orbitRadius() {
  const fitsW = screenW / 2 - PLANET_W / 2 - 8;
  const fitsH = screenH / 2 - PLANET_H / 2 - 8;
  return Math.max(150, Math.min(ORBIT_R_PREFERRED, fitsW, fitsH));
}

// ─── State ────────────────────────────────────────────────────────────────

let isCapturing = false;
let selectedDeviceId = null;
let finalText = '';
let interimText = '';
let demoActive = false;
let demoTimer = null;

// Sun position on screen (logical px). Updated during drag and on init.
let sunX = 100;
let sunY = 100;

// Monitor bounds, so planets can be clamped on screen.
let screenW = 1920;
let screenH = 1080;

function applyGeometry(geo) {
  if (!geo) return;
  sunX = geo.x;
  sunY = geo.y;
  screenW = geo.screen_w;
  screenH = geo.screen_h;
}

/** Re-read the sun's position and monitor bounds from the backend. */
async function refreshGeometry() {
  try {
    applyGeometry(await tauriInvoke('get_widget_position'));
  } catch (err) {
    console.error('get_widget_position error:', err);
  }
}

// Track which planet windows exist: key → { confidence, isDemo }
const planets = new Map();

// ─── DOM ─────────────────────────────────────────────────────────────────

const card = document.getElementById('widget');
const textEl = document.getElementById('wf-text');
const interimEl = document.getElementById('wf-interim');
const placeholderEl = document.getElementById('wf-placeholder');
const micBtn = document.getElementById('wf-mic');
const stopBtn = document.getElementById('wf-stop');
const closeBtn = document.getElementById('wf-close');
const demoBtn = document.getElementById('wf-demo');
const continueBtn = document.getElementById('wf-continue');
const waveBars = Array.from(document.querySelectorAll('.wf-bar'));

// ─── Rendering ───────────────────────────────────────────────────────────

function renderTranscript() {
  textEl.textContent = finalText;
  interimEl.textContent = interimText ? (finalText ? ' ' : '') + interimText : '';
  const hasText = !!(finalText || interimText);
  placeholderEl.style.display = hasText ? 'none' : '';
  const area = document.getElementById('wf-transcript');
  area.scrollTop = area.scrollHeight;
}

function setListening(listening) {
  isCapturing = listening;
  card.classList.toggle('is-listening', listening);
  micBtn.disabled = listening;
  stopBtn.disabled = !listening;
  micBtn.setAttribute('aria-label', listening ? 'Listening…' : 'Start listening');
  if (!listening) {
    interimText = '';
    renderTranscript();
  }
}

// ─── Waveform ────────────────────────────────────────────────────────────

const waveSmoothed = waveBars.map(() => 0);

function onAudioLevel(payload) {
  const bars = payload?.bars;
  if (!Array.isArray(bars)) return;
  for (let i = 0; i < waveBars.length; i++) {
    const src = Math.floor((i * bars.length) / waveBars.length);
    const target = Number(bars[src]) || 0;
    const prev = waveSmoothed[i];
    waveSmoothed[i] = target > prev ? target : prev * 0.8;
    const h = Math.max(4, waveSmoothed[i] * 28);
    waveBars[i].style.height = `${h}px`;
  }
}

function resetWave() {
  for (let i = 0; i < waveBars.length; i++) {
    waveSmoothed[i] = 0;
    waveBars[i].style.height = '4px';
  }
}

// ─── Orbit positioning ──────────────────────────────────────────────────
//
// Compute the screen position for a planet from the fixed slot it holds on the
// orbit. All slots share one radius, so the planets form a single circle.

/**
 * Screen position for a planet occupying a fixed slot on the orbit.
 *
 * Slots are fixed rather than redistributed across however many planets
 * currently exist: a planet that has already popped in should stay put when the
 * next field is extracted, not slide around the circle every time a sibling
 * appears.
 */
function computePlanetPos(slot) {
  const r = orbitRadius();
  // 12 o'clock, then clockwise around the circle.
  const angle = -Math.PI / 2 + (slot / ORBIT_SLOTS) * Math.PI * 2;

  // Planet center relative to sun's top-left.
  const cxRel = SUN_CX + Math.cos(angle) * r;
  const cyRel = SUN_CY + Math.sin(angle) * r;

  // Convert to screen position (top-left of the planet window), clamped so a
  // planet never drifts off the edge of the monitor.
  const x = clamp(sunX + cxRel - PLANET_W / 2, 0, screenW - PLANET_W);
  const y = clamp(sunY + cyRel - PLANET_H / 2, 0, screenH - PLANET_H);
  return { x: Math.round(x), y: Math.round(y) };
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/** Lowest orbital slot not already taken, so freed slots get reused. */
function allocateSlot() {
  const taken = new Set([...planets.values()].map((p) => p.slot));
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    if (!taken.has(i)) return i;
  }
  return null; // orbit full
}

/** Reposition ALL existing planets relative to the current sun position. */
async function repositionAllPlanets() {
  const tasks = [...planets.entries()].map(([key, p]) => {
    const { x, y } = computePlanetPos(p.slot);
    return tauriInvoke('move_planet_window', { key, x, y }).catch((err) => {
      console.error(`move_planet_window(${key}) failed:`, err);
    });
  });
  await Promise.all(tasks);
}

// ─── Planet window management ────────────────────────────────────────────

/** Create or update a planet window for a filled field. */
async function upsertPlanet(key, value, confidence, isDemo = false) {
  const field = FIELDS.find((f) => f.key === key);
  if (!field) return;

  const existing = planets.get(key);

  if (existing) {
    // Same slot — an already-orbiting planet only changes its text.
    if (existing.value === value && existing.confidence === confidence) return;
    existing.value = value;
    existing.confidence = confidence;
    try {
      await tauriInvoke('update_planet_window', { key, value, confidence });
    } catch (err) {
      console.error(`update_planet_window(${key}) failed:`, err);
    }
    return;
  }

  const slot = allocateSlot();
  if (slot === null) return; // every orbital slot is occupied

  planets.set(key, { slot, value, confidence, isDemo });
  const { x, y } = computePlanetPos(slot);

  try {
    await tauriInvoke('create_planet_window', {
      planet: {
        key,
        label: field.label,
        icon: field.icon,
        value,
        confidence,
        isDemo,
        x,
        y,
      },
    });
  } catch (err) {
    // Roll the slot back so a failed planet doesn't leave a permanent hole.
    planets.delete(key);
    console.error(`create_planet_window(${key}) failed:`, err);
  }
}

/** Remove a planet window (field cleared). */
async function removePlanet(key) {
  if (!planets.has(key)) return;
  planets.delete(key);
  try {
    await tauriInvoke('close_planet_window', { key });
  } catch (err) {
    console.error(`close_planet_window(${key}) failed:`, err);
  }
}

/** Close all planet windows. */
async function closeAllPlanets() {
  planets.clear();
  try {
    await tauriInvoke('close_all_planets');
  } catch (err) {
    console.error('close_all_planets failed:', err);
  }
}

// ─── load:fields handler ──────────────────────────────────────────────────

async function onLoadFields(payload) {
  const data = payload?.data || payload?.payload?.data || {};
  const conf = payload?.confidence || payload?.payload?.confidence || {};
  const keys = Object.keys(data);
  if (!keys.length) return;

  // Upsert filled fields.
  for (const field of FIELDS) {
    const val = (data[field.key] || '').toString().trim();
    if (val) {
      await upsertPlanet(field.key, val, Number(conf[field.key] || 0));
    }
  }

  // Remove planets whose fields are now empty.
  for (const key of [...planets.keys()]) {
    if (!data[key] || !data[key].toString().trim()) {
      await removePlanet(key);
    }
  }
}

// ─── Demo mode ──────────────────────────────────────────────────────────

const DEMO_LOAD = {
  pickup_location: 'Amarillo, TX',
  pickup_datetime: 'Tue 7/30, 8:00 AM',
  pickup_type: 'Live load',
  pickup_window: 'FCFS 6am-4pm',
  delivery_location: 'Tulsa, OK',
  delivery_datetime: 'Thu 8/1, 6:00 AM',
  delivery_type: 'Live unload',
  delivery_window: 'Appointment 9:00 AM',
  commodity: 'Frozen chicken',
  equipment_type: 'Reefer',
  rate: '$2.80/mile ($2,100 total)',
  weight: '43,000 lbs',
  trailer_instructions: 'Empty in → live load → live unload',
  additional_notes: 'Lumpers required, T-check at gate',
};

const DEMO_CONFIDENCE = {
  pickup_location: 0.95,
  pickup_datetime: 0.87,
  pickup_type: 0.82,
  pickup_window: 0.9,
  delivery_location: 0.98,
  delivery_datetime: 0.91,
  delivery_type: 0.85,
  delivery_window: 0.88,
  commodity: 0.82,
  equipment_type: 0.99,
  rate: 0.89,
  weight: 0.95,
  trailer_instructions: 0.75,
  additional_notes: 0.75,
};

async function startDemo() {
  if (demoActive) return;
  demoActive = true;
  demoBtn.classList.add('is-active');
  await closeAllPlanets();
  // Make sure we orbit the sun's current position, not wherever it started.
  await refreshGeometry();

  // Show demo badge.
  if (!document.getElementById('wf-demo-badge')) {
    const badge = document.createElement('div');
    badge.id = 'wf-demo-badge';
    badge.className = 'wf-demo-badge';
    badge.textContent = 'Demo — tap the orbit icon to clear';
    card.appendChild(badge);
  }

  const keys = Object.keys(DEMO_LOAD);
  let i = 0;
  const step = async () => {
    if (!demoActive || i >= keys.length) {
      demoTimer = null;
      return;
    }
    const key = keys[i++];
    await upsertPlanet(key, DEMO_LOAD[key], DEMO_CONFIDENCE[key] || 0.8, true);
    demoTimer = setTimeout(step, 600);
  };
  step();
}

async function stopDemo() {
  demoActive = false;
  demoBtn.classList.remove('is-active');
  if (demoTimer) {
    clearTimeout(demoTimer);
    demoTimer = null;
  }
  const badge = document.getElementById('wf-demo-badge');
  if (badge) badge.remove();
  await closeAllPlanets();
}

// ─── Capture flow ────────────────────────────────────────────────────────

async function startCapture() {
  if (isCapturing) return;
  if (demoActive) await stopDemo();

  if (!selectedDeviceId) await pickDevice();

  try {
    await tauriInvoke('start_capture_cmd', {
      deviceId: selectedDeviceId,
      mixSystemAudio: false,
    });
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (!msg.includes('already running')) {
      console.error('Widget start_capture_cmd error:', err);
    }
  }
}

async function stopCapture() {
  if (!isCapturing) return;
  try {
    await tauriInvoke('stop_capture');
  } catch (err) {
    console.error('Widget stop_capture error:', err);
  }
}

// ─── Transcript events ───────────────────────────────────────────────────

function onTranscriptChunk(chunk) {
  if (chunk?.is_final) {
    const text = (chunk.text || '').trim();
    if (text) {
      finalText = (finalText + ' ' + text).trim();
    }
    interimText = '';
  } else {
    interimText = chunk?.text || '';
  }
  renderTranscript();
}

function onTranscriptComplete(event) {
  const text = event?.payload?.text || '';
  if (text) finalText = text;
  interimText = '';
  renderTranscript();
}

function onCaptureState(payload) {
  if (payload?.running) {
    if (!isCapturing) {
      finalText = '';
      interimText = '';
      renderTranscript();
      resetWave();
      closeAllPlanets();
    }
    setListening(true);
  } else {
    setListening(false);
  }
}

function onCaptureError(event) {
  console.error('Capture error:', event?.payload);
  setListening(false);
}

// ─── Device selection ────────────────────────────────────────────────────

async function pickDevice() {
  try {
    const devices = await tauriInvoke('list_devices');
    const mic = Array.isArray(devices)
      ? devices.find((d) => d.device_type === 'microphone') || devices[0]
      : null;
    selectedDeviceId = mic?.id || null;
  } catch (err) {
    console.error('Widget list_devices error:', err);
  }
}

// ─── Drag tracking ────────────────────────────────────────────────────────
//
// The sun is a layer-shell window, so Tauri's `startDragging` is useless here:
// it asks for an xdg_toplevel interactive move, which layer-shell surfaces
// don't implement. We move the surface ourselves by rewriting its anchor
// margins, and drag it by hand.
//
// The coordinate space matters. Under Wayland a client is never told where it
// sits on screen, so `screenX`/`screenY` in WebKitGTK are *not* global — they
// collapse onto the surface-local values. Differencing them against a drag-start
// screenX therefore measures the pointer relative to a window that is itself
// moving, which oscillates instead of tracking the cursor.
//
// So we work purely in surface-local coordinates and keep this invariant:
//
//     sunPos + grabOffset == pointerScreenPos
//
// Given a fresh local pointer reading, `sun + (local - grabOffset)` lands the
// window exactly under the cursor's grab point. Because each reading is taken
// against the position we most recently applied, the expression is
// self-correcting: it converges rather than accumulating drift.

let dragging = false;
let grabOffsetX = 0;
let grabOffsetY = 0;
let lastLocalX = 0;
let lastLocalY = 0;
let dragRafId = null;

/** Apply the latest pointer reading to the sun's position, once per frame. */
function flushDrag() {
  dragRafId = null;
  if (!dragging) return;

  const nextX = clamp(sunX + (lastLocalX - grabOffsetX), 0, screenW - SUN_W);
  const nextY = clamp(sunY + (lastLocalY - grabOffsetY), 0, screenH - SUN_H);
  if (nextX === sunX && nextY === sunY) return;
  sunX = nextX;
  sunY = nextY;

  tauriInvoke('move_layer_widget', { x: sunX, y: sunY }).catch((err) => {
    console.error('move_layer_widget failed:', err);
  });
  // The planets follow the sun.
  repositionAllPlanets();
}

function onDragMove(e) {
  if (!dragging) return;
  // Record the freshest reading; the rAF flush consumes only the latest one so
  // that queued events can't each apply the same delta.
  lastLocalX = e.clientX;
  lastLocalY = e.clientY;
  if (dragRafId === null) dragRafId = requestAnimationFrame(flushDrag);
}

function onDragEnd(e) {
  if (!dragging) return;
  // Apply the last reading before tearing down, otherwise a pending frame is
  // cancelled and the widget settles up to one tick behind the cursor.
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
    flushDrag();
  }
  dragging = false;

  if (e && card.hasPointerCapture?.(e.pointerId)) {
    card.releasePointerCapture(e.pointerId);
  }
  // Settle the planets on the final position.
  repositionAllPlanets();
}

function initDragTracking() {
  // Pointer events + an explicit capture, so motion keeps arriving even if the
  // cursor briefly outruns the window during a fast drag.
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Don't hijack clicks on the controls.
    if (e.target.closest('button')) return;
    dragging = true;
    grabOffsetX = e.clientX;
    grabOffsetY = e.clientY;
    lastLocalX = e.clientX;
    lastLocalY = e.clientY;
    // Capture keeps motion flowing if the cursor briefly outruns the window.
    // Not fatal if the pointer id isn't capturable.
    try {
      card.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
  });
  card.addEventListener('pointermove', onDragMove);
  card.addEventListener('pointerup', onDragEnd);
  card.addEventListener('pointercancel', onDragEnd);
}

// ─── Init ────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  micBtn.addEventListener('click', startCapture);
  stopBtn.addEventListener('click', stopCapture);
  demoBtn.addEventListener('click', () => {
    if (demoActive) stopDemo();
    else if (!isCapturing) startDemo();
  });
  closeBtn.addEventListener('click', async () => {
    try {
      await tauriInvoke('toggle_widget');
    } catch (err) {
      console.error('Hide error:', err);
    }
  });

  continueBtn.addEventListener('click', async () => {
    try {
      await tauriInvoke('continue_in_app');
    } catch (err) {
      console.error('Continue in app error:', err);
    }
  });

  await pickDevice();

  // Sync capture state.
  try {
    const running = await tauriInvoke('is_capture_running');
    setListening(!!running);
  } catch (err) {
    console.error('Widget is_capture_running error:', err);
  }

  // Read the sun's current screen position and the monitor bounds. Layer-shell
  // init is done by Rust in toggle_widget (before show) — JS only needs the
  // geometry for drag tracking and planet placement.
  await refreshGeometry();

  renderTranscript();
  initDragTracking();


  // Global events.
  await tauriListen('capture:state', (e) => onCaptureState(e.payload));
  await tauriListen('transcript:chunk', (e) => onTranscriptChunk(e.payload));
  await tauriListen('transcript:complete', onTranscriptComplete);
  await tauriListen('capture:error', onCaptureError);
  await tauriListen('audio:level', (e) => onAudioLevel(e.payload));
  await tauriListen('load:fields', (e) => onLoadFields(e.payload));

  // The backend tells us where it placed the sun each time the widget is
  // shown. This window's JS loads once at app startup, so without this the
  // geometry read above would stay stuck at its pre-positioning default.
  await tauriListen('widget:geometry', (e) => {
    applyGeometry(e.payload);
    repositionAllPlanets();
  });

  // Demo toggle: press "D".
  window.addEventListener('keydown', (e) => {
    if (e.key === 'd' || e.key === 'D') {
      if (demoActive) {
        stopDemo();
      } else if (!isCapturing) {
        startDemo();
      }
    }
  });
});