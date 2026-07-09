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
import { createClient } from '@supabase/supabase-js';

// ─── Supabase Config ───────────────────────────────────────────────────────
// Production: https://supabase.com/dashboard/project/tusiipxekbfheihjrjbd
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

// ─── State ──────────────────────────────────────────────────────────────────

let isCapturing = false;
let accumulatedTranscript = '';
let currentExtractedData = null;
let currentConfidence = {};
let devices = [];
let selectedDeviceId = '';
let autoExtractEnabled = false;
let lastExtractTime = 0;
const AUTO_EXTRACT_DEBOUNCE_MS = 4000;

// ─── Auth State ─────────────────────────────────────────────────────────────

let authMode = 'signin'; // 'signin' | 'signup'
let currentUser = null;

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
  autoExtractCheckbox: document.getElementById('auto-extract-checkbox'),
  formSection: document.getElementById('form-section'),
  fieldsContainer: document.getElementById('fields-container'),
  outputSection: document.getElementById('output-section'),
  outputPreview: document.getElementById('output-preview'),
  copyBtn: document.getElementById('copy-btn'),
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
};

// ─── Field Definitions ────────────────────────────────────────────────────

const FIELDS = [
  { key: 'pickup_location', label: '📍 Pickup Location', placeholder: 'e.g. Amarillo, TX' },
  { key: 'pickup_datetime', label: '📅 Pickup Date/Time', placeholder: 'e.g. Tue 6/24, 8:00 AM' },
  { key: 'pickup_type', label: '📥 Pickup Type', placeholder: 'e.g. Live load, Drop and hook, Preloaded' },
  { key: 'pickup_window', label: '⏰ Pickup Window', placeholder: 'e.g. FCFS 10am-4pm, Appointment 2PM' },
  { key: 'stops', label: '🛑 Stops', placeholder: 'e.g. Dallas, TX → Houston, TX, or None' },
  { key: 'delivery_location', label: '📍 Delivery Location', placeholder: 'e.g. Tulsa, OK' },
  { key: 'delivery_datetime', label: '📅 Delivery Date/Time', placeholder: 'e.g. Thu 6/26, 6:00 AM' },
  { key: 'delivery_type', label: '📤 Delivery Type', placeholder: 'e.g. Live unload, Drop and hook, Empty out' },
  { key: 'delivery_window', label: '⏰ Delivery Window', placeholder: 'e.g. FCFS 8am-5pm, Appointment 9AM' },
  { key: 'commodity', label: '📦 Commodity', placeholder: 'e.g. Frozen chicken' },
  { key: 'equipment_type', label: '🚛 Equipment Type', placeholder: 'e.g. Reefer, Dry Van' },
  { key: 'rate', label: '💰 Rate', placeholder: 'e.g. $2.80/mile ($2,100 total)' },
  { key: 'weight', label: '⚖️ Weight', placeholder: 'e.g. 43,000 lbs' },
  { key: 'trailer_instructions', label: '🔗 Trailer Instructions', placeholder: 'e.g. Pick empty → live load → live unload' },
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
  currentExtractedData = null;
  currentConfidence = {};
  els.liveTranscript.textContent = '';
  els.interimTranscript.textContent = '';
  els.fieldsContainer.innerHTML = '';
  els.outputPreview.textContent = '';
  els.transcriptArea.classList.remove('hidden');
  // Form and output stay visible during capture (auto-extract fills them in real-time)

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

    // Show extract section for manual trigger, but form is already visible
    els.extractSection.classList.remove('hidden');

    // Scroll to form if it has content, otherwise scroll to extract
    if (els.fieldsContainer.children.length > 0) {
      els.formSection.scrollIntoView({ behavior: 'smooth' });
    } else {
      els.extractSection.scrollIntoView({ behavior: 'smooth' });
    }
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

    // Auto-extract: when auto-extract is on and enough new text has accumulated
    if (autoExtractEnabled && accumulatedTranscript.trim()) {
      const now = Date.now();
      if (now - lastExtractTime > AUTO_EXTRACT_DEBOUNCE_MS) {
        lastExtractTime = now;
        debouncedAutoExtract();
      }
    }
  } else {
    els.interimTranscript.textContent = chunk.text;
  }
}

// ─── Auto-Extract Flow ────────────────────────────────────────────────────

let autoExtractTimeout = null;

function debouncedAutoExtract() {
  if (autoExtractTimeout) {
    clearTimeout(autoExtractTimeout);
  }
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
    setExtractingUI(true);
  }

  try {
    const result = await tauriInvoke('extract_load_data', {
      req: { transcript: accumulatedTranscript }
    });

    currentExtractedData = result.data;
    currentConfidence = result.confidence;

    renderForm(result.data, result.confidence);
    els.formSection.classList.remove('hidden');

    if (showSpinner) {
      els.formSection.scrollIntoView({ behavior: 'smooth' });
    }

    renderOutput();
  } catch (err) {
    console.error('Auto-extract failed:', err);
  } finally {
    if (showSpinner) {
      setExtractingUI(false);
    }
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

// ─── Auth Flow ───────────────────────────────────────────────────────────────

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

  els.startCaptureBtn.addEventListener('click', toggleCapture);
  els.extractBtn.addEventListener('click', handleExtract);
  els.copyBtn.addEventListener('click', copyToClipboard);
  els.newLoadBtn.addEventListener('click', resetForm);

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
  }
});
