/**
 * LoadForm - Main Application Logic
 *
 * Audio capture runs in Rust (cpal/WASAPI + Deepgram websocket).
 * Frontend receives transcript chunks via Tauri events.
 * Device selection: mic, system audio, or mixed.
 */

import {
  DEFAULT_TEMPLATE,
  renderTemplate,
  getConfidenceBorderColor,
  getConfidenceBadgeColor,
  needsReview,
} from './templates.js';

// ─── Tauri Invoke ──────────────────────────────────────────────────────────
function tauriInvoke(cmd, args = {}) {
  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.core) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  throw new Error('Tauri runtime not available. Run inside Tauri app.');
}

// ─── State ──────────────────────────────────────────────────────────────────

let isCapturing = false;
let accumulatedTranscript = '';
let currentExtractedData = null;
let currentConfidence = {};
let devices = [];
let selectedDeviceId = '';

// ─── DOM Elements ─────────────────────────────────────────────────────────

const els = {
  startCaptureBtn: document.getElementById('start-capture-btn'),
  captureBtnText: document.getElementById('capture-btn-text'),
  captureIcon: document.getElementById('capture-icon'),
  capturingIndicator: document.getElementById('capturing-indicator'),
  transcriptArea: document.getElementById('transcript-area'),
  liveTranscript: document.getElementById('live-transcript'),
  interimTranscript: document.getElementById('interim-transcript'),
  deviceSelect: document.getElementById('device-select'),
  deviceHint: document.getElementById('device-hint'),
  mixSystemRow: document.getElementById('mix-system-row'),
  mixSystemCheckbox: document.getElementById('mix-system-checkbox'),
  extractSection: document.getElementById('extract-section'),
  extractBtn: document.getElementById('extract-btn'),
  extractionSpinner: document.getElementById('extraction-spinner'),
  formSection: document.getElementById('form-section'),
  fieldsContainer: document.getElementById('fields-container'),
  outputSection: document.getElementById('output-section'),
  outputPreview: document.getElementById('output-preview'),
  copyBtn: document.getElementById('copy-btn'),
  copyFeedback: document.getElementById('copy-feedback'),
  newLoadBtn: document.getElementById('new-load-btn'),
};

// ─── Field Definitions ────────────────────────────────────────────────────

const FIELDS = [
  { key: 'pickup_location', label: '📍 Pickup Location', placeholder: 'e.g. Amarillo, TX' },
  { key: 'pickup_datetime', label: '📅 Pickup Date/Time', placeholder: 'e.g. Tue 6/24, 8:00 AM' },
  { key: 'delivery_location', label: '📍 Delivery Location', placeholder: 'e.g. Tulsa, OK' },
  { key: 'delivery_datetime', label: '📅 Delivery Date/Time', placeholder: 'e.g. Thu 6/26, 6:00 AM' },
  { key: 'commodity', label: '📦 Commodity', placeholder: 'e.g. Frozen chicken' },
  { key: 'equipment_type', label: '🚛 Equipment Type', placeholder: 'e.g. Reefer, Dry Van' },
  { key: 'rate', label: '💰 Rate', placeholder: 'e.g. $2.80/mile ($2,100 total)' },
  { key: 'weight', label: '⚖️ Weight', placeholder: 'e.g. 43,000 lbs' },
  { key: 'additional_notes', label: '📝 Additional Notes', placeholder: 'e.g. Lumpers required' },
];

// ─── Device Management ──────────────────────────────────────────────────────

