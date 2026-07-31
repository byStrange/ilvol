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
 * Press "D" while the widget is focused to run a simulated extraction: planets
 * pop in one-by-one as if a broker call were being transcribed. Press "D" again
 * to clear.
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
// Planets sit on rings of given radius around that center.

const SUN_W = 300;
const SUN_H = 190;
const SUN_CX = SUN_W / 2;
const SUN_CY = SUN_H / 2;
const ORBIT_INNER_R = 165;
const ORBIT_OUTER_R = 215;
const PLANET_W = 150;
const PLANET_H = 70;
const PLANETS_PER_RING = 8;

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
// Compute the screen position for a planet given its index among all filled
// planets. Planets are distributed evenly on two rings.

function computePlanetPos(index) {
  const ring = index < PLANETS_PER_RING ? 0 : 1;
  const indexInRing = ring === 0 ? index : index - PLANETS_PER_RING;
  const total = planets.size;
  const countInRing = ring === 0
    ? Math.min(total, PLANETS_PER_RING)
    : total - PLANETS_PER_RING;
  const r = ring === 0 ? ORBIT_INNER_R : ORBIT_OUTER_R;
  const baseOffset = ring === 0
    ? -Math.PI / 2
    : -Math.PI / 2 + Math.PI / countInRing;
  const angle = baseOffset + (indexInRing / countInRing) * Math.PI * 2;

  // Planet center relative to sun's top-left.
  const cxRel = SUN_CX + Math.cos(angle) * r;
  const cyRel = SUN_CY + Math.sin(angle) * r;

  // Convert to screen position (top-left of the planet window).
  const x = sunX + cxRel - PLANET_W / 2;
  const y = sunY + cyRel - PLANET_H / 2;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Reposition ALL existing planets relative to the current sun position. */
async function repositionAllPlanets() {
  const keys = [...planets.keys()];
  const tasks = keys.map((key, i) => {
    const { x, y } = computePlanetPos(i);
    return tauriInvoke('move_planet_window', { key, x, y }).catch(() => {});
  });
  await Promise.all(tasks);
}

// ─── Planet window management ────────────────────────────────────────────

/** Create or update a planet window for a filled field. */
async function upsertPlanet(key, value, confidence, isDemo = false) {
  const field = FIELDS.find((f) => f.key === key);
  if (!field) return;

  const existed = planets.has(key);

  // Track the planet and get its index to compute position.
  planets.set(key, { confidence, isDemo });
  const index = [...planets.keys()].indexOf(key);
  const { x, y } = computePlanetPos(index);

  if (existed) {
    // Update value + position.
    await tauriInvoke('update_planet_window', { key, value, confidence }).catch(() => {});
    await tauriInvoke('move_planet_window', { key, x, y }).catch(() => {});
  } else {
    // Create new planet window.
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
    }).catch(() => {});
    // Reposition all planets since the index of some may have shifted.
    await repositionAllPlanets();
  }
}

/** Remove a planet window (field cleared). */
async function removePlanet(key) {
  if (!planets.has(key)) return;
  planets.delete(key);
  await tauriInvoke('close_planet_window', { key }).catch(() => {});
  await repositionAllPlanets();
}

/** Close all planet windows. */
async function closeAllPlanets() {
  planets.clear();
  await tauriInvoke('close_all_planets').catch(() => {});
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
  await closeAllPlanets();

  // Show demo badge.
  if (!document.getElementById('wf-demo-badge')) {
    const badge = document.createElement('div');
    badge.id = 'wf-demo-badge';
    badge.className = 'wf-demo-badge';
    badge.textContent = 'Demo — press D to clear';
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
// The sun is a layer-shell window. The compositor doesn't move it when the
// user drags (Tauri's startDragging uses Wayland's xdg_toplevel move, which
// layer-shell surfaces don't support). Instead we implement drag manually:
// pointerdown → track pointermove → update sun margins via init_layer_widget
// → reposition planets.
//
// We use `data-tauri-drag-region` as a fallback; but on layer-shell it may not
// work, so we also implement explicit pointer-based drag.

let dragging = false;
let dragStartScreenX = 0;
let dragStartScreenY = 0;
let dragStartSunX = 0;
let dragStartSunY = 0;
let dragRafId = null;

async function onDragMove(e) {
  if (!dragging) return;
  const dx = e.screenX - dragStartScreenX;
  const dy = e.screenY - dragStartScreenY;
  sunX = dragStartSunX + dx;
  sunY = dragStartSunY + dy;

  // Throttle Rust calls with requestAnimationFrame.
  if (dragRafId) return;
  dragRafId = requestAnimationFrame(async () => {
    dragRafId = null;
    // Move the sun window to the new position.
    tauriInvoke('move_layer_widget', { x: sunX, y: sunY }).catch(() => {});
    // Move all planets to follow.
    repositionAllPlanets();
  });
}

function onDragEnd() {
  if (!dragging) return;
  dragging = false;
  if (dragRafId) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }
  // Final precise reposition.
  tauriInvoke('move_layer_widget', { x: sunX, y: sunY }).catch(() => {});
  repositionAllPlanets();
}

function initDragTracking() {
  // Use mousedown on the card (the drag region) to start drag.
  card.addEventListener('mousedown', (e) => {
    // Don't start drag when clicking buttons.
    if (e.target.closest('button')) return;
    dragging = true;
    dragStartScreenX = e.screenX;
    dragStartScreenY = e.screenY;
    dragStartSunX = sunX;
    dragStartSunY = sunY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);

  // Touch support.
  card.addEventListener('touchstart', (e) => {
    if (e.target.closest('button')) return;
    const t = e.touches[0];
    dragging = true;
    dragStartScreenX = t.screenX;
    dragStartScreenY = t.screenY;
    dragStartSunX = sunX;
    dragStartSunY = sunY;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    onDragMove({ screenX: t.screenX, screenY: t.screenY });
  }, { passive: true });
  window.addEventListener('touchend', onDragEnd);
}

// ─── Init ────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  micBtn.addEventListener('click', startCapture);
  stopBtn.addEventListener('click', stopCapture);
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

  // Read the sun's current screen position. Layer-shell init is now done
  // by Rust in toggle_widget (before show) — JS only needs the position
  // for drag tracking and planet placement.
  try {
    const [x, y] = await tauriInvoke('get_widget_position');
    sunX = x;
    sunY = y;
  } catch (err) {
    console.error('get_widget_position error:', err);
  }

  renderTranscript();
  initDragTracking();

  // Global events.
  await tauriListen('capture:state', (e) => onCaptureState(e.payload));
  await tauriListen('transcript:chunk', (e) => onTranscriptChunk(e.payload));
  await tauriListen('transcript:complete', onTranscriptComplete);
  await tauriListen('capture:error', onCaptureError);
  await tauriListen('audio:level', (e) => onAudioLevel(e.payload));
  await tauriListen('load:fields', (e) => onLoadFields(e.payload));

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