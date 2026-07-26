/**
 * LoadForm - Main Application Logic
 *
 * Audio capture runs in Rust (cpal/WASAPI + Deepgram websocket).
 * Frontend receives transcript chunks via Tauri events.
 * Device selection: mic, system audio, or mixed.
 *
 * UI design inspired by the dispatcher-assistant concept: a voice orb
 * drives capture, a two-column grid shows the transcript on the left and
 * animated field cards on the right, transitioning to a driver-ready
 * message card when the load is complete.
 */

import {
  DEFAULT_TEMPLATE,
  renderTemplate,
  getConfidenceBorderColor,
  getConfidenceBadgeColor,
  needsReview,
} from './templates.js';
import { createClient } from '@supabase/supabase-js';
import {
  saveLoad,
  fetchLoads,
  fetchLoad,
  setLoadStatus,
  deleteLoad,
  loadToDriverText,
} from './loads.js';
import { startTutorial } from './tutorial.js';

// ─── Supabase Config ───────────────────────────────────────────────────────
const SUPABASE_URL = 'https://tusiipxekbfheihjrjbd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1c2lpcHhla2JmaGVpaGpyamJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDExMTgsImV4cCI6MjA5OTA3NzExOH0.s86u7JDk0mgYqSm_NNKOQnIHKfWlizRt5xswd5vc1xI';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Tauri Invoke ──────────────────────────────────────────────────────────
function tauriInvoke(cmd, args = {}) {
  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.core) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  throw new Error('Tauri runtime not available. Run inside Tauri app.');
}

// ─── Status State Machine ─────────────────────────────────────────────────
//
// Mirrors the dispatcher-assistant design. `status` drives the orb, the
// status pill, the status copy, and which right-hand view is visible
// (field cards vs. driver message).
//
//   idle       → nothing captured yet
//   listening  → capture in progress
//   processing → extraction/AI running
//   done       → load ready to send (driver message visible)
//
// Note: while listening we still show field cards (auto-extract fills
// them in real-time). The driver message replaces them only when the
// user stops capture and the load is "done".

let status = 'idle';

const STATUS_COPY = {
  idle: {
    title: 'Tap to capture a load',
    sub: "Read the broker's offer out loud. I'll build the dispatch as you talk.",
  },
  listening: {
    title: 'Listening…',
    sub: 'Keep going — details lock in automatically.',
  },
  processing: {
    title: 'Wrapping up',
    sub: 'Cleaning up the details.',
  },
  done: {
    title: 'Ready to send',
    sub: 'Review the load and copy it straight to your driver.',
  },
};

function setStatus(next) {
  status = next;
  renderStatus();
}

// ─── Capture State ─────────────────────────────────────────────────────────

let isCapturing = false;
let accumulatedTranscript = '';
let transcriptWords = []; // words rendered with word-in animation
let currentExtractedData = null;
let currentConfidence = {};
let devices = [];
let selectedDeviceId = '';
let autoExtractEnabled = false;
let lastExtractTime = 0;
const AUTO_EXTRACT_DEBOUNCE_MS = 4000;

// ─── Load History State ─────────────────────────────────────────────────────

let currentLoadId = null; // DB id of the load currently being edited (null = new/unsaved)
let loadsList = []; // cached history rows for the panel
let showCompleted = false; // history panel filter
let editSaveTimer = null; // debounced autosave-on-edit timer
const EDIT_SAVE_DEBOUNCE_MS = 1200;

// ─── Auth State ─────────────────────────────────────────────────────────────

let authMode = 'signin'; // 'signin' | 'signup'
let currentUser = null;

// ─── DOM Elements ─────────────────────────────────────────────────────────

