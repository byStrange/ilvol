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
 * ─── What drives the planets ─────────────────────────────────────────────
 * The `load:fields` event, broadcast by the backend every time an extraction
 * completes. With auto-fill on (the default), the main window re-extracts on
 * conversation pauses while capture is running, so planets pop into orbit as
 * the broker keeps talking — one per field the model has become able to fill.
 */

import { getDeepgramToken, reportCaptureEnded } from './api.js';

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
//
// One deliberate omission: `miles`. The orbit geometry below is solved for
// exactly these 15 slots — a 16th tightens the angular spacing past the point
// where neighbouring chips clear each other, and buying that back means a
// wider ring or a narrower chip. Mileage is also the least glanceable field
// here: it's a number for the dashboard, not one the dispatcher acts on
// mid-call. It is still captured and still shows on the main form.
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
const PLANET_W = 112;
const PLANET_H = 60;

// One perfect circle: every planet sits on the same radius, evenly spaced, so
// the constellation reads as a single clean orbit rather than nested rings.
//
// One slot per field, starting at 12 o'clock and going clockwise. The radius is
// floored by collisions between neighbouring chips — and the chip is a
// rectangle, not a point, so the test that matters is whether two chips' boxes
// overlap: they clear each other only if |Δx| > PLANET_W or |Δy| > PLANET_H.
// (The chord 2·r·sin(π/slots) is the older, looser estimate. It overstates the
// clearance, because the chord runs diagonally while the chips are
// axis-aligned. Judging by the chord is how the previous 390/150×70 pairing
// ended up ~2px *overlapping* at the tightest pair, near 3 and 9 o'clock.)
//
// The tightest pair at 15 slots sits just past the top and bottom of the ring,
// where neighbours are side by side and so need the full chip width between
// them. Solving that numerically:
//
//   chip 150×70 → r ≥ 411      chip 118×60 → r ≥ 327
//   chip 112×60 → r ≥ 311      chip 100×56 → r ≥ 280
//
// So a tighter orbit has to be bought with a narrower chip. 112×60 at r = 315
// leaves ~8px between neighbours and pulls the ring's inner edge to ~107px off
// the sun's corner, down from ~177px — a 742×690 constellation instead of
// 930×850. Tighter than this means giving up the single clean circle for two
// alternating rings, or clipping values harder than two lines of ~35 chars.
const ORBIT_SLOTS = FIELDS.length;
const TOTAL_SLOTS = ORBIT_SLOTS;
const ORBIT_R_PREFERRED = 315;

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
// Metering: correlates this session's token grant with its end.
let currentCaptureId = null;
let captureStartedAt = null;
let finalText = '';
let interimText = '';

// Sun position on screen (logical px). Updated during drag and on init.
let sunX = 100;
let sunY = 100;

// Monitor bounds, so planets can be clamped on screen.
let screenW = 1920;
let screenH = 1080;

// Which placement backend Rust compiled in. Decides how a drag reads pointer
// coordinates — see the drag section below. The backend overwrites this on the
// first geometry read; the user-agent guess only covers the window before that
// lands, and matches how `placement` picks its own implementation (Linux →
// layer-shell, everything else → the plain window API).
let usesLayerShell = navigator.userAgent.includes('Linux');

function applyGeometry(geo) {
  if (!geo) return;
  sunX = geo.x;
  sunY = geo.y;
  screenW = geo.screen_w;
  screenH = geo.screen_h;
  if (typeof geo.uses_layer_shell === 'boolean') {
    usesLayerShell = geo.uses_layer_shell;
  }
}

/** Re-read the sun's position and monitor bounds from the backend. */
async function refreshGeometry() {
  try {
    applyGeometry(await tauriInvoke('get_widget_position'));
  } catch (err) {
    console.error('get_widget_position error:', err);
  }
}

// Track which planet windows exist: key → { slot, value, confidence }
const planets = new Map();

// Is the sun on screen? Nothing orbits a sun that isn't there.
//
// This window is created hidden at app startup and its JS runs from that
// moment — `load:fields` listener and all — so an extraction driven from the
// main window would otherwise pop a ring of chips into existence around a
// widget nobody opened: loose windows over whatever the user was actually
// doing, with no sun on screen to explain them or close them.
//
// Skipping costs nothing. Showing the sun re-emits its geometry, and that
// rebuilds the orbit from the load the backend has been accumulating the whole
// time (see `restoreOrbit`). Rust refuses these creates too, as the invariant's
// backstop — this just keeps us from asking.
let sunVisible = false;

// ─── DOM ─────────────────────────────────────────────────────────────────