async function loadDevices() {
  try {
    devices = await tauriInvoke('list_devices');

    els.deviceSelect.innerHTML = '';

    // Group: Microphones
    const micGroup = document.createElement('optgroup');
    micGroup.label = '🎤 Microphones';
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
    sysGroup.label = '🔊 System Audio';
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

  accumulatedTranscript = '';
  els.liveTranscript.textContent = '';
  els.interimTranscript.textContent = '';
  els.transcriptArea.classList.remove('hidden');
  els.extractSection.classList.add('hidden');
  els.formSection.classList.add('hidden');
  els.outputSection.classList.add('hidden');

  const options = {
    deviceId: selectedDeviceId,
    mixSystemAudio: els.mixSystemCheckbox.checked,
  };

  try {
    await tauriInvoke('start_capture_cmd', options);
    isCapturing = true;
    setCapturingUI(true);
  } catch (err) {
    console.error('Failed to start capture:', err);
    alert('Failed to start capture: ' + err);
  }
}

async function stopCapture() {
  if (!isCapturing) return;

  try {
    await tauriInvoke('stop_capture');
    isCapturing = false;
    setCapturingUI(false);

    els.extractSection.classList.remove('hidden');
    els.extractSection.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error('Error stopping capture:', err);
  }
}

function setCapturingUI(capturing) {
  if (capturing) {
    els.captureBtnText.textContent = 'Stop Capture';
    els.captureIcon.textContent = '⏹️';
    els.startCaptureBtn.classList.remove('bg-emerald-500', 'hover:bg-emerald-600');
    els.startCaptureBtn.classList.add('bg-red-500', 'hover:bg-red-600');
    els.capturingIndicator.classList.remove('hidden');
    els.deviceSelect.disabled = true;
  } else {
    els.captureBtnText.textContent = 'Start Capture';
    els.captureIcon.textContent = '🎙️';
    els.startCaptureBtn.classList.remove('bg-red-500', 'hover:bg-red-600');
    els.startCaptureBtn.classList.add('bg-emerald-500', 'hover:bg-emerald-600');
    els.capturingIndicator.classList.add('hidden');
    els.deviceSelect.disabled = false;
  }
}

function updateLiveTranscript() {
  els.liveTranscript.textContent = accumulatedTranscript;
}

function onTranscriptChunk(chunk) {
  if (chunk.is_final) {
    accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + chunk.text;
    updateLiveTranscript();
  } else {
    els.interimTranscript.textContent = chunk.text;
  }
}

function onTranscriptComplete(event) {
  const text = event.payload?.text || '';
  if (text) {
    accumulatedTranscript = text;
    updateLiveTranscript();
  }
}

// ─── Extraction Flow ──────────────────────────────────────────────────────

async function handleExtract() {
  if (!accumulatedTranscript.trim()) {
    alert('No transcript to extract from. Start a capture first.');
    return;
  }

  setExtractingUI(true);

  try {
    const result = await tauriInvoke('extract_load_data', {
      transcript: accumulatedTranscript,
    });

    currentExtractedData = result.data;
    currentConfidence = result.confidence;

    renderForm(result.data, result.confidence);
    els.formSection.classList.remove('hidden');
    els.formSection.scrollIntoView({ behavior: 'smooth' });

    renderOutput();
  } catch (err) {
    console.error('Extraction failed:', err);
    alert('Extraction failed: ' + err);
  } finally {
    setExtractingUI(false);
  }
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

// ─── Form Rendering ─────────────────────────────────────────────────────────

function renderForm(data, confidence) {
  els.fieldsContainer.innerHTML = '';

  FIELDS.forEach((field) => {
    const value = data[field.key] || '';
    const conf = confidence[field.key] || 0.0;
    const borderColor = getConfidenceBorderColor(conf);
    const badgeColor = getConfidenceBadgeColor(conf);
    const reviewFlag = needsReview(conf) ? ' ⚠️' : '';

    const fieldEl = document.createElement('div');
    fieldEl.className = 'fade-in';
    fieldEl.innerHTML = `
      <div class="flex items-center justify-between mb-1.5">
        <label class="text-sm font-medium text-slate-300" for="field-${field.key}">
          ${field.label}${reviewFlag}
        </label>
        <span class="text-xs px-2 py-0.5 rounded-full font-mono ${badgeColor}">
          ${Math.round(conf * 100)}%
        </span>
      </div>
      <input
        id="field-${field.key}"
        data-field="${field.key}"
        value="${escapeHtml(value)}"
        placeholder="${field.placeholder}"
        class="w-full bg-slate-900 border-2 ${borderColor} rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
      />
    `;

    els.fieldsContainer.appendChild(fieldEl);
  });

  els.fieldsContainer.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      currentExtractedData[input.dataset.field] = input.value;
      renderOutput();
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Output Rendering ───────────────────────────────────────────────────────

function renderOutput() {
  if (!currentExtractedData) return;

  const text = renderTemplate(DEFAULT_TEMPLATE, currentExtractedData);
  els.outputPreview.textContent = text;
  els.outputSection.classList.remove('hidden');
}

async function copyToClipboard() {
  if (!currentExtractedData) return;

  const text = renderTemplate(DEFAULT_TEMPLATE, currentExtractedData);

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

    els.copyFeedback.classList.remove('hidden');
    setTimeout(() => els.copyFeedback.classList.add('hidden'), 2000);
  } catch (err) {
    console.error('Failed to copy:', err);
    alert('Failed to copy: ' + err);
  }
}

// ─── Reset ──────────────────────────────────────────────────────────────────

function resetForm() {
  accumulatedTranscript = '';
  currentExtractedData = null;
  currentConfidence = {};
  isCapturing = false;

  els.liveTranscript.textContent = '';
  els.interimTranscript.textContent = '';
  els.transcriptArea.classList.add('hidden');
  els.extractSection.classList.add('hidden');
  els.formSection.classList.add('hidden');
  els.outputSection.classList.add('hidden');
  els.fieldsContainer.innerHTML = '';
  els.outputPreview.textContent = '';

  setCapturingUI(false);
}

// ─── Event Listeners ────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  loadDevices();

  els.startCaptureBtn.addEventListener('click', toggleCapture);
  els.extractBtn.addEventListener('click', handleExtract);
  els.copyBtn.addEventListener('click', copyToClipboard);
  els.newLoadBtn.addEventListener('click', resetForm);

  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.event) {
    window.__TAURI__.event.listen('transcript:chunk', (event) => {
      onTranscriptChunk(event.payload);
    });
    window.__TAURI__.event.listen('transcript:complete', (event) => {
      onTranscriptComplete(event);
    });
  }
});