const els = {
  // Voice orb + status
  voiceOrb: document.getElementById('voice-orb'),
  orbContent: document.getElementById('orb-content'),
  statusBadge: document.getElementById('status-badge'),
  statusBadgeLabel: document.getElementById('status-badge-label'),
  statusTitle: document.getElementById('status-title'),
  statusSub: document.getElementById('status-sub'),
  // Transcript
  transcriptArea: document.getElementById('transcript-area'),
  liveTranscript: document.getElementById('live-transcript'),
  transcriptCursor: document.getElementById('transcript-cursor'),
  // Device + capture options
  deviceSelect: document.getElementById('device-select'),
  deviceHint: document.getElementById('device-hint'),
  mixSystemRow: document.getElementById('mix-system-row'),
  mixSystemCheckbox: document.getElementById('mix-system-checkbox'),
  meterContainer: document.getElementById('meter-container'),
  autoExtractCheckbox: document.getElementById('auto-extract-checkbox'),
  // Extract
  extractSection: document.getElementById('extract-section'),
  extractBtn: document.getElementById('extract-btn'),
  extractionSpinner: document.getElementById('extraction-spinner'),
  // Fields / output
  fieldsContainer: document.getElementById('fields-container'),
  outputSection: document.getElementById('output-section'),
  outputPreview: document.getElementById('output-preview'),
  copyBtn: document.getElementById('copy-btn'),
  copyBtnContent: document.getElementById('copy-btn-content'),
  copyFeedback: document.getElementById('copy-feedback'),
  newLoadBtn: document.getElementById('new-load-btn'),
  // Auth elements
  authModal: document.getElementById('auth-modal'),
  authForm: document.getElementById('auth-form'),
  authEmail: document.getElementById('auth-email'),
  authPassword: document.getElementById('auth-password'),
  authSubmitBtn: document.getElementById('auth-submit-btn'),
  authTitle: document.getElementById('auth-title'),
  authToggleBtn: document.getElementById('auth-toggle-btn'),
  authToggleText: document.getElementById('auth-toggle-text'),
  authError: document.getElementById('auth-error'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsModal: document.getElementById('settings-modal'),
  settingsUserEmail: document.getElementById('settings-user-email'),
  settingsCloseBtn: document.getElementById('settings-close-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  // Load history elements
  historyBtn: document.getElementById('history-btn'),
  helpBtn: document.getElementById('help-btn'),
  historyPanel: document.getElementById('history-panel'),
  historyList: document.getElementById('history-list'),
  historyEmpty: document.getElementById('history-empty'),
  historyCount: document.getElementById('history-count'),
  historyShowCompleted: document.getElementById('history-show-completed'),
};

// ─── Field Definitions ────────────────────────────────────────────────────
//
// `icon` is a key into FIELD_ICONS (inline SVG strings) so we don't depend
// on an icon font. Labels drop the emoji prefix from the old design and use
// the uppercase-tracking treatment from the dispatcher-assistant field cards.

const FIELD_ICONS = {
  'map-pin': '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  'calendar-check': '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
  'dollar-sign': '<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  weight: '<circle cx="12" cy="5" r="3"/><path d="M6.5 8a2 2 0 0 0-1.905 1.46L2.1 18.5A2 2 0 0 0 4 21h16a2 2 0 0 0 1.925-2.54L19.4 9.5A2 2 0 0 0 17.5 8Z"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  'sticky-note': '<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'package-check': '<path d="m16 16 2 2 4-4"/><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="M7.5 4.27 9 5"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
};

const FIELDS = [
  { key: 'pickup_location', label: 'Pickup Location', icon: 'map-pin', placeholder: 'e.g. Amarillo, TX' },
  { key: 'pickup_datetime', label: 'Pickup Date/Time', icon: 'calendar', placeholder: 'e.g. Tue 6/24, 8:00 AM' },
  { key: 'pickup_type', label: 'Pickup Type', icon: 'package', placeholder: 'e.g. Live load, Drop and hook' },
  { key: 'pickup_window', label: 'Pickup Window', icon: 'clock', placeholder: 'e.g. FCFS 10am-4pm' },
  { key: 'stops', label: 'Stops', icon: 'route', placeholder: 'e.g. Dallas, TX → Houston, TX' },
  { key: 'delivery_location', label: 'Delivery Location', icon: 'flag', placeholder: 'e.g. Tulsa, OK' },
  { key: 'delivery_datetime', label: 'Delivery Date/Time', icon: 'calendar-check', placeholder: 'e.g. Thu 6/26, 6:00 AM' },
  { key: 'delivery_type', label: 'Delivery Type', icon: 'package-check', placeholder: 'e.g. Live unload, Drop and hook' },
  { key: 'delivery_window', label: 'Delivery Window', icon: 'clock', placeholder: 'e.g. FCFS 8am-5pm' },
  { key: 'commodity', label: 'Commodity', icon: 'package', placeholder: 'e.g. Frozen chicken' },
  { key: 'equipment_type', label: 'Equipment Type', icon: 'truck', placeholder: 'e.g. Reefer, Dry Van' },
  { key: 'rate', label: 'Rate', icon: 'dollar-sign', placeholder: 'e.g. $2.80/mile ($2,100 total)' },
  { key: 'weight', label: 'Weight', icon: 'weight', placeholder: 'e.g. 43,000 lbs' },
  { key: 'trailer_instructions', label: 'Trailer Instructions', icon: 'list', placeholder: 'e.g. Pick empty → live load' },
  { key: 'additional_notes', label: 'Additional Notes', icon: 'sticky-note', placeholder: 'e.g. Lumpers required' },
];

// ─── Status Rendering ──────────────────────────────────────────────────────

const MIC_SVG = '<svg class="h-11 w-11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
const ROTATE_SVG = '<svg class="h-9 w-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';

function renderOrb() {
  const orb = els.voiceOrb;
  orb.classList.toggle('is-listening', status === 'listening');
  orb.classList.toggle('is-processing', status === 'processing');
  orb.setAttribute(
    'aria-label',
    status === 'listening' ? 'Stop listening' : status === 'done' ? 'Start a new load' : 'Start listening',
  );

  if (status === 'listening') {
    // animated bars
    const bars = 28;
    let html = '<span class="lf-orb-bars">';
    for (let i = 0; i < bars; i++) {
      const scale = 0.2 + Math.abs(Math.sin(i * 1.1)) * 0.8;
      const dur = 0.6 + (i % 5) * 0.15;
      const delay = (i % 7) * 0.06;
      const opacity = 0.55 + (i % 4) * 0.15;
      html += `<span class="lf-orb-bar" style="height:100%;transform:scaleY(${scale});animation-duration:${dur}s;animation-delay:${delay}s;opacity:${opacity}"></span>`;
    }
    html += '</span>';
    els.orbContent.innerHTML = html;
    els.orbContent.classList.remove('lf-orb-icon');
  } else if (status === 'processing') {
    els.orbContent.classList.remove('lf-orb-icon');
    els.orbContent.innerHTML =
      '<span class="lf-orb-dots">' +
      '<span class="lf-orb-dot" style="animation-delay:0s"></span>' +
      '<span class="lf-orb-dot" style="animation-delay:0.15s"></span>' +
      '<span class="lf-orb-dot" style="animation-delay:0.3s"></span>' +
      '</span>';
  } else if (status === 'done') {
    els.orbContent.classList.add('lf-orb-icon');
    els.orbContent.innerHTML = ROTATE_SVG;
  } else {
    els.orbContent.classList.add('lf-orb-icon');
    els.orbContent.innerHTML = MIC_SVG;
  }
}

function renderStatusPill() {
  const map = {
    idle: { label: 'Ready', cls: '' },
    listening: { label: 'Recording', cls: 'is-listening' },
    processing: { label: 'Processing', cls: 'is-processing' },
    done: { label: 'Complete', cls: 'is-done' },
  };
  const s = map[status];
  els.statusBadge.classList.remove('is-listening', 'is-processing', 'is-done');
  if (s.cls) els.statusBadge.classList.add(s.cls);
  els.statusBadgeLabel.textContent = s.label;
  els.statusBadge.classList.remove('hidden');
}

function renderStatusCopy() {
  const copy = STATUS_COPY[status];
  els.statusTitle.textContent = copy.title;
  els.statusSub.textContent = copy.sub;
}

function renderStatus() {
  renderOrb();
  renderStatusPill();
  renderStatusCopy();
  // transcript cursor only while listening
  els.transcriptCursor.classList.toggle('hidden', status !== 'listening');
}

// ─── Device Management ──────────────────────────────────────────────────────

async function loadDevices() {
  try {
    devices = await tauriInvoke('list_devices');

    els.deviceSelect.innerHTML = '';

    // Group: Microphones
    const micGroup = document.createElement('optgroup');
    micGroup.label = 'Microphones';
    const mics = devices.filter((d) => d.device_type === 'microphone');
    if (mics.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No microphones found';
      opt.disabled = true;
      micGroup.appendChild(opt);
    } else {
      mics.forEach((dev) => {
        const opt = document.createElement('option');
        opt.value = dev.id;
        opt.textContent = dev.name;
        micGroup.appendChild(opt);
      });
    }
    els.deviceSelect.appendChild(micGroup);

    // Group: System Audio
    const sysGroup = document.createElement('optgroup');
    sysGroup.label = 'System Audio';
    const sysDevs = devices.filter((d) => d.device_type === 'system');
    sysDevs.forEach((dev) => {
      const opt = document.createElement('option');
      opt.value = dev.id;
      opt.textContent = dev.name;
      if (dev.id === 'system:unavailable') {
        opt.disabled = true;
      }
      sysGroup.appendChild(opt);
    });
    if (sysDevs.length > 0) {
      els.deviceSelect.appendChild(sysGroup);
    }

    // Select first mic by default
    if (mics.length > 0) {
      els.deviceSelect.value = mics[0].id;
      selectedDeviceId = mics[0].id;
    }

    els.deviceSelect.addEventListener('change', onDeviceChange);
    onDeviceChange();
  } catch (err) {
    console.error('Failed to load devices:', err);
    els.deviceSelect.innerHTML = '<option disabled>Failed to load devices</option>';
  }
}

function onDeviceChange() {
  selectedDeviceId = els.deviceSelect.value;
  const dev = devices.find((d) => d.id === selectedDeviceId);

  if (!dev) return;

  // Show/hide system audio mix option
  if (dev.device_type === 'microphone') {
    els.mixSystemRow.classList.remove('hidden');
    els.deviceHint.textContent = 'Captures your microphone. Enable "Mix System Audio" to also capture RingCentral/Zoom.';
    els.deviceHint.classList.remove('hidden');
  } else if (dev.device_type === 'system') {
    els.mixSystemRow.classList.add('hidden');
    els.mixSystemCheckbox.checked = false;
    if (dev.id === 'system:unavailable') {
      els.deviceHint.textContent = 'System audio requires Windows. On Linux/Mac, use a virtual audio cable (e.g., PulseAudio loopback) and select it as mic.';
    } else {
      els.deviceHint.textContent = 'Captures all system audio including RingCentral, Zoom, Teams, browser.';
    }
    els.deviceHint.classList.remove('hidden');
  }
}

// ─── Audio Level Meters (per-source dev visualization) ─────────────────────
//
// The Rust backend emits `audio:level` ~30×/s per active source with a compact
// bar array (0..1). We render one minimalistic bar meter per source so you can
// see at a glance which inputs are actually picking up sound — mic and system
// audio are shown separately, including when both are mixed.

const METER_BARS = 24;
const meterState = {}; // source -> { wrap, bars: [HTMLElement], smoothed: [number] }

function meterLabel(source) {
  return source === 'mic' ? 'Microphone' : 'System Audio';
}

function ensureMeter(source) {
  if (meterState[source]) return meterState[source];

  const wrap = document.createElement('div');
  wrap.className = 'meter-source';

  const label = document.createElement('div');
  label.className = 'text-xs text-slate-500 mb-1';
  label.textContent = meterLabel(source);

  const barsRow = document.createElement('div');
  barsRow.className = 'lf-meter-row';

  const bars = [];
  const smoothed = [];
  for (let i = 0; i < METER_BARS; i++) {
    const bar = document.createElement('div');
    bar.className = 'meter-bar' + (source === 'system' ? ' system' : '');
    bar.style.height = '2px';
    barsRow.appendChild(bar);
    bars.push(bar);
    smoothed.push(0);
  }

  wrap.appendChild(label);
  wrap.appendChild(barsRow);
  els.meterContainer.appendChild(wrap);

  const state = { wrap, bars, smoothed };
  meterState[source] = state;
  return state;
}

function onAudioLevel(payload) {
  const source = payload?.source;
  const bars = payload?.bars;
  if (!source || !Array.isArray(bars)) return;

  const state = ensureMeter(source);
  for (let i = 0; i < state.bars.length; i++) {
    const target = Number(bars[i]) || 0;
    // Peak-decay smoothing: rise instantly, fall gradually so the wave looks
    // alive rather than twitchy.
    const prev = state.smoothed[i];
    const next = target > prev ? target : prev * 0.82;
    state.smoothed[i] = next;
    state.bars[i].style.height = `${Math.max(2, next * 100)}%`;
  }
}

function resetMeters() {
  if (els.meterContainer) els.meterContainer.innerHTML = '';
  for (const key of Object.keys(meterState)) delete meterState[key];
}

// ─── Capture Flow ───────────────────────────────────────────────────────────

async function toggleCapture() {
  if (isCapturing) {
    await stopCapture();
  } else {
    await startCapture();
  }
}

async function startCapture() {
  if (!selectedDeviceId) {
    alert('Please select an audio device first.');
    return;
  }

  // Starting a new capture from `done` resets the form first.
  if (status === 'done') {
    resetForm();
  }

  accumulatedTranscript = '';
  transcriptWords = [];
  currentExtractedData = null;
  currentConfidence = {};
  currentLoadId = null; // a new capture session starts a fresh load
  els.liveTranscript.innerHTML = '';
  renderEmptyFieldCards(); // reset cards to empty placeholders
  els.outputPreview.textContent = '';
  els.outputSection.classList.add('hidden');
  els.transcriptArea.classList.remove('hidden');
  els.transcriptArea.classList.add('has-text');
  isCapturing = true;
  setStatus('listening');

  const options = {
    deviceId: selectedDeviceId,
    mixSystemAudio: els.mixSystemCheckbox.checked,
  };

  try {
    await tauriInvoke('start_capture_cmd', options);
    resetMeters();
    els.meterContainer.classList.remove('hidden');
  } catch (err) {
    console.error('Failed to start capture:', err);
    alert('Failed to start capture: ' + err);
    isCapturing = false;
    setStatus('idle');
    els.transcriptArea.classList.add('hidden');
  }
}

async function stopCapture() {
  if (!isCapturing) return;

  try {
    await tauriInvoke('stop_capture');
  } catch (err) {
    console.error('Error stopping capture:', err);
  }

  isCapturing = false;
  els.meterContainer.classList.add('hidden');
  resetMeters();

  // Show manual extract trigger; if fields already exist, transition to done.
  els.extractSection.classList.remove('hidden');

  if (els.fieldsContainer.children.length > 0) {
    setStatus('done');
    renderOutput();
  } else {
    setStatus('idle');
    els.extractSection.scrollIntoView({ behavior: 'smooth' });
  }
}

// ─── Transcript Rendering (word-in animation) ──────────────────────────────
//
// Final transcript chunks append new words; each new word gets the
// `lf-word` animation so the transcript fades in word-by-word, matching
// the dispatcher-assistant design. Interim text is shown without
// animation (it gets replaced as the broker keeps speaking).

function renderTranscript() {
  els.liveTranscript.innerHTML = transcriptWords
    .map((w) => `<span class="lf-word">${escapeHtml(w)}</span>`)
    .join(' ');
  // Auto-scroll the transcript into view within its container
  els.transcriptArea.scrollTop = els.transcriptArea.scrollHeight;
}

function onTranscriptChunk(chunk) {
  if (chunk.is_final) {
    const text = chunk.text || '';
    if (text) {
      const newWords = text.split(/\s+/).filter(Boolean);
      transcriptWords = transcriptWords.concat(newWords);
      accumulatedTranscript = (accumulatedTranscript + ' ' + text).trim();
      renderTranscript();
    }

    // Auto-extract: when auto-extract is on and enough new text has accumulated
    if (autoExtractEnabled && accumulatedTranscript.trim()) {
      const now = Date.now();
      if (now - lastExtractTime > AUTO_EXTRACT_DEBOUNCE_MS) {
        lastExtractTime = now;
        debouncedAutoExtract();
      }
    }
  } else {
    // Interim: show as a trailing ghost word without animating
    const interim = chunk.text || '';
    const base = transcriptWords
      .map((w) => `<span class="lf-word">${escapeHtml(w)}</span>`)
      .join(' ');
    const interimHtml = interim
      ? `<span class="text-slate-500 italic">${escapeHtml(interim)}</span>`
      : '';
    els.liveTranscript.innerHTML = base + (base ? ' ' : '') + interimHtml;
    els.transcriptArea.scrollTop = els.transcriptArea.scrollHeight;
  }
}

function onTranscriptComplete(event) {
  const text = event.payload?.text || '';
  if (text) {
    accumulatedTranscript = text;
    transcriptWords = text.split(/\s+/).filter(Boolean);
    renderTranscript();
  }
}

// ─── Auto-Extract Flow ────────────────────────────────────────────────────

let autoExtractTimeout = null;

function debouncedAutoExtract() {
  clearTimeout(autoExtractTimeout);
  autoExtractTimeout = setTimeout(() => {
    autoExtractTimeout = null;
    if (autoExtractEnabled && isCapturing && accumulatedTranscript.trim()) {
      performExtract(false);
    }
  }, 1500);
}

async function performExtract(showSpinner = true) {
  if (!accumulatedTranscript.trim()) {
    return;
  }

  if (showSpinner) {
    setStatus('processing');
    setExtractingUI(true);
  }

  try {
    const result = await tauriInvoke('extract_load_data', {
      req: { transcript: accumulatedTranscript }
    });

    currentExtractedData = result.data;
    currentConfidence = result.confidence;

    renderFieldCards(result.data, result.confidence);
    renderOutput();

    // Persist the extracted load (insert on first save, update thereafter).
    await saveCurrentLoad();

    // Return to listening if still capturing, otherwise mark done.
    if (isCapturing) {
      setStatus('listening');
    } else {
      setStatus('done');
      els.outputSection.classList.remove('hidden');
      els.outputSection.scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) {
    console.error('Auto-extract failed:', err);
    if (isCapturing) setStatus('listening');
  } finally {
    if (showSpinner) {
      setExtractingUI(false);
    }
  }
}

// ─── Extraction Flow ──────────────────────────────────────────────────────

async function handleExtract() {
  await performExtract(true);
}

function setExtractingUI(extracting) {
  if (extracting) {
    els.extractBtn.classList.add('hidden');
    els.extractionSpinner.classList.remove('hidden');
  } else {
    els.extractBtn.classList.remove('hidden');
    els.extractionSpinner.classList.add('hidden');
  }
}

// ─── Field Card Rendering ───────────────────────────────────────────────────
//
// Each field is a card with an icon, uppercase label, value (or editable
// input), confidence badge, and an animated check that pops in when the
// field is filled. Inputs remain editable so the dispatcher can correct
// anything that looks wrong, exactly like the original LoadForm.

function fieldIconSvg(iconKey) {
  const path = FIELD_ICONS[iconKey] || FIELD_ICONS['map-pin'];
  return `<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

function confidenceClass(conf) {
  if (conf >= 0.8) return 'lf-conf-high';
  if (conf >= 0.5) return 'lf-conf-med';
  return 'lf-conf-low';
}

function renderFieldCards(data, confidence) {
  els.fieldsContainer.innerHTML = '';

  FIELDS.forEach((field) => {
    const value = data[field.key] || '';
    const conf = confidence[field.key] || 0.0;
    const filled = Boolean(value);
    const review = needsReview(conf);

    const card = document.createElement('div');
    card.className = 'lf-field-card fade-in' + (filled ? ' is-filled' : '') + (review && filled ? ' is-review' : '');
    card.innerHTML = `
      <div class="lf-field-icon">${fieldIconSvg(field.icon)}</div>
      <div class="lf-field-body">
        <p class="lf-field-label">${field.label}</p>
        <input
          class="lf-field-input"
          data-field="${field.key}"
          value="${escapeHtml(value)}"
          placeholder="${field.placeholder}"
        />
        ${filled && conf > 0 ? `<span class="lf-field-conf ${confidenceClass(conf)}">${Math.round(conf * 100)}%</span>` : ''}
      </div>
      <div class="lf-field-check" style="${filled ? '' : 'display:none'}">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      </div>
    `;

    els.fieldsContainer.appendChild(card);
  });

  els.fieldsContainer.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      currentExtractedData[input.dataset.field] = input.value;
      const card = input.closest('.lf-field-card');
      const filled = Boolean(input.value);
      card.classList.toggle('is-filled', filled);
      const check = card.querySelector('.lf-field-check');
      if (check) check.style.display = filled ? '' : 'none';
      renderOutput();
      scheduleEditSave();
    });
  });
}

// Render empty placeholder cards so the right column is always populated
// (matches the dispatcher-assistant layout where field cards are visible
// from the start, even before any capture). Reused on resetForm().
function renderEmptyFieldCards() {
  renderFieldCards({}, {});
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Output / Driver Message Rendering ───────────────────────────────────────

function renderOutput() {
  if (!currentExtractedData) {
    els.outputSection.classList.add('hidden');
    return;
  }
  const text = renderTemplate(DEFAULT_TEMPLATE, currentExtractedData);
  els.outputPreview.textContent = text;
  els.outputSection.classList.remove('hidden');
}

async function copyToClipboard() {
  if (!currentExtractedData) return;

  const text = renderTemplate(DEFAULT_TEMPLATE, currentExtractedData);
  const ok = await writeTextToClipboard(text);

  if (ok) {
    els.copyBtnContent.innerHTML =
      '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Copied';
    els.copyFeedback.classList.remove('hidden');
    setTimeout(() => {
      els.copyBtnContent.innerHTML =
        '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg> Copy';
      els.copyFeedback.classList.add('hidden');
    }, 2000);
  }
}

// Reusable clipboard writer used by both the output "Copy" button and the
// history panel "Copy driver data" action. Returns true on success.
async function writeTextToClipboard(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    } else if (typeof window.__TAURI__ !== 'undefined') {
      await tauriInvoke('copy_to_clipboard', { text });
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    return true;
  } catch (err) {
    console.error('Failed to copy:', err);
    alert('Failed to copy: ' + err);
    return false;
  }
}

// ─── Reset ──────────────────────────────────────────────────────────────────

// "New Load": persist any final edits to the current load, then start fresh.
async function handleNewLoad() {
  if (currentExtractedData && currentUser) {
    await saveCurrentLoad();
  }
  currentLoadId = null;
  resetForm();
  refreshLoadsList();
}

function resetForm() {
  accumulatedTranscript = '';
  transcriptWords = [];
  currentExtractedData = null;
  currentConfidence = {};
  isCapturing = false;

  els.liveTranscript.innerHTML = '';
  els.transcriptArea.classList.add('hidden');
  els.transcriptArea.classList.remove('has-text');
  els.extractSection.classList.add('hidden');
  els.outputSection.classList.add('hidden');
  els.outputPreview.textContent = '';

  els.meterContainer.classList.add('hidden');
  resetMeters();

  // Restore empty placeholder field cards so the right column stays populated.
  renderEmptyFieldCards();

  setStatus('idle');
}

// ─── Load History ────────────────────────────────────────────────────────────

// Persist the current in-memory load to Supabase. Inserts a new row when there
// is no currentLoadId (first save), otherwise updates the existing row.
// Never throws — a save failure is logged but does not block the UI.
async function saveCurrentLoad() {
  if (!currentUser || !currentExtractedData) return;
  const { id } = await saveLoad(
    supabase,
    currentUser.id,
    currentLoadId,
    currentExtractedData,
    currentConfidence,
    accumulatedTranscript
  );
  if (id && !currentLoadId) {
    currentLoadId = id;
  }
  refreshLoadsList();
}

// Debounced autosave triggered by form field edits.
function scheduleEditSave() {
  if (!currentLoadId || !currentUser) return; // only update existing rows on edit
  clearTimeout(editSaveTimer);
  editSaveTimer = setTimeout(() => {
    editSaveTimer = null;
    saveCurrentLoad();
  }, EDIT_SAVE_DEBOUNCE_MS);
}

// Reload the user's loads from Supabase and re-render the panel.
async function refreshLoadsList() {
  if (!currentUser) {
    loadsList = [];
    renderLoadsList();
    return;
  }
  loadsList = await fetchLoads(supabase);
  renderLoadsList();
}

// Format a created_at timestamp into a short relative-ish label.
function formatLoadDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

function renderLoadsList() {
  if (!els.historyList) return;

  const visible = showCompleted
    ? loadsList
    : loadsList.filter((l) => l.status !== 'completed');

  els.historyCount.textContent = loadsList.length
    ? `${loadsList.length} saved`
    : '';

  els.historyList.innerHTML = '';

  if (loadsList.length === 0) {
    els.historyEmpty.classList.remove('hidden');
    els.historyList.classList.add('hidden');
    return;
  }
  els.historyEmpty.classList.add('hidden');
  els.historyList.classList.remove('hidden');

  if (visible.length === 0) {
    const note = document.createElement('p');
    note.className = 'text-sm text-slate-500 text-center py-6';
    note.textContent = 'No active loads. Toggle "Show completed" to see finished loads.';
    els.historyList.appendChild(note);
    return;
  }

  for (const load of visible) {
    const isCurrent = load.id === currentLoadId;
    const isDone = load.status === 'completed';

    const route =
      load.pickup_location || load.delivery_location
        ? `${load.pickup_location || '—'} → ${load.delivery_location || '—'}`
        : '';
    const meta = [route, load.rate, formatLoadDate(load.created_at)]
      .filter(Boolean)
      .join('  ·  ');

    const item = document.createElement('div');
    item.className = 'lf-load-item fade-in' + (isCurrent ? ' is-current' : '');
    item.innerHTML = `
      <div class="lf-load-meta">
        <div class="lf-load-title">${escapeHtml(load.title || 'Untitled load')}</div>
        <div class="lf-load-sub">${escapeHtml(meta)}</div>
      </div>
      <div class="lf-load-actions">
        <span class="lf-pill text-xs px-2 py-0.5 rounded-full ${isDone ? 'lf-status-done' : 'lf-status-active'}">
          ${isDone ? '✓ Done' : 'Active'}
        </span>
        <button class="lf-load-act" data-load-id="${load.id}" data-action="copy" title="Copy driver data">📋</button>
        <button class="lf-load-act" data-load-id="${load.id}" data-action="toggle" title="${isDone ? 'Reactivate' : 'Mark complete'}">${isDone ? '↩️' : '✓'}</button>
        <button class="lf-load-act" data-load-id="${load.id}" data-action="delete" title="Delete">🗑</button>
        <button class="lf-load-act" data-load-id="${load.id}" data-action="open" title="Open load">Open</button>
      </div>
    `;
    els.historyList.appendChild(item);
  }
}

// Open a saved load into the form/output for review or further editing.
async function openLoad(id) {
  const load = await fetchLoad(supabase, id);
  if (!load) return;

  currentLoadId = load.id;
  currentExtractedData = {};
  for (const key of [
    'pickup_location', 'pickup_datetime', 'pickup_type', 'pickup_window',
    'delivery_location', 'delivery_datetime', 'delivery_type', 'delivery_window',
    'stops', 'commodity', 'equipment_type', 'trailer_instructions',
    'rate', 'weight', 'additional_notes',
  ]) {
    currentExtractedData[key] = load[key] || '';
  }
  currentConfidence = load.confidence || {};
  accumulatedTranscript = load.transcript || '';
  transcriptWords = accumulatedTranscript ? accumulatedTranscript.split(/\s+/).filter(Boolean) : [];

  renderFieldCards(currentExtractedData, currentConfidence);
  renderOutput();
  setStatus('done');

  toggleHistoryPanel(false);
  els.outputSection.scrollIntoView({ behavior: 'smooth' });
  renderLoadsList();
}

// Copy a saved load's driver-facing text straight from the history list.
async function copyLoadDriverData(id) {
  const load = await fetchLoad(supabase, id);
  if (!load) return;
  const text = loadToDriverText(load);
  await writeTextToClipboard(text);
}

// Mark a load complete or reactivate it.
async function toggleLoadStatus(id) {
  const load = loadsList.find((l) => l.id === id);
  const next = load && load.status === 'completed' ? 'active' : 'completed';
  await setLoadStatus(supabase, id, next);
  await refreshLoadsList();
}

// Delete a load (with confirm). If it's the currently-open one, reset the form.
async function removeLoad(id) {
  if (!confirm('Delete this load? This cannot be undone.')) return;
  const ok = await deleteLoad(supabase, id);
  if (!ok) return;
  if (id === currentLoadId) {
    currentLoadId = null;
    resetForm();
  }
  await refreshLoadsList();
}

// Handle clicks anywhere in the history list via delegation.
function onHistoryListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.loadId;
  const action = btn.dataset.action;
  switch (action) {
    case 'open':
      openLoad(id);
      break;
    case 'copy':
      copyLoadDriverData(id);
      break;
    case 'toggle':
      toggleLoadStatus(id);
      break;
    case 'delete':
      removeLoad(id);
      break;
  }
}

function toggleHistoryPanel(show) {
  if (show === undefined) {
    els.historyPanel.classList.toggle('hidden');
  } else if (show) {
    els.historyPanel.classList.remove('hidden');
  } else {
    els.historyPanel.classList.add('hidden');
  }
}

function initAuth() {
  // Check for existing session
  const token = localStorage.getItem('sb-auth-token');
  if (token) {
    // Try to restore session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        currentUser = session.user;
        hideAuthModal();
        fetchAndSetApiKeys();
        refreshLoadsList();
      } else {
        // Token invalid/expired
        localStorage.removeItem('sb-auth-token');
        showAuthModal();
      }
    });
  } else {
    showAuthModal();
  }
}

function showAuthModal() {
  els.authModal.classList.remove('hidden');
  els.authModal.classList.add('flex');
}

function hideAuthModal() {
  els.authModal.classList.add('hidden');
  els.authModal.classList.remove('flex');
}

function showSettingsModal() {
  if (!currentUser) return;
  els.settingsUserEmail.textContent = currentUser.email || 'Unknown';
  els.settingsModal.classList.remove('hidden');
}

function hideSettingsModal() {
  els.settingsModal.classList.add('hidden');
}

function toggleAuthMode() {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  updateAuthUI();
}

function updateAuthUI() {
  if (authMode === 'signin') {
    els.authTitle.textContent = 'Sign In';
    els.authSubmitBtn.textContent = 'Sign In';
    els.authToggleText.textContent = "Don't have an account?";
    els.authToggleBtn.textContent = 'Sign Up';
  } else {
    els.authTitle.textContent = 'Sign Up';
    els.authSubmitBtn.textContent = 'Sign Up';
    els.authToggleText.textContent = 'Already have an account?';
    els.authToggleBtn.textContent = 'Sign In';
  }
  els.authError.classList.add('hidden');
}

function showAuthError(message) {
  els.authError.textContent = message;
  els.authError.classList.remove('hidden');
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;

  if (!email || !password) {
    showAuthError('Please enter email and password');
    return;
  }

  if (password.length < 6) {
    showAuthError('Password must be at least 6 characters');
    return;
  }

  els.authSubmitBtn.disabled = true;
  els.authSubmitBtn.textContent = authMode === 'signin' ? 'Signing In...' : 'Signing Up...';
  els.authError.classList.add('hidden');

  try {
    let result;
    if (authMode === 'signin') {
      result = await supabase.auth.signInWithPassword({ email, password });
    } else {
      result = await supabase.auth.signUp({ email, password });
    }

    if (result.error) {
      throw result.error;
    }

    const session = result.data.session;
    if (session) {
      localStorage.setItem('sb-auth-token', session.access_token);
      currentUser = session.user;
      await fetchAndSetApiKeys();
      refreshLoadsList();
      hideAuthModal();
      els.authForm.reset();
    } else {
      // Sign up successful but needs email confirmation (if enabled)
      showAuthError('Check your email to confirm your account');
    }
  } catch (err) {
    console.error('Auth error:', err);
    showAuthError(err.message || 'Authentication failed');
  } finally {
    els.authSubmitBtn.disabled = false;
    updateAuthUI();
  }
}

async function fetchAndSetApiKeys() {
  try {
    const { data, error } = await supabase.from('api_keys').select('*');
    if (error) {
      console.error('Failed to fetch API keys:', error);
      return;
    }

    const keys = { deepgram: '', ollama: '' };
    for (const row of data) {
      if (row.provider === 'deepgram') keys.deepgram = row.key_value;
      if (row.provider === 'ollama') keys.ollama = row.key_value;
    }

    await tauriInvoke('set_api_keys', {
      payload: {
        deepgram_key: keys.deepgram,
        ollama_key: keys.ollama,
      },
    });
    console.log('API keys pushed to Rust backend');
  } catch (err) {
    console.error('Failed to set API keys in Rust:', err);
  }
}

async function handleLogout() {
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.error('Sign out error:', err);
  }
  localStorage.removeItem('sb-auth-token');
  currentUser = null;
  currentLoadId = null;
  loadsList = [];
  renderLoadsList();
  hideSettingsModal();
  showAuthModal();
  try {
    await tauriInvoke('logout');
  } catch (err) {
    console.error('Logout command error:', err);
  }
}

// ─── Event Listeners ────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  initAuth();

  loadDevices();

  // Render empty placeholder field cards so the right column is populated
  // from the start (prevents the orb from looking left-aligned on desktop).
  renderEmptyFieldCards();

  // Voice orb drives capture (and "new load" when done).
  els.voiceOrb.addEventListener('click', () => {
    if (status === 'done') {
      handleNewLoad();
    } else {
      toggleCapture();
    }
  });
  els.extractBtn.addEventListener('click', handleExtract);
  els.copyBtn.addEventListener('click', copyToClipboard);
  els.newLoadBtn.addEventListener('click', handleNewLoad);

  // Auto-extract toggle
  if (els.autoExtractCheckbox) {
    els.autoExtractCheckbox.addEventListener('change', (e) => {
      autoExtractEnabled = e.target.checked;
      if (autoExtractEnabled && isCapturing && accumulatedTranscript.trim()) {
        // Immediately extract if already capturing
        lastExtractTime = Date.now();
        performExtract(false);
      }
    });
  }

  // Auth event listeners
  els.authForm.addEventListener('submit', handleAuthSubmit);
  els.authToggleBtn.addEventListener('click', toggleAuthMode);
  els.settingsBtn.addEventListener('click', showSettingsModal);
  els.settingsCloseBtn.addEventListener('click', hideSettingsModal);
  els.logoutBtn.addEventListener('click', handleLogout);

  // Tutorial replay (manual trigger)
  if (els.helpBtn) {
    els.helpBtn.addEventListener('click', startTutorial);
  }

  // Load history listeners
  els.historyBtn.addEventListener('click', () => {
    toggleHistoryPanel();
    if (!els.historyPanel.classList.contains('hidden')) {
      refreshLoadsList();
    }
  });
  els.historyShowCompleted.addEventListener('change', (e) => {
    showCompleted = e.target.checked;
    renderLoadsList();
  });
  els.historyList.addEventListener('click', onHistoryListClick);

  // Close settings modal on backdrop click
  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) {
      hideSettingsModal();
    }
  });

  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.event) {
    window.__TAURI__.event.listen('transcript:chunk', (event) => {
      onTranscriptChunk(event.payload);
    });
    window.__TAURI__.event.listen('transcript:complete', (event) => {
      onTranscriptComplete(event);
    });
    window.__TAURI__.event.listen('audio:level', (event) => {
      onAudioLevel(event.payload);
    });
  }
});