const card = document.getElementById('widget');
const textEl = document.getElementById('wf-text');
const interimEl = document.getElementById('wf-interim');
const placeholderEl = document.getElementById('wf-placeholder');
// Kept so a transient message (e.g. the quota wall) can be cleared back to
// the normal prompt — nothing else ever rewrites this text.
const placeholderDefaultText = placeholderEl.textContent;
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
  // Whatever was pending has resolved one way or the other by the time the
  // backend has an answer about whether audio is flowing.
  captureStarting = false;
  clearTimeout(captureStartTimeout);
  captureStartTimeout = null;
  micBtn.removeAttribute('aria-busy');
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
async function upsertPlanet(key, value, confidence) {
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

  planets.set(key, { slot, value, confidence });
  const { x, y } = computePlanetPos(slot);

  try {
    await tauriInvoke('create_planet_window', {
      planet: {
        key,
        label: field.label,
        icon: field.icon,
        value,
        confidence,
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

/**
 * Rebuild the orbit from the load the backend has accumulated so far.
 *
 * Planets are closed whenever the sun hides, so the orbit that comes back has
 * to be reconstructed from somewhere. Waiting for the next `load:fields` would
 * mean an empty ring until the next extraction lands — or forever, once the
 * call has ended.
 */
async function restoreOrbit() {
  try {
    await applyLoadFields(await tauriInvoke('get_load_fields'));
  } catch (err) {
    console.error('get_load_fields failed:', err);
  }
}

// ─── load:fields handler ──────────────────────────────────────────────────

/**
 * Values that mean "the model had nothing to say", spelled the way models
 * actually spell it.
 *
 * A backstop, not the filter: `load:fields` now carries a load the backend has
 * already cleaned (`clean_field_value` in lib.rs), which is where the long list
 * of excuse phrases lives. This catches the plain ones on the way to a planet,
 * because a chip is the least forgiving place for them — in the form "N/A"
 * lands in a labelled input and reads fine, in orbit it's a chip floating in
 * space announcing that nothing is known, which is worse than no chip at all.
 */
const EMPTY_ANSWERS = new Set([
  'none',
  'n/a',
  'na',
  'null',
  'unknown',
  'not mentioned',
  'not specified',
  'not provided',
  '-',
  '--',
]);

/** The value to orbit for a field, or '' if the field is effectively unfilled. */
function planetValue(raw) {
  const val = (raw ?? '').toString().trim();
  return EMPTY_ANSWERS.has(val.toLowerCase()) ? '' : val;
}

/**
 * Serialises everything that touches the orbit.
 *
 * Under auto-fill `load:fields` arrives unattended every few seconds, and a
 * manual Extract can land on top of an auto one. Two overlapping runs would
 * interleave their creates and removes — one retracting a planet the other is
 * still building — and leave `planets` describing windows that don't exist.
 *
 * Wholesale clears go through the same queue, and for the same reason: a
 * `capture:state` or `load:reset` landing mid-batch used to empty the slot map
 * while the batch still had planets to place, so the placements that followed
 * were handed slots the batch had already used and stacked two chips on one
 * point of the ring.
 */
let orbitQueue = Promise.resolve();

function queueOrbitTask(task) {
  orbitQueue = orbitQueue.then(task).catch((err) => {
    console.error('orbit update failed:', err);
  });
  return orbitQueue;
}

function onLoadFields(payload) {
  return queueOrbitTask(() => applyLoadFields(payload));
}

async function applyLoadFields(payload) {
  if (!sunVisible) return;
  const data = payload?.data || payload?.payload?.data || {};
  const conf = payload?.confidence || payload?.payload?.confidence || {};
  if (!Object.keys(data).length) return;

  // Upsert filled fields. Sequential rather than parallel: each one builds a
  // real webview, and they read as planets arriving one after another — which
  // is the point, since extraction is incremental.
  for (const field of FIELDS) {
    const val = planetValue(data[field.key]);
    if (val) {
      await upsertPlanet(field.key, val, Number(conf[field.key] || 0));
    }
  }

  // Retract planets whose fields the latest extraction no longer fills.
  for (const key of [...planets.keys()]) {
    if (!planetValue(data[key])) {
      await removePlanet(key);
    }
  }
}

// ─── Capture flow ────────────────────────────────────────────────────────

/**
 * Same start lock as the main window, for the same reason.
 *
 * `isCapturing` here is also set by capture:state rather than by the click, so
 * the mic button was equally re-pressable during the token mint — and each
 * press spends a capture against the daily quota. The widget is the more
 * likely place to hit it: the button is small, and it disables itself only
 * once listening has actually begun.
 */
let captureStarting = false;
let captureStartTimeout = null;

/** Long enough for a slow token mint plus a socket, short enough to recover. */
const CAPTURE_START_TIMEOUT_MS = 20000;

/**
 * Release the lock and put the button back the way the state says it should be.
 *
 * `micBtn.disabled = isCapturing` rather than `false`: if capture:state has
 * already landed then listening has begun and the button belongs disabled, and
 * unconditionally re-enabling it here would undo that.
 */
function endCaptureStart() {
  captureStarting = false;
  clearTimeout(captureStartTimeout);
  captureStartTimeout = null;
  micBtn.removeAttribute('aria-busy');
  micBtn.disabled = isCapturing;
}

async function startCapture() {
  if (isCapturing || captureStarting) return;

  if (!selectedDeviceId) await pickDevice();

  captureStarting = true;
  micBtn.disabled = true;
  micBtn.setAttribute('aria-busy', 'true');
  // Same escape hatch as the main window: a mic button that can never be
  // pressed again is a worse outcome than the double-press it is guarding.
  clearTimeout(captureStartTimeout);
  captureStartTimeout = setTimeout(() => {
    if (!captureStarting) return;
    console.warn('Widget: capture:state never arrived; releasing the start lock.');
    endCaptureStart();
  }, CAPTURE_START_TIMEOUT_MS);
  try {
    placeholderEl.textContent = placeholderDefaultText;
    const { token, captureId } = await getDeepgramToken('mic');
    currentCaptureId = captureId;
    captureStartedAt = Date.now();
    await tauriInvoke('start_capture_cmd', {
      deviceId: selectedDeviceId,
      mixSystemAudio: false,
      deepgramToken: token,
    });
  } catch (err) {
    // Released on every failure path, including the quota one that returns
    // early — the whole point of that branch is a mic the user can still press
    // once they understand why it stopped.
    endCaptureStart();
    const msg = String(err?.message ?? err);
    if (err?.quotaExceeded) {
      // The widget has no alert affordance and hiding this in the console
      // would leave the user tapping a mic that silently does nothing. The
      // placeholder is the one always-visible line of text here.
      placeholderEl.textContent = err.message;
      placeholderEl.style.display = '';
      return;
    }
    if (!msg.includes('already running')) {
      console.error('Widget start_capture_cmd error:', err);
    }
  }
  // Held on success until capture:state lands in setListening — the command
  // resolving means Rust accepted the session, not that audio is flowing.
}

async function stopCapture() {
  if (!isCapturing) return;
  try {
    await tauriInvoke('stop_capture');
  } catch (err) {
    console.error('Widget stop_capture error:', err);
  }

  if (currentCaptureId && captureStartedAt) {
    reportCaptureEnded(
      currentCaptureId,
      Math.round((Date.now() - captureStartedAt) / 1000),
    );
  }
  captureStartedAt = null;
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
      queueOrbitTask(closeAllPlanets);
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
// The coordinate space matters, and the right answer differs per platform —
// which is why `usesLayerShell` comes from the backend rather than being
// assumed.
//
// ── Layer-shell (Wayland) ──
// A client is never told where it sits on screen, so `screenX`/`screenY` in
// WebKitGTK are *not* global — they collapse onto the surface-local values.
// Differencing them against a drag-start screenX therefore measures the pointer
// relative to a window that is itself moving, which oscillates instead of
// tracking the cursor.
//
// So we work purely in surface-local coordinates and keep this invariant:
//
//     sunPos + grabOffset == pointerScreenPos
//
// Given a fresh local pointer reading, `sun + (local - grabOffset)` lands the
// window exactly under the cursor's grab point. Because each reading is taken
// against the position we most recently applied, the expression is
// self-correcting: it converges rather than accumulating drift.
//
// ── Ordinary windows (Windows, macOS) ──
// That same self-correction is a feedback loop, and here it goes unstable. It
// only converges if the window has *already* moved by the time the next pointer
// reading is taken, which holds on Wayland because the compositor re-bases
// surface-local coordinates as part of the move. On Windows the move is an
// async IPC hop to the main thread, so pointermove keeps arriving measured
// against the window's OLD position: every frame re-applies a delta an earlier
// frame already applied. The sun overshoots, the correction overshoots back,
// and it rings — a 10px nudge turns into a jitter that walks the widget away
// and eventually pins it in a corner against the clamp.
//
// Here `screenX`/`screenY` genuinely are global, so there is no need for the
// feedback trick and no loop to destabilise: the position is a pure function of
// how far the pointer has travelled since the grab. Latency makes the window
// lag the cursor by a frame; it can never make it oscillate.

let dragging = false;
// Layer-shell: the pointer's surface-local grab point.
let grabOffsetX = 0;
let grabOffsetY = 0;
let lastLocalX = 0;
let lastLocalY = 0;
// Screen-space: where the pointer and the sun each were when the drag started.
let dragStartScreenX = 0;
let dragStartScreenY = 0;
let dragOriginX = 0;
let dragOriginY = 0;
let lastScreenX = 0;
let lastScreenY = 0;
let dragRafId = null;

/** Where the sun wants to be, given the freshest pointer reading. */
function dragTarget() {
  if (usesLayerShell) {
    return {
      x: sunX + (lastLocalX - grabOffsetX),
      y: sunY + (lastLocalY - grabOffsetY),
    };
  }
  return {
    x: dragOriginX + (lastScreenX - dragStartScreenX),
    y: dragOriginY + (lastScreenY - dragStartScreenY),
  };
}

/** Apply the latest pointer reading to the sun's position, once per frame. */
function flushDrag() {
  dragRafId = null;
  if (!dragging) return;

  const target = dragTarget();
  const nextX = clamp(Math.round(target.x), 0, screenW - SUN_W);
  const nextY = clamp(Math.round(target.y), 0, screenH - SUN_H);
  if (nextX === sunX && nextY === sunY) return;
  sunX = nextX;
  sunY = nextY;

  // Sun and planets in a single call — see moveOrbit.
  moveOrbit();
}

function onDragMove(e) {
  if (!dragging) return;
  // Record the freshest reading; the rAF flush consumes only the latest one so
  // that queued events can't each apply the same delta.
  lastLocalX = e.clientX;
  lastLocalY = e.clientY;
  lastScreenX = e.screenX;
  lastScreenY = e.screenY;
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
  // Settle the whole constellation on the final position.
  moveOrbit();
}

/**
 * Move the sun and every planet in ONE IPC call.
 *
 * The naive version fires 1 + N invokes per frame — sixteen round trips at
 * 60fps with a full orbit, each landing as a separate window-move on the main
 * thread. That backs up the message loop on Windows (where every move is a real
 * SetWindowPos) and lets the planets visibly lag behind the sun mid-drag, since
 * they arrive as their own event-loop turns. One command applies the whole
 * constellation in a single pass instead.
 */
function moveOrbit() {
  const moves = [...planets.entries()].map(([key, p]) => ({
    key,
    ...computePlanetPos(p.slot),
  }));
  return tauriInvoke('move_orbit', { x: sunX, y: sunY, planets: moves }).catch(
    (err) => {
      console.error('move_orbit failed:', err);
    },
  );
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
    dragStartScreenX = e.screenX;
    dragStartScreenY = e.screenY;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    // The screen-space path measures from where the sun was at grab time, so
    // this has to be the sun's real position — not a value a previous drag left
    // behind. `sunX`/`sunY` is authoritative: JS drives placement, Rust mirrors.
    dragOriginX = sunX;
    dragOriginY = sunY;
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

  // Are we on screen? Normally no — this runs at app startup, with the widget
  // still hidden. Asked anyway so a webview that reloads while the sun is up
  // doesn't come back believing it's hidden and sit out the next extraction.
  try {
    sunVisible = !!(await tauriInvoke('is_widget_visible'));
  } catch (err) {
    console.error('Widget is_widget_visible error:', err);
  }

  // Read the sun's current screen position and the monitor bounds. Layer-shell
  // init is done by Rust in toggle_widget (before show) — JS only needs the
  // geometry for drag tracking and planet placement.
  await refreshGeometry();

  renderTranscript();
  initDragTracking();


  // Whether the orbit is allowed to exist at all — see `sunVisible`.
  await tauriListen('widget:visibility', (e) => {
    sunVisible = !!e.payload;
  });

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
  //
  // Showing the sun is also where the orbit comes back: the planets were closed
  // when it was hidden, so anything still in the map is placed against the new
  // geometry and the rest is rebuilt from the load the backend holds.
  await tauriListen('widget:geometry', (e) => {
    applyGeometry(e.payload);
    // Geometry is only ever sent on show, so its arrival is itself proof the
    // sun is up. Saying so here means the rebuild below doesn't depend on the
    // `widget:visibility` event landing first.
    sunVisible = true;
    queueOrbitTask(async () => {
      await repositionAllPlanets();
      await restoreOrbit();
    });
  });

  // The main window clears the orbit when a load is reset ("New load"), since
  // the planets belong to the load that was just filed away.
  await tauriListen('load:reset', () => {
    queueOrbitTask(closeAllPlanets);
  });

  // Rust closed the planets itself — hiding the sun, or "Continue in app".
  // Only the map needs clearing here; the windows are already gone, and
  // leaving stale entries behind would make every later extraction push
  // updates at dead windows instead of building new planets.
  await tauriListen('orbit:cleared', () => {
    queueOrbitTask(() => {
      planets.clear();
    });
  });
});