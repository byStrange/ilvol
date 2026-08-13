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
import {
  supabase,
  getDeepgramToken,
  extractLoad,
  reportCaptureEnded,
  fetchUsageSummary,
  fetchQuotaStatus,
  createTeamMember,
  resetMemberPassword,
  changeOwnPassword,
} from './api.js';
import {
  saveLoad,
  fetchLoads,
  fetchLoad,
  setLoadStatus,
  deleteLoad,
  loadToDriverText,
} from './loads.js';
import { startTutorial } from './tutorial.js';
import {
  createOrganization,
  fetchMyMembership,
  fetchMyInvites,
  acceptInvite,
  declineInvite,
  leaveOrganization,
  fetchOrgMembers,
  removeMember,
  updateMemberRole,
  fetchOrgLoads,
  fetchOrgRecentLoads,
  updateOrganizationName,
  aggregateDispatcherStats,
} from './organizations.js';

// ─── Tauri Invoke ──────────────────────────────────────────────────────────
function tauriInvoke(cmd, args = {}) {
  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.core) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  throw new Error('Tauri runtime not available. Run inside Tauri app.');
}

/** Broadcast an app-wide event. Best-effort: outside Tauri this is a no-op. */
function tauriEmit(event, payload) {
  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.event) {
    return window.__TAURI__.event.emit(event, payload).catch((err) => {
      console.error(`emit(${event}) failed:`, err);
    });
  }
  return Promise.resolve();
}

// ─── Floating Widget Window ─────────────────────────────────────────────────
//
// The widget is a second Tauri window (label "widget") declared in
// tauri.conf.json — frameless, transparent, always-on-top, skip-taskbar,
// created hidden at startup. Show/hide is handled in Rust (toggle_widget)
// so it doesn't depend on JS-side window-control permissions.

async function toggleWidgetWindow() {
  try {
    await tauriInvoke('toggle_widget');
  } catch (err) {
    console.error('toggleWidgetWindow error:', err);
  }
}

