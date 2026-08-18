/**
 * LoadForm — first-run walkthrough
 *
 * Shown once, automatically, the first time a signed-in user lands on the
 * capture screen. There is no button for it in the shipped UI: the header
 * entry is kept in dev builds only (see main.js) so we can replay it.
 *
 * Self-paced rather than timed. The previous version auto-advanced through
 * six phases on a fixed timeline, which meant the reader either raced the
 * clock or sat waiting, and it described a product we don't have: a
 * Ctrl+Shift+Q global shortcut (nothing registers one) and a bar living at
 * the edge of the screen (the widget is a draggable window with orbiting
 * field chips). Every step below points at something the app actually does,
 * using the labels it actually shows.
 *
 * Seen-state is per user id, so a shared dispatch-office machine walks each
 * dispatcher through it once rather than once per computer.
 */

const SEEN_KEY_PREFIX = 'lf.tutorial-seen.v2.';

/**
 * Long enough for the capture screen to paint behind the overlay — and for
 * the auth modal to be dismissed on the sign-in path, where the mode switch
 * happens a line before it closes.
 */
const OPEN_DELAY_MS = 450;

let activeOverlay = null;
let keyHandler = null;
let openTimer = null;
let steps = [];
let stepIndex = 0;
let seenUserId = null;

// ─── Step visuals ───────────────────────────────────────────────────────────
//
// Small mock-ups built from the same tokens as the real surfaces, so a step
// reads as "that thing over there" rather than as decoration. They are
// deliberately not screenshots: screenshots go stale silently.

function orbVisual() {
  return `
    <div class="lf-tut-orb">
      <span class="lf-tut-orb-ring"></span>
      <span class="lf-tut-orb-core">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect x="9" y="2" width="6" height="13" rx="3" />
        </svg>
      </span>
    </div>`;
}

function fieldCardsVisual() {
  const card = (label, value, conf, cls) => `
    <div class="lf-tut-card">
      <p class="lf-tut-card-label">${label}</p>
      <p class="lf-tut-card-value">${value}</p>
      <span class="lf-tut-card-conf ${cls}">${conf}</span>
    </div>`;
  return `
    <div class="lf-tut-cards">
      ${card('Pickup', 'Dallas, TX', '96%', 'is-high')}
      ${card('Delivery', 'Memphis, TN', '91%', 'is-high')}
      ${card('Rate', '$2,450', '88%', 'is-high')}
      ${card('Weight', '42,000 lbs', '54%', 'is-low')}
    </div>`;
}

function driverMessageVisual() {
  return `
    <div class="lf-tut-msg">
      <div class="lf-tut-msg-head">
        <span>Driver-ready message</span>
        <span class="lf-tut-msg-copy">Copy</span>
      </div>
      <pre class="lf-tut-msg-body">PU: Dallas, TX — Tue 8:00-12:00
DEL: Memphis, TN — Wed 14:00
Rate: $2,450 · 53' Dry Van · 42,000 lbs</pre>
    </div>`;
}

function outcomeVisual() {
  return `
    <div class="lf-tut-outcome">
      <p class="lf-tut-outcome-q">How did this one go?</p>
      <span class="lf-tut-outcome-btn is-primary">Booked it</span>
      <span class="lf-tut-outcome-btn">Didn't get it</span>
      <span class="lf-tut-outcome-btn">Not yet — still working it</span>
    </div>`;
}

function historyVisual() {
  const row = (lane, badge, cls) => `
    <div class="lf-tut-row">
      <span class="lf-tut-row-lane">${lane}</span>
      <span class="lf-tut-row-badge ${cls}">${badge}</span>
    </div>`;
  return `
    <div class="lf-tut-rows">
      ${row('Dallas, TX → Memphis, TN', 'Booked', 'is-booked')}
      ${row('Laredo, TX → Atlanta, GA', 'Working', 'is-open')}
      ${row('Fresno, CA → Denver, CO', 'Lost', 'is-lost')}
    </div>`;
}

function scorecardVisual() {
  const check = (label, pct, cls) => `
    <div class="lf-tut-check">
      <span class="lf-tut-check-label">${label}</span>
      <span class="lf-tut-check-bar"><span class="lf-tut-check-fill ${cls}" style="width:${pct}%"></span></span>
      <span class="lf-tut-check-pct">${pct}%</span>
    </div>`;
  return `
    <div class="lf-tut-checks">
      ${check('Asked for the rate', 92, 'is-good')}
      ${check('Confirmed the equipment', 78, 'is-good')}
      ${check('Named the appointment window', 41, 'is-weak')}
    </div>`;
}

