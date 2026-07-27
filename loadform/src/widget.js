/**
 * LoadForm floating widget — minimal always-on-top capture remote.
 *
 * Mirrors the main window's capture session over the same global Tauri events
 * (`transcript:chunk`, `transcript:complete`, `audio:level`, `capture:error`).
 * Only one capture session exists at a time (enforced by the Rust backend), so
 * the widget and the main window stay in sync automatically: whoever starts
 * capture, both see the live transcript.
 *
 * The widget defaults to the first available microphone. For system-audio or
 * mixed capture, use the main window.
 */

// ─── Tauri helpers (global Tauri, same as main.js) ─────────────────────────

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

// ─── State ────────────────────────────────────────────────────────────────

let isCapturing = false;
let selectedDeviceId = null;
let finalText = '';
let interimText = '';

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
    // Keep final transcript visible after stop; only clear interim.
    interimText = '';
    renderTranscript();
  }
}

// ─── Waveform (audio:level → 8-bar peak-decay meter) ──────────────────────

const waveSmoothed = waveBars.map(() => 0);

function onAudioLevel(payload) {

  const bars = payload?.bars;
  if (!Array.isArray(bars)) return;

  // Down-sample the backend's 24 bars into our 8 by even spacing.
  for (let i = 0; i < waveBars.length; i++) {
    const src = Math.floor((i * bars.length) / waveBars.length);
    const target = Number(bars[src]) || 0;
    const prev = waveSmoothed[i];
    // Rise instantly, fall gradually — alive, not twitchy.
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

// ─── Capture flow ────────────────────────────────────────────────────────

async function startCapture() {
  if (isCapturing) return;

  if (!selectedDeviceId) {
    await pickDevice();
  }

  try {
    await tauriInvoke('start_capture_cmd', {
      deviceId: selectedDeviceId,
      mixSystemAudio: false,
    });
    // UI state is driven by the `capture:state` event (onCaptureState).
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (!msg.includes('already running')) {
      console.error('Widget start_capture_cmd error:', err);
    }
    // "already running" is fine — the capture:state event keeps us in sync.
  }
}

async function stopCapture() {
  if (!isCapturing) return;
  try {
    await tauriInvoke('stop_capture');
    // UI state is driven by the `capture:state` event (onCaptureState).
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

// Backend is the source of truth: it broadcasts `capture:state` on start/stop
// so the widget stays in sync with the main window regardless of who started.
function onCaptureState(payload) {
  if (payload?.running) {
    if (!isCapturing) {
      finalText = '';
      interimText = '';
      renderTranscript();
      resetWave();
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

// ─── Device selection ───────────────────────────────────────────────────

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

  await pickDevice();

  // Sync state with whatever the backend is already doing.
  try {
    const running = await tauriInvoke('is_capture_running');
    setListening(!!running);
  } catch (err) {
    console.error('Widget is_capture_running error:', err);
  }

  continueBtn.addEventListener('click', async () => {
    try {
      await tauriInvoke('continue_in_app');
    } catch (err) {
      console.error('Continue in app error:', err);
    }
  });
  renderTranscript();

  await tauriListen('capture:state', (e) => onCaptureState(e.payload));
  await tauriListen('transcript:chunk', (e) => onTranscriptChunk(e.payload));
  await tauriListen('transcript:complete', onTranscriptComplete);
  await tauriListen('capture:error', onCaptureError);
  await tauriListen('audio:level', (e) => onAudioLevel(e.payload));
});