// Custom window controls for the frameless main window. Handled in Rust so they
// don't depend on JS-side window-control permissions.
async function minimizeMainWindow() {
  try { await tauriInvoke('minimize_main'); } catch (e) { console.error(e); }
}
async function toggleMaximizeMainWindow() {
  try { await tauriInvoke('toggle_maximize_main'); } catch (e) { console.error(e); }
}
async function closeMainWindow() {
  try { await tauriInvoke('close_main'); } catch (e) { console.error(e); }
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
// Auto-fill is the default experience: the form (and the widget's orbiting
// planets) populate while the broker is still talking, rather than waiting for
// an explicit Extract. The checkbox in index.html ships `checked` to match.
let autoExtractEnabled = true;
// Metering: correlates this session's token grant, extractions and end.
let currentCaptureId = null;
let captureStartedAt = null;
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
let currentMembership = null; // { id, org_id, role, organizations: {...} } | null
let currentInvites = []; // pending invites addressed to currentUser's email
let orgRoster = []; // cached roster, populated when the org panel is open as owner/admin

// ─── App mode ───────────────────────────────────────────────────────────────
// 'capture' is the dispatcher-facing voice UI (#app); 'admin' is the org
// console (#admin-view). Exactly one is mounted at a time. Org admins mostly
// run the team rather than capture loads themselves, so they land in 'admin'
// unless they last chose otherwise.
let appMode = 'capture';
let adminSection = 'overview'; // overview | team | activity | settings
let adminLoads = []; // aggregate rows (user_id/status/created_at) for the org
let adminRecentLoads = []; // detailed recent tail, for the activity feed
let adminActivityFilter = 'all'; // 'all' | a dispatcher user_id
let adminCreateInFlight = false; // guards against a double-submit minting two accounts
let adminCredentials = null; // { email, password } — the only copy, held for the copy button
const MODE_STORAGE_KEY = 'loadform.appMode';

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
  widgetBtn: document.getElementById('widget-btn'),
  winMinimize: document.getElementById('win-minimize'),
  winMaximize: document.getElementById('win-maximize'),
  winClose: document.getElementById('win-close'),
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
  // Change own password (settings) — the other half of provisioned accounts:
  // whoever was handed a password needs somewhere to replace it.
  passwordForm: document.getElementById('password-form'),
  passwordNew: document.getElementById('password-new'),
  passwordConfirm: document.getElementById('password-confirm'),
  passwordMessage: document.getElementById('password-message'),
  // Usage display
  usagePill: document.getElementById('usage-pill'),
  usagePillLabel: document.getElementById('usage-pill-label'),
  usagePeriod: document.getElementById('usage-period'),
  usageToday: document.getElementById('usage-today'),
  usageMonth: document.getElementById('usage-month'),
  usageExtractions: document.getElementById('usage-extractions'),
  usageQuotaRow: document.getElementById('usage-quota-row'),
  usageQuotaLabel: document.getElementById('usage-quota-label'),
  usageQuotaFill: document.getElementById('usage-quota-fill'),
  usageQuotaNote: document.getElementById('usage-quota-note'),
  usageMinutes: document.getElementById('usage-minutes'),
  // Organization elements
  orgOpenBtn: document.getElementById('org-open-btn'),
  orgOpenBtnSub: document.getElementById('org-open-btn-sub'),
  orgModal: document.getElementById('org-modal'),
  orgBackBtn: document.getElementById('org-back-btn'),
  orgError: document.getElementById('org-error'),
  orgInvitesSection: document.getElementById('org-invites-section'),
  orgInvitesList: document.getElementById('org-invites-list'),
  orgCreateSection: document.getElementById('org-create-section'),
  orgCreateForm: document.getElementById('org-create-form'),
  orgCreateName: document.getElementById('org-create-name'),
  orgMemberSection: document.getElementById('org-member-section'),
  orgMemberName: document.getElementById('org-member-name'),
  orgMemberRole: document.getElementById('org-member-role'),
  orgAdminSection: document.getElementById('org-admin-section'),
  orgLeaveBtn: document.getElementById('org-leave-btn'),
  orgConsoleOpenBtn: document.getElementById('org-console-open-btn'),
  // Pending-invite banner (capture screen)
  inviteBanner: document.getElementById('invite-banner'),
  inviteBannerTitle: document.getElementById('invite-banner-title'),
  inviteBannerList: document.getElementById('invite-banner-list'),
  inviteBannerError: document.getElementById('invite-banner-error'),
  // Admin console
  appView: document.getElementById('app'),
  adminView: document.getElementById('admin-view'),
  adminModeBtn: document.getElementById('admin-mode-btn'),
  adminCaptureBtn: document.getElementById('admin-capture-btn'),
  adminOrgName: document.getElementById('admin-org-name'),
  adminOrgRole: document.getElementById('admin-org-role'),
  adminUserEmail: document.getElementById('admin-user-email'),
  adminSectionTitle: document.getElementById('admin-section-title'),
  adminSectionSub: document.getElementById('admin-section-sub'),
  adminRefreshBtn: document.getElementById('admin-refresh-btn'),
  adminError: document.getElementById('admin-error'),
  adminTeamCount: document.getElementById('admin-team-count'),
  adminWinMinimize: document.getElementById('admin-win-minimize'),
  adminWinMaximize: document.getElementById('admin-win-maximize'),
  adminWinClose: document.getElementById('admin-win-close'),
  // Admin console — overview
  adminKpis: document.getElementById('admin-kpis'),
  adminStatsBody: document.getElementById('admin-stats-body'),
  adminStatsEmpty: document.getElementById('admin-stats-empty'),
  // Admin console — team
  adminCreateMemberForm: document.getElementById('admin-create-member-form'),
  adminCreateEmail: document.getElementById('admin-create-email'),
  adminCreateRole: document.getElementById('admin-create-role'),
  adminCreatePassword: document.getElementById('admin-create-password'),
  adminCreateSubmit: document.getElementById('admin-create-submit'),
  adminCredentials: document.getElementById('admin-credentials'),
  adminCredentialsTitle: document.getElementById('admin-credentials-title'),
  adminCredentialsEmail: document.getElementById('admin-credentials-email'),
  adminCredentialsPassword: document.getElementById('admin-credentials-password'),
  adminCredentialsPasswordRow: document.getElementById('admin-credentials-password-row'),
  adminCredentialsNote: document.getElementById('admin-credentials-note'),
  adminCredentialsCopy: document.getElementById('admin-credentials-copy'),
  adminCredentialsDismiss: document.getElementById('admin-credentials-dismiss'),
  adminRoster: document.getElementById('admin-roster'),
  adminSeatSummary: document.getElementById('admin-seat-summary'),
  // Admin console — activity
  adminActivityList: document.getElementById('admin-activity-list'),
  adminActivityEmpty: document.getElementById('admin-activity-empty'),
  adminActivityFilter: document.getElementById('admin-activity-filter'),
  // Admin console — settings
  adminOrgNameForm: document.getElementById('admin-org-name-form'),
  adminOrgNameInput: document.getElementById('admin-org-name-input'),
  adminOrgNameSaved: document.getElementById('admin-org-name-saved'),
  adminBillingPreview: document.getElementById('admin-billing-preview'),
  adminMembershipNote: document.getElementById('admin-membership-note'),
  adminLeaveBtn: document.getElementById('admin-leave-btn'),
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
//
// The Rust backend is the single source of truth for capture state and
// broadcasts `capture:state` { running, deviceId, mixSystemAudio } to every
// window on start/stop. Both the main window and the floating widget react to
// that event, so whichever side starts or stops capture, both UIs stay in
// sync. The click handlers below only validate + invoke the command; all UI
// transitions live in enterListeningUI / exitListeningUI, driven by
// onCaptureState.

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
  try {
    // Mint a fresh short-lived Deepgram token per capture. This is also the
    // server-side gate where quota will be enforced, so a failure here is a
    // legitimate reason not to start.
    const mixSystemAudio = els.mixSystemCheckbox.checked;
    const { token, captureId, capturesRemaining, capturesLimit } =
      await getDeepgramToken(mixSystemAudio ? 'mixed' : 'mic');
    currentCaptureId = captureId;
    // The grant response already carries the post-increment count, so the
    // counter can drop immediately without another round trip mid-capture.
    if (capturesLimit !== null && capturesRemaining !== null) {
      els.usagePillLabel.textContent = `${capturesRemaining} of ${capturesLimit} loads left`;
    }
    captureStartedAt = Date.now();
    await tauriInvoke('start_capture_cmd', {
      deviceId: selectedDeviceId,
      mixSystemAudio,
      deepgramToken: token,
    });
  } catch (err) {
    console.error('Failed to start capture:', err);
    // The server's message names the actual limit and when it resets, so
    // prefer it over anything hardcoded here.
    alert(
      err?.quotaExceeded
        ? err.message
        : 'Failed to start capture: ' + (err?.message ?? err),
    );
    if (err?.quotaExceeded) refreshUsage();
  }
}

async function stopCapture() {
  if (!isCapturing) return;
  try {
    await tauriInvoke('stop_capture');
  } catch (err) {
    console.error('Error stopping capture:', err);
  }

  // Report duration before clearing, so we learn actual minutes-per-load.
  if (currentCaptureId && captureStartedAt) {
    reportCaptureEnded(
      currentCaptureId,
      Math.round((Date.now() - captureStartedAt) / 1000),
    );
  }
  captureStartedAt = null;
}

function enterListeningUI() {
  accumulatedTranscript = '';
  transcriptWords = [];
  currentExtractedData = null;
  currentConfidence = {};
  currentLoadId = null; // a new capture session starts a fresh load
  els.liveTranscript.innerHTML = '';
  renderEmptyFieldCards(); // reset cards to empty placeholders
  els.outputPreview.textContent = '';
  els.outputSection.classList.add('hidden');
  els.extractSection.classList.add('hidden');
  els.transcriptArea.classList.remove('hidden');
  els.transcriptArea.classList.add('has-text');
  isCapturing = true;
  // Each session gets a fresh auto-extract clock. Otherwise a capture started
  // shortly after the previous one ended inherits its last-extract timestamp
  // and sits behind the debounce gate, so the first planets arrive late.
  lastExtractTime = 0;
  setStatus('listening');
  resetMeters();
  els.meterContainer.classList.remove('hidden');
}