function consoleVisual() {
  const tile = (value, label) => `
    <div class="lf-tut-tile">
      <p class="lf-tut-tile-value">${value}</p>
      <p class="lf-tut-tile-label">${label}</p>
    </div>`;
  return `
    <div class="lf-tut-tiles">
      ${tile('34', 'Calls this week')}
      ${tile('41%', 'Booked')}
      ${tile('6', 'Dispatchers')}
    </div>`;
}

function widgetVisual() {
  const chips = [
    { label: 'Pickup', x: -104, y: -30 },
    { label: 'Rate', x: 104, y: -30 },
    { label: 'Equipment', x: -96, y: 44 },
    { label: 'Delivery', x: 100, y: 44 },
  ];
  // The chip sits in a positioned slot rather than carrying the offset
  // itself: its entrance animation keyframes `transform`, and would drop any
  // translate written on the same element.
  return `
    <div class="lf-tut-widget">
      ${chips
        .map(
          (c, i) =>
            `<span class="lf-tut-slot" style="left:calc(50% + ${c.x}px);top:calc(50% + ${c.y}px)">
               <span class="lf-tut-planet" style="animation-delay:${i * 0.1}s">${c.label}</span>
             </span>`
        )
        .join('')}
      <div class="lf-tut-sun">
        <span class="lf-tut-sun-dot"></span>
        <span class="lf-tut-sun-wave"></span>
        <span class="lf-tut-sun-wave"></span>
        <span class="lf-tut-sun-wave"></span>
      </div>
    </div>`;
}

// ─── Steps ──────────────────────────────────────────────────────────────────