function exitListeningUI() {
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

function onCaptureState(payload) {
  if (payload?.running) {
    // Sync the device/mix controls to reflect what's actually capturing, so
    // the main UI matches a session started from the widget (and vice versa).
    if (typeof payload.deviceId === 'string') {
      selectedDeviceId = payload.deviceId;
      if (els.deviceSelect) els.deviceSelect.value = payload.deviceId;
    }
    if (typeof payload.mixSystemAudio === 'boolean' && els.mixSystemCheckbox) {
      els.mixSystemCheckbox.checked = payload.mixSystemAudio;
    }
    enterListeningUI();
  } else {
    exitListeningUI();
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
    const answer = await extractLoad(accumulatedTranscript, currentCaptureId);

    // Extraction now happens server-side, so Rust no longer emits `load:fields`
    // itself — hand the answer back so the widget's planet chips still update.
    // Rust folds it into the load accumulated so far and returns that, which is
    // what we render: this answer alone would drop fields the model went quiet
    // about, and would leave the form disagreeing with the widget.
    //
    // Outside the Tauri runtime (plain `vite dev`) the invoke fails, so fall
    // back to the raw answer rather than rendering nothing.
    const result = await tauriInvoke('broadcast_load_fields', { fields: answer })
      .catch(() => answer);

    currentExtractedData = result.data;
    currentConfidence = result.confidence;

    renderFieldCards(result.data, result.confidence);
    renderOutput();

    // Persist the extracted load (insert on first save, update thereafter).
    await saveCurrentLoad();

    // Auto-extract fires repeatedly within one call, but each run records a
    // usage event, so the counter genuinely moves. Refresh it here so the pill
    // tracks reality instead of going stale until the next sign-in.
    refreshUsage();

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
    // Auto-extract retries on a timer, so a transient failure is fine to
    // swallow. A quota wall is not — it will not resolve on its own, and
    // silently producing no fields would look like the app is broken.
    if (err?.quotaExceeded) {
      autoExtractEnabled = false;
      alert('You have reached your load limit. Upgrade your plan to keep extracting.');
    } else if (showSpinner) {
      alert('Extraction failed: ' + (err?.message ?? err));
    }
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

  // Extractions accumulate in the backend across a session, so the load being
  // cleared has to be cleared there too — otherwise the next conversation's
  // first extraction merges into this one's fields.
  tauriInvoke('reset_extraction').catch((err) => {
    console.error('reset_extraction failed:', err);
  });

  // The floating widget is showing planets for the load we just cleared. It
  // owns its own slot bookkeeping, so it has to retract them itself — closing
  // the windows from here would leave its map pointing at dead windows.
  tauriEmit('load:reset');

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
    accumulatedTranscript,
    currentMembership?.org_id
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
  loadsList = await fetchLoads(supabase, currentUser.id);
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

  // We're on a different load now. Re-extracting from here should read this
  // load's transcript on its own, not fold into whatever the backend was still
  // accumulating for the session we just navigated away from.
  tauriInvoke('reset_extraction').catch((err) => {
    console.error('reset_extraction failed:', err);
  });

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
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        currentUser = session.user;
        hideAuthModal();
        refreshLoadsList();
        await refreshOrgContext();
        setAppMode(initialModeFor());
        refreshUsage();
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
  // A password half-typed on a previous visit shouldn't still be sitting there.
  els.passwordForm.reset();
  els.passwordMessage.classList.add('hidden');
  refreshUsage();
}

function hideSettingsModal() {
  els.settingsModal.classList.add('hidden');
}

/** Matches supabase/config.toml's minimum_password_length, so we reject a short
 * password here rather than letting GoTrue do it a round-trip later. */
const MIN_PASSWORD_LENGTH = 6;

/**
 * Replace the signed-in user's own password. The dispatcher-facing half of
 * provisioned accounts: this is how a handed-over password stops being the
 * owner's to know.
 */
async function handlePasswordSubmit(e) {
  e.preventDefault();
  const password = els.passwordNew.value;
  const confirm = els.passwordConfirm.value;

  if (password.length < MIN_PASSWORD_LENGTH) {
    showPasswordMessage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, false);
    return;
  }
  if (password !== confirm) {
    showPasswordMessage("Those two passwords don't match", false);
    return;
  }

  const { ok, error } = await changeOwnPassword(password);
  if (!ok) {
    showPasswordMessage(error || 'Could not update your password', false);
    return;
  }
  els.passwordForm.reset();
  showPasswordMessage('Password updated.', true);
}

function showPasswordMessage(message, ok) {
  els.passwordMessage.textContent = message;
  els.passwordMessage.classList.remove('hidden', 'text-emerald-400', 'text-red-400');
  els.passwordMessage.classList.add(ok ? 'text-emerald-400' : 'text-red-400');
}

// ─── Usage Display ──────────────────────────────────────────────────────────
//
// Shows plain counts, not "8 / 15". No quota is enforced yet, and inventing a
// limit to fill the slot would train users to expect a number we haven't
// decided on. When plans land, the pill becomes "used / allowed" and this is
// the one place that changes.

function formatDuration(totalSeconds) {
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

/**
 * Draw the daily-limit meter. An unlimited plan (null limit) hides the row
 * entirely rather than drawing an empty bar that implies a cap exists.
 */
function renderQuota(quota) {
  const capped = quota && quota.capturesLimit !== null && quota.capturesLimit !== undefined;
  els.usageQuotaRow.classList.toggle('hidden', !capped);
  if (!capped) {
    els.usageQuotaNote.textContent = 'Resets at midnight US Central.';
    return;
  }

  const { capturesUsed: used, capturesLimit: limit } = quota;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  els.usageQuotaLabel.textContent = `${Math.min(used, limit)} of ${limit} loads used`;
  els.usageQuotaFill.style.width = `${pct}%`;
  els.usageQuotaFill.classList.toggle('is-warning', used >= limit - 1 && used < limit);
  els.usageQuotaFill.classList.toggle('is-full', used >= limit);
  els.usageQuotaNote.textContent =
    used >= limit
      ? "You've used today's loads. The limit resets at midnight US Central."
      : 'Resets at midnight US Central.';
}

async function refreshUsage() {
  if (!currentUser) return;

  const [usage, quota] = await Promise.all([fetchUsageSummary(), fetchQuotaStatus()]);
  if (!usage) {
    // Leave whatever was last shown rather than flashing zeroes, which would
    // read as "your work wasn't counted".
    return;
  }

  renderQuota(quota);

  els.usagePill.classList.remove('hidden');
  // Against a cap, the useful number is what's left, not what's spent.
  els.usagePillLabel.textContent =
    quota && quota.capturesLimit !== null
      ? `${Math.max(0, quota.capturesLimit - quota.capturesUsed)} of ${quota.capturesLimit} loads left`
      : usage.loadsToday === 1
        ? '1 load today'
        : `${usage.loadsToday} loads today`;

  els.usageToday.textContent = usage.loadsToday;
  els.usageMonth.textContent = usage.loadsMonth;
  els.usageExtractions.textContent = usage.extractionsMonth;
  els.usageMinutes.textContent = formatDuration(usage.audioSecondsMonth);

  els.usagePeriod.textContent = new Date().toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
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
      refreshLoadsList();
      await refreshOrgContext();
      setAppMode(initialModeFor());
      refreshUsage();
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

// ─── Organizations ──────────────────────────────────────────────────────────

// Reload the caller's membership + (if they have none) pending invites.
// Called after every sign-in and after any org action that could change them.
async function refreshOrgContext() {
  if (!currentUser) {
    currentMembership = null;
    currentInvites = [];
  } else {
    currentMembership = await fetchMyMembership(supabase, currentUser.id);
    currentInvites = currentMembership ? [] : await fetchMyInvites(supabase, currentUser.email);
  }
  // Always repaint, including the signed-out case: clearing the state without
  // clearing the UI would leave a previous user's invites on screen.
  updateOrgOpenButton();
  updateAdminEntryPoints();
  renderInviteBanner();
}

// ─── Pending-invite banner ──────────────────────────────────────────────────
//
// currentInvites is only ever populated for a user with no active membership
// (see refreshOrgContext), so this banner is inherently capture-mode only.

function renderInviteBanner() {
  if (!els.inviteBanner) return;
  const invites = currentInvites;
  els.inviteBanner.classList.toggle('hidden', invites.length === 0);
  hideInviteBannerError();
  if (invites.length === 0) {
    els.inviteBannerList.innerHTML = '';
    return;
  }

  els.inviteBannerTitle.textContent =
    invites.length === 1
      ? "You've been invited to a team"
      : `You have ${invites.length} team invitations`;

  els.inviteBannerList.innerHTML = '';
  for (const invite of invites) {
    const row = document.createElement('div');
    row.className = 'lf-invite-row';
    row.innerHTML = `
      <span class="flex-1 min-w-0">
        <span class="block text-sm text-white font-medium truncate">${escapeHtml(invite.organizations?.name || 'Organization')}</span>
        <span class="block text-xs text-slate-500 mt-0.5">Joining as ${escapeHtml(invite.role)}</span>
      </span>
      <span class="flex gap-2 shrink-0">
        <button type="button" class="lf-btn py-1.5 px-3 bg-emerald-500 hover:bg-emerald-600 text-slate-900 text-xs font-medium" data-invite-action="accept" data-invite-id="${invite.id}">Accept</button>
        <button type="button" class="lf-btn py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium" data-invite-action="decline" data-invite-id="${invite.id}">Decline</button>
      </span>`;
    els.inviteBannerList.appendChild(row);
  }
}

let inviteNoticeTimer = null;

/** Briefly reuse the banner to confirm a join, then hide it for good. */
function showInviteJoinedNotice(orgName) {
  els.inviteBannerTitle.textContent = orgName ? `You've joined ${orgName}` : "You've joined the team";
  els.inviteBannerList.innerHTML =
    '<p class="text-xs text-slate-400">Loads you capture from now on appear on the organization\'s dashboard.</p>';
  els.inviteBanner.classList.remove('hidden');
  clearTimeout(inviteNoticeTimer);
  inviteNoticeTimer = setTimeout(() => {
    // Guard against a sign-out or a new invite arriving inside the delay.
    if (currentInvites.length === 0) els.inviteBanner.classList.add('hidden');
  }, 6000);
}

function showInviteBannerError(message) {
  els.inviteBannerError.textContent = message;
  els.inviteBannerError.classList.remove('hidden');
}

function hideInviteBannerError() {
  els.inviteBannerError.classList.add('hidden');
}

async function handleInviteBannerClick(e) {
  const btn = e.target.closest('[data-invite-action]');
  if (!btn) return;
  hideInviteBannerError();
  const inviteId = btn.dataset.inviteId;

  if (btn.dataset.inviteAction === 'accept') {
    // Read the org name before accepting — refreshOrgContext clears the invite
    // list this row was rendered from.
    const orgName = currentInvites.find((i) => i.id === inviteId)?.organizations?.name;
    const { ok, error } = await acceptInvite(supabase, inviteId);
    if (!ok) {
      showInviteBannerError(error || 'Could not accept the invitation');
      return;
    }
    await refreshOrgContext();
    // Accepting an *admin* invite makes the console their home screen, so send
    // them straight there rather than leaving them on capture wondering where
    // the team tools are.
    if (isOrgAdmin()) {
      setAppMode('admin');
      return;
    }
    // A dispatcher stays on capture, where the banner has just hidden itself.
    // Confirm the join rather than letting it vanish silently.
    showInviteJoinedNotice(orgName);
    return;
  }

  const { ok, error } = await declineInvite(supabase, inviteId);
  if (!ok) {
    showInviteBannerError(error || 'Could not decline the invitation');
    return;
  }
  await refreshOrgContext();
}

/** Is the signed-in user an owner/admin of an org? Gates every admin surface. */
function isOrgAdmin() {
  return !!currentMembership && ['owner', 'admin'].includes(currentMembership.role);
}

function updateOrgOpenButton() {
  if (!els.orgOpenBtnSub) return;
  if (currentMembership) {
    const org = currentMembership.organizations;
    els.orgOpenBtnSub.textContent = `${org?.name || 'Organization'} · ${currentMembership.role}`;
  } else if (currentInvites.length > 0) {
    els.orgOpenBtnSub.textContent = `${currentInvites.length} pending invitation${currentInvites.length > 1 ? 's' : ''}`;
  } else {
    els.orgOpenBtnSub.textContent = 'Not part of an organization';
  }
}

/** Show/hide the admin affordances, and bail out of admin mode if the user
 * no longer qualifies (demoted themselves, left, or signed out). */
function updateAdminEntryPoints() {
  const admin = isOrgAdmin();
  if (els.adminModeBtn) {
    els.adminModeBtn.classList.toggle('hidden', !admin);
    els.adminModeBtn.classList.toggle('flex', admin);
  }
  if (els.orgAdminSection) els.orgAdminSection.classList.toggle('hidden', !admin);
  if (!admin && appMode === 'admin') setAppMode('capture');
}

function showOrgError(message) {
  els.orgError.textContent = message;
  els.orgError.classList.remove('hidden');
}

function hideOrgError() {
  els.orgError.classList.add('hidden');
}

async function showOrgModal() {
  hideSettingsModal();
  hideOrgError();
  els.orgModal.classList.remove('hidden');
  els.orgModal.classList.add('flex');
  await refreshOrgContext();
  // No roster fetch here any more: the roster belongs to the admin console,
  // which loads it itself. This modal only shows membership + invites.
  renderOrgModal();
}

function hideOrgModal() {
  els.orgModal.classList.add('hidden');
  els.orgModal.classList.remove('flex');
}

function renderOrgModal() {
  const hasInvites = currentInvites.length > 0;
  els.orgInvitesSection.classList.toggle('hidden', !hasInvites);
  els.orgCreateSection.classList.toggle('hidden', !!currentMembership);
  els.orgMemberSection.classList.toggle('hidden', !currentMembership);

  if (hasInvites) {
    els.orgInvitesList.innerHTML = '';
    for (const invite of currentInvites) {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-950/40 border border-white/5';
      row.innerHTML = `
        <span class="text-sm text-slate-200 truncate">${escapeHtml(invite.organizations?.name || 'Organization')} <span class="text-slate-500">· ${escapeHtml(invite.role)}</span></span>
        <span class="flex gap-2 shrink-0">
          <button type="button" class="lf-btn py-1.5 px-3 bg-emerald-500 hover:bg-emerald-600 text-slate-900 text-xs font-medium" data-org-action="accept" data-invite-id="${invite.id}">Accept</button>
          <button type="button" class="lf-btn py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium" data-org-action="decline" data-invite-id="${invite.id}">Decline</button>
        </span>`;
      els.orgInvitesList.appendChild(row);
    }
  }

  if (currentMembership) {
    const org = currentMembership.organizations;
    els.orgMemberName.textContent = org?.name || 'Organization';
    els.orgMemberRole.textContent = `Role: ${currentMembership.role}`;

    // Admin-only surfaces live in the console now; this modal just offers the
    // way in (updateAdminEntryPoints owns that row's visibility).
    updateAdminEntryPoints();
    // Owners can't leave their own org in v1 (no ownership transfer yet).
    els.orgLeaveBtn.classList.toggle('hidden', currentMembership.role === 'owner');
  }
}

async function handleOrgCreateSubmit(e) {
  e.preventDefault();
  hideOrgError();
  const name = els.orgCreateName.value.trim();
  if (!name) return;
  const { organization, error } = await createOrganization(supabase, name);
  if (error || !organization) {
    showOrgError(error || 'Could not create organization');
    return;
  }
  els.orgCreateForm.reset();
  await showOrgModal();
}

// Invite accept/decline. Roster management (invite, role change, remove) is
// an admin action and lives in the console — see handleAdminRosterClick.
async function handleOrgModalClick(e) {
  const btn = e.target.closest('[data-org-action]');
  if (!btn) return;
  hideOrgError();
  const action = btn.dataset.orgAction;

  if (action === 'accept') {
    const { ok, error } = await acceptInvite(supabase, btn.dataset.inviteId);
    if (!ok) {
      showOrgError(error || 'Could not accept invite');
      return;
    }
    await showOrgModal();
  } else if (action === 'decline') {
    await declineInvite(supabase, btn.dataset.inviteId);
    await showOrgModal();
  }
}

async function handleOrgLeave() {
  if (!currentMembership) return;
  const { ok, error } = await leaveOrganization(supabase);
  if (!ok) {
    showOrgError(error || 'Could not leave organization');
    return;
  }
  await showOrgModal();
}

// ─── App mode switching ─────────────────────────────────────────────────────

/**
 * Mount either the capture UI or the admin console. Switching *into* admin
 * loads its data; switching out leaves the cached rows alone so coming back
 * is instant (the refresh button and every mutation re-fetch anyway).
 *
 * Only a deliberate switch is remembered (`persist`). Forced drops to capture
 * — sign-out, losing admin rights — must not overwrite the stored preference,
 * or an admin who signs out once would stop landing in the console.
 */
function setAppMode(mode, { persist = false } = {}) {
  const target = mode === 'admin' && isOrgAdmin() ? 'admin' : 'capture';
  appMode = target;
  if (persist) {
    try {
      localStorage.setItem(MODE_STORAGE_KEY, target);
    } catch {
      // Private mode / storage disabled: the choice just won't survive a restart.
    }
  }
  els.appView.classList.toggle('hidden', target === 'admin');
  els.adminView.classList.toggle('hidden', target !== 'admin');
  if (target === 'admin') {
    hideSettingsModal();
    hideOrgModal();
    setAdminSection(adminSection); // re-assert nav/panel pairing on re-entry
    refreshAdminConsole();
  }
}

/** Where a signed-in user should land. Admins default into the console — they
 * run the team rather than capture loads — but a remembered choice wins. */
function initialModeFor() {
  if (!isOrgAdmin()) return 'capture';
  let stored = null;
  try {
    stored = localStorage.getItem(MODE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return stored === 'capture' ? 'capture' : 'admin';
}

// ─── Admin console ──────────────────────────────────────────────────────────

const ADMIN_SECTIONS = {
  overview: { title: 'Overview', sub: 'How your dispatchers are performing.' },
  team: { title: 'Team', sub: 'Add dispatchers and manage who can do what.' },
  activity: { title: 'Activity', sub: 'Every load your dispatchers have captured.' },
  settings: { title: 'Settings', sub: 'Organization name, seats, and billing.' },
};

function showAdminError(message) {
  els.adminError.textContent = message;
  els.adminError.classList.remove('hidden');
}

function hideAdminError() {
  els.adminError.classList.add('hidden');
}

function setAdminSection(section) {
  if (!ADMIN_SECTIONS[section]) return;
  adminSection = section;
  hideAdminError();
  // Credentials are shown once, in context. Navigating away is the admin saying
  // they're done with them.
  hideAdminCredentials();
  for (const btn of document.querySelectorAll('[data-admin-section]')) {
    btn.classList.toggle('is-active', btn.dataset.adminSection === section);
  }
  for (const key of Object.keys(ADMIN_SECTIONS)) {
    const panel = document.getElementById(`admin-panel-${key}`);
    if (panel) panel.classList.toggle('hidden', key !== section);
  }
  els.adminSectionTitle.textContent = ADMIN_SECTIONS[section].title;
  els.adminSectionSub.textContent = ADMIN_SECTIONS[section].sub;
}

/** Re-fetch everything the console shows, then repaint all four panels. */
async function refreshAdminConsole() {
  if (!isOrgAdmin()) return;
  hideAdminError();
  const orgId = currentMembership.org_id;
  const [loads, members, recent] = await Promise.all([
    fetchOrgLoads(supabase, orgId),
    fetchOrgMembers(supabase, orgId),
    fetchOrgRecentLoads(supabase, orgId),
  ]);
  adminLoads = loads;
  orgRoster = members;
  adminRecentLoads = recent;
  renderAdminConsole();
}

function renderAdminConsole() {
  if (!currentMembership) return;
  const org = currentMembership.organizations;
  els.adminOrgName.textContent = org?.name || 'Organization';
  els.adminOrgRole.textContent = `Signed in as ${currentMembership.role}`;
  els.adminUserEmail.textContent = currentUser?.email || '';

  const stats = aggregateDispatcherStats(adminLoads, orgRoster);
  renderAdminOverview(stats);
  renderAdminTeam();
  renderAdminActivity(stats);
  renderAdminSettings();
}

function kpiTile(label, value) {
  return `<div class="lf-kpi">
    <p class="lf-kpi-value">${escapeHtml(String(value))}</p>
    <p class="lf-kpi-label">${escapeHtml(label)}</p>
  </div>`;
}

function renderAdminOverview(stats) {
  const activeMembers = orgRoster.filter((m) => m.status === 'active');
  const last7dTotal = stats.reduce((sum, s) => sum + s.last7d, 0);
  const completed = stats.reduce((sum, s) => sum + s.completed, 0);

  els.adminKpis.innerHTML =
    kpiTile('Loads captured', adminLoads.length) +
    kpiTile('Last 7 days', last7dTotal) +
    kpiTile('Completed', completed) +
    kpiTile('Active dispatchers', activeMembers.length);

  els.adminTeamCount.textContent = activeMembers.length || '';
  els.adminStatsEmpty.classList.toggle('hidden', adminLoads.length > 0);
  els.adminStatsBody.innerHTML = '';

  // Share bars are relative to the busiest dispatcher, not to the org total —
  // with a handful of dispatchers, share-of-total bars are all too short to
  // compare at a glance.
  const busiest = stats.reduce((max, s) => Math.max(max, s.total), 0);

  for (const s of stats) {
    const pct = busiest > 0 ? Math.round((s.total / busiest) * 100) : 0;
    const row = document.createElement('tr');
    row.className = 'border-b border-white/5 last:border-0';
    row.innerHTML = `
      <td class="py-2.5 pr-3 text-slate-200">
        ${escapeHtml(s.email)}
        ${s.role ? `<span class="lf-admin-tag ml-1.5${s.role === 'owner' ? ' is-owner' : ''}">${escapeHtml(s.role)}</span>` : '<span class="lf-admin-tag ml-1.5">left org</span>'}
      </td>
      <td class="py-2.5 text-right text-white font-medium tabular-nums">${s.total}</td>
      <td class="py-2.5 text-right text-slate-300 tabular-nums">${s.last7d}</td>
      <td class="py-2.5 text-right text-slate-300 tabular-nums">${s.last30d}</td>
      <td class="py-2.5 text-right text-slate-300 tabular-nums">${s.active}</td>
      <td class="py-2.5 text-right text-slate-300 tabular-nums">${s.completed}</td>
      <td class="py-2.5 pl-3">
        <div class="lf-share-track"><div class="lf-share-fill" style="width:${pct}%"></div></div>
      </td>`;
    els.adminStatsBody.appendChild(row);
  }
}

function renderAdminTeam() {
  const active = orgRoster.filter((m) => m.status === 'active').length;
  const pending = orgRoster.filter((m) => m.status === 'invited').length;
  els.adminSeatSummary.textContent = pending
    ? `${active} active · ${pending} pending`
    : `${active} active`;

  els.adminRoster.innerHTML = '';
  for (const member of orgRoster) {
    const isPending = member.status === 'invited';
    const canManage = member.role !== 'owner';
    // Only logins this org created can have their password reset from here —
    // see the provisioned_at comment in the migration.
    const canResetPassword = canManage && !isPending && !!member.provisioned_at;
    const roleControl = canManage
      ? `<select class="lf-select w-auto text-xs py-1" data-admin-role-select data-member-id="${member.id}">
           <option value="dispatcher"${member.role === 'dispatcher' ? ' selected' : ''}>Dispatcher</option>
           <option value="admin"${member.role === 'admin' ? ' selected' : ''}>Admin</option>
         </select>`
      : '<span class="lf-admin-tag is-owner">owner</span>';

    const row = document.createElement('div');
    row.className = 'lf-admin-row';
    row.innerHTML = `
      <span class="flex-1 min-w-0">
        <span class="block text-sm text-slate-200 truncate">${escapeHtml(member.invited_email)}</span>
        <span class="block text-xs text-slate-500 mt-0.5">
          ${isPending ? 'Invitation sent — not yet accepted' : `Joined ${formatAdminDate(member.accepted_at || member.created_at)}`}
        </span>
      </span>
      ${isPending ? '<span class="lf-admin-tag is-pending shrink-0">pending</span>' : ''}
      <span class="flex items-center gap-2 shrink-0">
        ${roleControl}
        ${canResetPassword ? `<button type="button" class="lf-btn py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium" data-admin-action="reset-password" data-member-id="${member.id}">Reset password</button>` : ''}
        ${canManage ? `<button type="button" class="lf-btn py-1.5 px-3 bg-red-500/15 hover:bg-red-500/25 text-red-400 text-xs font-medium" data-admin-action="remove" data-member-id="${member.id}">${isPending ? 'Revoke' : 'Remove'}</button>` : ''}
      </span>`;
    els.adminRoster.appendChild(row);
  }
}

function renderAdminActivity(stats) {
  // Keep the chosen dispatcher selected across repaints where possible; fall
  // back to "all" if that dispatcher is no longer in the list.
  const options = ['<option value="all">All dispatchers</option>'];
  for (const s of stats) {
    options.push(
      `<option value="${escapeHtml(s.userId)}"${s.userId === adminActivityFilter ? ' selected' : ''}>${escapeHtml(s.email)}</option>`
    );
  }
  els.adminActivityFilter.innerHTML = options.join('');
  if (els.adminActivityFilter.value !== adminActivityFilter) {
    adminActivityFilter = 'all';
    els.adminActivityFilter.value = 'all';
  }

  const rows =
    adminActivityFilter === 'all'
      ? adminRecentLoads
      : adminRecentLoads.filter((l) => l.user_id === adminActivityFilter);

  const emailByUser = new Map(stats.map((s) => [s.userId, s.email]));
  els.adminActivityEmpty.classList.toggle('hidden', rows.length > 0);
  els.adminActivityList.innerHTML = '';

  for (const load of rows) {
    const lane = [load.pickup_location, load.delivery_location].filter(Boolean).join(' → ');
    const meta = [load.equipment_type, load.rate].filter(Boolean).join(' · ');
    const row = document.createElement('div');
    row.className = 'lf-admin-row';
    row.innerHTML = `
      <span class="flex-1 min-w-0">
        <span class="block text-sm text-slate-200 truncate">${escapeHtml(load.title || 'Untitled load')}</span>
        <span class="block text-xs text-slate-500 mt-0.5 truncate">
          ${escapeHtml(lane || 'No lane captured')}${meta ? ` · ${escapeHtml(meta)}` : ''}
        </span>
      </span>
      <span class="text-xs text-slate-500 shrink-0 hidden sm:block">${escapeHtml(emailByUser.get(load.user_id) || 'Former member')}</span>
      <span class="lf-admin-tag shrink-0">${escapeHtml(load.status)}</span>
      <span class="text-xs text-slate-600 shrink-0 tabular-nums">${escapeHtml(formatAdminDate(load.created_at))}</span>`;
    els.adminActivityList.appendChild(row);
  }
}

function renderAdminSettings() {
  const org = currentMembership.organizations;
  // Don't clobber what an admin is mid-way through typing.
  if (document.activeElement !== els.adminOrgNameInput) {
    els.adminOrgNameInput.value = org?.name || '';
  }

  const active = orgRoster.filter((m) => m.status === 'active').length;
  const pending = orgRoster.filter((m) => m.status === 'invited').length;
  els.adminBillingPreview.innerHTML = `
    <p><span class="text-white font-medium tabular-nums">${active}</span> billable seat${active === 1 ? '' : 's'} in use</p>
    ${pending ? `<p class="text-slate-500 mt-1">${pending} invited seat${pending === 1 ? '' : 's'} not yet counted</p>` : ''}`;

  const isOwner = currentMembership.role === 'owner';
  els.adminMembershipNote.textContent = isOwner
    ? "You own this organization. Ownership can't be transferred yet, so the owner account can't leave."
    : `You're an admin of ${org?.name || 'this organization'}.`;
  els.adminLeaveBtn.classList.toggle('hidden', isOwner);
}

function formatAdminDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Create a dispatcher's login, or fall back to an invite.
 *
 * The server decides which of the two happened — an address that already has a
 * LoadForm account can't have one made for it — so the outcome it reports, not
 * what was submitted, is what gets shown.
 */
async function handleAdminCreateMemberSubmit(e) {
  e.preventDefault();
  hideAdminError();
  hideAdminCredentials();
  if (!isOrgAdmin() || adminCreateInFlight) return;

  const email = els.adminCreateEmail.value.trim();
  if (!email) return;
  const password = els.adminCreatePassword.value.trim();

  setAdminCreateBusy(true);
  try {
    const result = await createTeamMember({
      email,
      password: password || null,
      role: els.adminCreateRole.value,
    });
    els.adminCreateMemberForm.reset();
    if (result.outcome === 'created') {
      showAdminCredentials('Account created', result.email, result.password);
    } else {
      // No credentials to hand over on this path: they already have a login of
      // their own, so all we did was ask them to join.
      showAdminCredentials(
        'Invitation sent',
        result.email,
        null,
        'That address already has a LoadForm account, so they were invited instead. ' +
          'They join once they accept.'
      );
    }
    await refreshAdminConsole();
  } catch (err) {
    showAdminError(err.message || 'Could not create the account');
  } finally {
    setAdminCreateBusy(false);
  }
}

function setAdminCreateBusy(busy) {
  adminCreateInFlight = busy;
  els.adminCreateSubmit.disabled = busy;
  els.adminCreateSubmit.textContent = busy ? 'Creating…' : 'Create account';
}

/**
 * Show credentials once. `password` is null on the invite path, where there is
 * nothing to hand over — the row is dropped rather than shown empty.
 */
function showAdminCredentials(title, email, password, note = null) {
  els.adminCredentialsTitle.textContent = title;
  els.adminCredentialsEmail.textContent = email;
  els.adminCredentialsPassword.textContent = password || '';
  els.adminCredentialsPasswordRow.classList.toggle('hidden', !password);
  els.adminCredentialsCopy.classList.toggle('hidden', !password);

  // The standing "share these now" warning is only true when there is a
  // password; the invite path replaces it with what actually happened.
  els.adminCredentialsNote.textContent =
    note || "Share these now — the password isn't shown again.";

  els.adminCredentials.classList.remove('hidden');
  adminCredentials = password ? { email, password } : null;
}

function hideAdminCredentials() {
  els.adminCredentials.classList.add('hidden');
  adminCredentials = null;
}

async function handleAdminCredentialsCopy() {
  if (!adminCredentials) return;
  const ok = await writeTextToClipboard(
    `${adminCredentials.email}\n${adminCredentials.password}`
  );
  if (!ok) return;
  els.adminCredentialsCopy.textContent = 'Copied';
  setTimeout(() => {
    els.adminCredentialsCopy.textContent = 'Copy both';
  }, 2000);
}

/**
 * Reset a provisioned dispatcher's password.
 *
 * Confirmed first because it invalidates the password they may already be
 * using, and there is no mail to tell them so — the admin has to hand the new
 * one over in person.
 */
async function handleAdminResetPassword(memberId) {
  const member = orgRoster.find((m) => m.id === memberId);
  const confirmed = window.confirm(
    `Set a new password for ${member?.invited_email || 'this dispatcher'}? ` +
      "You'll need to give it to them — their current password stops working."
  );
  if (!confirmed) return;

  hideAdminError();
  hideAdminCredentials();
  try {
    const result = await resetMemberPassword({ memberId });
    showAdminCredentials('New password', result.email, result.password);
  } catch (err) {
    showAdminError(err.message || 'Could not reset the password');
  }
}

async function handleAdminRosterClick(e) {
  const btn = e.target.closest('[data-admin-action]');
  if (!btn) return;
  hideAdminError();
  const memberId = btn.dataset.memberId;

  if (btn.dataset.adminAction === 'reset-password') {
    await handleAdminResetPassword(memberId);
    return;
  }

  const member = orgRoster.find((m) => m.id === memberId);
  const { ok, error } = await removeMember(supabase, memberId, member?.status);
  if (!ok) {
    showAdminError(error || 'Could not remove member');
    return;
  }
  await handlePostRosterMutation(memberId);
}

async function handleAdminRoleChange(e) {
  const select = e.target.closest('[data-admin-role-select]');
  if (!select) return;
  hideAdminError();
  const memberId = select.dataset.memberId;
  const { ok, error } = await updateMemberRole(supabase, memberId, select.value);
  if (!ok) showAdminError(error || 'Could not update role');
  await handlePostRosterMutation(memberId);
}

/**
 * After any roster write, re-read the org context *first* when the row that
 * changed is the acting admin's own: demoting or removing yourself revokes
 * your access to the console, so `currentMembership` has to be re-derived
 * before anything tries to repaint admin-only data with it.
 */
async function handlePostRosterMutation(memberId) {
  if (memberId === currentMembership?.id) {
    await refreshOrgContext();
    if (!isOrgAdmin()) return; // updateAdminEntryPoints already bounced us out
  }
  await refreshAdminConsole();
}

async function handleAdminOrgNameSubmit(e) {
  e.preventDefault();
  hideAdminError();
  if (!isOrgAdmin()) return;
  const name = els.adminOrgNameInput.value.trim();
  if (!name) return;
  const { ok, error } = await updateOrganizationName(supabase, currentMembership.org_id, name);
  if (!ok) {
    showAdminError(error || 'Could not rename organization');
    return;
  }
  els.adminOrgNameSaved.classList.remove('hidden');
  setTimeout(() => els.adminOrgNameSaved.classList.add('hidden'), 2000);
  await refreshOrgContext();
  renderAdminConsole();
}

async function handleAdminLeave() {
  hideAdminError();
  const { ok, error } = await leaveOrganization(supabase);
  if (!ok) {
    showAdminError(error || 'Could not leave organization');
    return;
  }
  await refreshOrgContext(); // drops admin rights, which bounces us to capture
}

// fetchAndSetApiKeys() is gone. Provider keys are never sent to the client
// anymore — see src/api.js and supabase/functions/.

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
  currentMembership = null;
  currentInvites = [];
  orgRoster = [];
  adminLoads = [];
  adminRecentLoads = [];
  adminActivityFilter = 'all';
  renderLoadsList();
  renderInviteBanner(); // clear a previous user's invites off the screen
  // Don't leave the previous user's counts on screen for the next sign-in.
  els.usagePill.classList.add('hidden');
  els.usagePillLabel.textContent = '—';
  hideSettingsModal();
  hideOrgModal();
  // Back to capture *after* clearing currentMembership, so the next sign-in
  // starts from a mode the new user actually qualifies for.
  setAppMode('capture');
  updateAdminEntryPoints();
  showAuthModal();
  // No `logout` command anymore: Rust holds no credentials to clear, since the
  // Deepgram token is passed per-capture and never stored.
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
  els.usagePill.addEventListener('click', showSettingsModal);
  els.settingsCloseBtn.addEventListener('click', hideSettingsModal);
  els.passwordForm.addEventListener('submit', handlePasswordSubmit);
  els.logoutBtn.addEventListener('click', handleLogout);

  // Organization event listeners
  els.orgOpenBtn.addEventListener('click', showOrgModal);
  els.orgBackBtn.addEventListener('click', () => {
    hideOrgModal();
    showSettingsModal();
  });
  els.orgCreateForm.addEventListener('submit', handleOrgCreateSubmit);
  els.orgInvitesList.addEventListener('click', handleOrgModalClick);
  els.inviteBannerList.addEventListener('click', handleInviteBannerClick);
  els.orgLeaveBtn.addEventListener('click', handleOrgLeave);
  els.orgConsoleOpenBtn.addEventListener('click', () => setAppMode('admin', { persist: true }));
  els.orgModal.addEventListener('click', (e) => {
    if (e.target === els.orgModal) hideOrgModal();
  });

  // Admin console listeners
  els.adminModeBtn.addEventListener('click', () => setAppMode('admin', { persist: true }));
  els.adminCaptureBtn.addEventListener('click', () => setAppMode('capture', { persist: true }));
  els.adminRefreshBtn.addEventListener('click', refreshAdminConsole);
  for (const btn of document.querySelectorAll('[data-admin-section]')) {
    btn.addEventListener('click', () => setAdminSection(btn.dataset.adminSection));
  }
  els.adminCreateMemberForm.addEventListener('submit', handleAdminCreateMemberSubmit);
  els.adminCredentialsCopy.addEventListener('click', handleAdminCredentialsCopy);
  els.adminCredentialsDismiss.addEventListener('click', hideAdminCredentials);
  els.adminRoster.addEventListener('click', handleAdminRosterClick);
  els.adminRoster.addEventListener('change', handleAdminRoleChange);
  els.adminActivityFilter.addEventListener('change', (e) => {
    adminActivityFilter = e.target.value;
    renderAdminActivity(aggregateDispatcherStats(adminLoads, orgRoster));
  });
  els.adminOrgNameForm.addEventListener('submit', handleAdminOrgNameSubmit);
  els.adminLeaveBtn.addEventListener('click', handleAdminLeave);
  // The console has its own frameless-window controls (its topbar replaces the
  // capture header, which is where the originals live).
  els.adminWinMinimize.addEventListener('click', minimizeMainWindow);
  els.adminWinMaximize.addEventListener('click', toggleMaximizeMainWindow);
  els.adminWinClose.addEventListener('click', closeMainWindow);

  // Floating widget: show/hide the always-on-top capture remote.
  if (els.widgetBtn) {
    els.widgetBtn.addEventListener('click', toggleWidgetWindow);
  }

  // Tutorial replay (manual trigger)
  if (els.helpBtn) {
    els.helpBtn.addEventListener('click', startTutorial);
  }

  // Custom frameless window controls
  if (els.winMinimize) els.winMinimize.addEventListener('click', minimizeMainWindow);
  if (els.winMaximize) els.winMaximize.addEventListener('click', toggleMaximizeMainWindow);
  if (els.winClose) els.winClose.addEventListener('click', closeMainWindow);
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
    window.__TAURI__.event.listen('capture:state', (event) => {
      onCaptureState(event.payload);
    });
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