function buildSteps({ includeAdmin = false } = {}) {
  const list = [
    {
      title: 'This is LoadForm.',
      sub: 'Read a broker’s offer out loud and walk away with a driver-ready dispatch — captured, filled in and saved before the call ends.',
      visual: orbVisual(),
    },
    {
      title: 'Start with the orb.',
      sub: 'Tap it and LoadForm starts listening, then read the offer back as the broker gives it to you.',
      points: [
        '<b>Audio source &amp; options</b> under the orb picks what it hears.',
        'Your microphone, the system audio from your softphone, or both mixed together.',
      ],
      visual: orbVisual(),
    },
    {
      title: 'The form fills while they talk.',
      sub: 'Auto-fill is on by default and re-reads the conversation on every pause, so pickup, delivery, rate and equipment land as they are said.',
      points: [
        'Each card carries the model’s confidence; a shaky one is flagged for a second look.',
        'Every card is an input — correct anything that came out wrong and the message updates.',
      ],
      visual: fieldCardsVisual(),
    },
    {
      title: 'A message your driver can read.',
      sub: 'The captured load is rendered as plain dispatch text. <b>Copy</b> puts it on the clipboard, ready to paste wherever your drivers actually read.',
      visual: driverMessageVisual(),
    },
    {
      title: 'Finishing asks how it went.',
      sub: 'The load is written to your history as you capture, so <b>Finish &amp; start next load</b> only asks the one thing the transcript can’t tell us — whether you got it.',
      points: ['Picked the wrong one? Change the outcome later from Load History.'],
      visual: outcomeVisual(),
    },
    {
      title: 'Every load you captured, kept.',
      sub: '<b>History</b> in the header lists what you’ve booked, lost and are still working. Open one to re-read the dispatch or hand it to a driver again.',
      visual: historyVisual(),
    },
    {
      title: 'How you’re running calls.',
      sub: '<b>My stats</b> scores your own calls from your own transcripts: which steps you covered, with the quote that earned each mark, your outcome split and why loads were lost.',
      points: ['It measures what was covered on the call, never how you sounded.'],
      visual: scorecardVisual(),
    },
  ];

  if (includeAdmin) {
    list.push({
      title: 'The owner console.',
      sub: 'As an owner or admin you get the same reading across the team — who is booking, which steps get skipped, the lanes you run and recent activity — plus seats, invites and demo mode.',
      visual: consoleVisual(),
    });
  }

  list.push({
    title: 'Capture without the window.',
    sub: '<b>Floating widget</b> in the header opens a small always-on-top remote: the orb, the live transcript, and a chip for every field as it fills, orbiting the remote.',
    points: [
      'Drag the remote and the chips follow it.',
      'Made for capturing while your TMS or softphone has the screen.',
    ],
    visual: widgetVisual(),
  });

  return list;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderStep() {
  if (!activeOverlay) return;
  const stage = activeOverlay.querySelector('#lf-tut-stage');
  const step = steps[stepIndex];
  if (!stage || !step) return;

  const last = stepIndex === steps.length - 1;
  const points = step.points
    ? `<ul class="lf-tut-points">${step.points.map((p) => `<li>${p}</li>`).join('')}</ul>`
    : '';

  stage.innerHTML = `
    <div class="lf-tut-step" data-step="${stepIndex}">
      <div class="lf-tut-visual">${step.visual || ''}</div>
      <h2 class="lf-tutorial-title">${step.title}</h2>
      <p class="lf-tutorial-sub">${step.sub}</p>
      ${points}
    </div>
    <div class="lf-tut-nav">
      <button type="button" class="lf-tut-btn" id="lf-tut-back" ${stepIndex === 0 ? 'disabled' : ''}>Back</button>
      <div class="lf-tut-dots" role="presentation">
        ${steps.map((_, i) => `<span class="lf-tut-dot${i === stepIndex ? ' is-active' : ''}"></span>`).join('')}
      </div>
      <button type="button" class="lf-tut-btn is-primary" id="lf-tut-next">
        ${last ? 'Start dispatching' : 'Next'}
      </button>
    </div>`;

  stage.querySelector('#lf-tut-back').addEventListener('click', () => goTo(stepIndex - 1));
  stage.querySelector('#lf-tut-next').addEventListener('click', () => {
    if (last) closeTutorial();
    else goTo(stepIndex + 1);
  });
}

function goTo(index) {
  if (index < 0 || index >= steps.length) return;
  stepIndex = index;
  renderStep();
}

// ─── Overlay controller ─────────────────────────────────────────────────────

export function startTutorial(options = {}) {
  if (activeOverlay) closeTutorial();

  steps = buildSteps(options);
  stepIndex = 0;
  seenUserId = options.userId || null;

  activeOverlay = document.createElement('div');
  activeOverlay.className = 'lf-tutorial';
  activeOverlay.id = 'lf-tut-overlay';
  activeOverlay.innerHTML = `
    <div class="lf-tutorial-dim is-visible" id="lf-tut-dim"></div>
    <button type="button" class="lf-tutorial-skip" id="lf-tut-skip">Skip</button>
    <div class="lf-tutorial-stage" id="lf-tut-stage"></div>`;
  document.body.appendChild(activeOverlay);
  activeOverlay.querySelector('#lf-tut-skip').addEventListener('click', closeTutorial);

  // Esc closes; the arrow keys and Enter page through it without the mouse,
  // which is how someone re-reading a step will reach for it.
  keyHandler = (e) => {
    if (e.key === 'Escape') closeTutorial();
    else if (e.key === 'ArrowRight') goTo(stepIndex + 1);
    else if (e.key === 'ArrowLeft') goTo(stepIndex - 1);
    else if (e.key === 'Enter') {
      if (stepIndex === steps.length - 1) closeTutorial();
      else goTo(stepIndex + 1);
    } else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', keyHandler);

  document.body.style.overflow = 'hidden';
  renderStep();
}

export function closeTutorial() {
  if (openTimer) {
    clearTimeout(openTimer);
    openTimer = null;
  }
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
  document.body.style.overflow = '';
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
  // Dismissed counts as seen however it was dismissed — someone who skips it
  // has told us they don't want it, and re-showing it next launch is nagging.
  if (seenUserId) {
    markTutorialSeen(seenUserId);
    seenUserId = null;
  }
}

export function isTutorialActive() {
  return activeOverlay !== null;
}

// ─── First-run state ────────────────────────────────────────────────────────

function seenKey(userId) {
  return `${SEEN_KEY_PREFIX}${userId}`;
}

export function hasSeenTutorial(userId) {
  try {
    return localStorage.getItem(seenKey(userId)) === '1';
  } catch {
    // Storage disabled: treat it as seen rather than opening this on every
    // single sign-in.
    return true;
  }
}

export function markTutorialSeen(userId) {
  try {
    localStorage.setItem(seenKey(userId), '1');
  } catch {
    // Nothing to do — it will show once more next time, which is survivable.
  }
}

/**
 * Open the walkthrough the first time this user reaches the capture screen.
 * Safe to call on every mode switch: it no-ops once seen, once open, and
 * while another open is already pending.
 */
export function showTutorialIfUnseen(userId, options = {}) {
  if (!userId || activeOverlay || openTimer) return;
  if (hasSeenTutorial(userId)) return;
  openTimer = setTimeout(() => {
    openTimer = null;
    startTutorial({ ...options, userId });
  }, OPEN_DELAY_MS);
}
