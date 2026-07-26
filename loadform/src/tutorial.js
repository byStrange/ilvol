/**
 * LoadForm — Onboarding tutorial (manual trigger)
 *
 * Ported from the dispatcher-assistant reference design. Shown on demand
 * from the Help button in the header. Phases:
 *
 *   dim       → backdrop fades in
 *   greeting  → "Good to see you."
 *   intro     → "This is LoadForm." + tagline
 *   shortcut  → Ctrl + Shift + Q keycaps
 *   edge      → "It lives at the edge of your screen."
 *   controls  → coach marks + CTA
 *
 * The overlay is a single fixed root that fills the viewport. #lf-tut-stage
 * is the flex container itself (no nested stage divs), so content always
 * centers correctly. No storage flag — manual trigger only.
 */

const TIMELINE = [
  { phase: 'greeting', at: 500 },
  { phase: 'intro', at: 2500 },
  { phase: 'shortcut', at: 5400 },
  { phase: 'edge', at: 9200 },
  { phase: 'controls', at: 11800 },
];

let activeOverlay = null;
let escHandler = null;
let timers = [];

function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
}

// ─── Phase renderers (return inner content for #lf-tut-stage) ───────────────

function renderGreeting() {
  return `<p class="lf-tutorial-title lg lf-coach">Good to see you.</p>`;
}

function renderIntro() {
  return `
    <h2 class="lf-tutorial-title lg lf-coach">This is LoadForm.</h2>
    <p class="lf-tutorial-sub">Turn a spoken load offer into a clean, driver-ready message — hands-free.</p>`;
}

function renderShortcut() {
  return `
    <div class="lf-keycaps lf-coach">
      <kbd class="lf-keycap">Ctrl</kbd>
      <span class="lf-keycap-plus">+</span>
      <kbd class="lf-keycap" style="animation-delay:0.1s">Shift</kbd>
      <span class="lf-keycap-plus">+</span>
      <kbd class="lf-keycap" style="animation-delay:0.2s">Q</kbd>
    </div>
    <p class="lf-tutorial-sub" style="animation-delay:0.4s">Toggle the mic from anywhere.</p>
    <p class="lf-tutorial-sub sm" style="animation-delay:0.7s">One shortcut starts a load offer — even while you're in another app.</p>`;
}

function renderEdge() {
  return `
    <div class="lf-coach" style="display:flex;align-items:center;color:var(--lf-primary);">
      <span style="height:2px;width:6rem;background:linear-gradient(to right, transparent, var(--lf-primary));"></span>
      <svg class="lf-arrow-fly" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
    </div>
    <p class="lf-tutorial-sub" style="margin-top:2.5rem;animation-delay:0.3s;color:var(--lf-foreground);">It lives at the edge of your screen.</p>
    <p class="lf-tutorial-sub sm" style="animation-delay:0.6s">Always a shortcut away — never in your way.</p>`;
}

function coachMark(title, desc, delay) {
  return `
    <div class="lf-coach-mark" style="animation-delay:${delay}">
      <div class="lf-coach-card">
        <p class="lf-coach-card-title">${title}</p>
        <p class="lf-coach-card-desc">${desc}</p>
      </div>
      <svg class="lf-coach-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
    </div>`;
}

function renderControls() {
  // Vertical flex: coach row, then heading, then CTA — all centered.
  return `
    <div class="lf-coach-row-static">
      ${coachMark('Listen', 'Tap the orb to start', '0.05s')}
      ${coachMark('History', 'Open saved loads', '0.2s')}
      ${coachMark('Send', 'Copy to your driver', '0.35s')}
    </div>
    <h3 class="lf-tutorial-title lf-coach" style="margin-top:2.5rem;animation-delay:0.45s">Three steps. That's the whole app.</h3>
    <button type="button" id="lf-tut-done" class="lf-tutorial-cta">Start dispatching</button>`;
}

// ─── Overlay controller ──────────────────────────────────────────────────────

function setPhase(phase) {
  if (!activeOverlay) return;
  const stage = activeOverlay.querySelector('#lf-tut-stage');
  if (!stage) return;

  // Skip button visibility (hidden during dim and controls phases)
  const skip = activeOverlay.querySelector('#lf-tut-skip');
  if (skip) skip.style.display = phase === 'dim' || phase === 'controls' ? 'none' : '';

  // Dim visibility
  const dim = activeOverlay.querySelector('#lf-tut-dim');
  if (dim) dim.classList.toggle('is-visible', phase !== 'dim');

  // Stage content per phase
  switch (phase) {
    case 'dim':
      stage.innerHTML = '';
      break;
    case 'greeting':
      stage.innerHTML = renderGreeting();
      break;
    case 'intro':
      stage.innerHTML = renderIntro();
      break;
    case 'shortcut':
      stage.innerHTML = renderShortcut();
      break;
    case 'edge':
      stage.innerHTML = renderEdge();
      break;
    case 'controls':
      stage.innerHTML = renderControls();
      const done = stage.querySelector('#lf-tut-done');
      if (done) done.addEventListener('click', closeTutorial);
      break;
  }
}

export function startTutorial() {
  if (activeOverlay) {
    closeTutorial();
  }

  // Inject the arrow-fly keyframes once
  if (!document.getElementById('lf-tut-keyframes')) {
    const style = document.createElement('style');
    style.id = 'lf-tut-keyframes';
    style.textContent = `@keyframes lf-arrow-fly {
  0% { opacity: 0; transform: translateX(-8vw) scale(0.9); }
  15% { opacity: 1; }
  85% { opacity: 1; }
  100% { opacity: 0; transform: translateX(42vw) scale(1); }
}`;
    document.head.appendChild(style);
  }

  activeOverlay = document.createElement('div');
  activeOverlay.className = 'lf-tutorial';
  activeOverlay.id = 'lf-tut-overlay';
  activeOverlay.innerHTML = `
    <div class="lf-tutorial-dim" id="lf-tut-dim"></div>
    <button type="button" class="lf-tutorial-skip" id="lf-tut-skip">Skip tutorial</button>
    <div class="lf-tutorial-stage" id="lf-tut-stage"></div>
  `;
  document.body.appendChild(activeOverlay);

  // Skip button
  activeOverlay.querySelector('#lf-tut-skip').addEventListener('click', closeTutorial);

  // Esc to close
  escHandler = (e) => {
    if (e.key === 'Escape') closeTutorial();
  };
  document.addEventListener('keydown', escHandler);

  // Lock body scroll while the tutorial is open
  document.body.style.overflow = 'hidden';

  // Auto-advance through the timeline
  clearTimers();
  setPhase('dim');
  TIMELINE.forEach(({ phase, at }) => {
    timers.push(setTimeout(() => setPhase(phase), at));
  });
}

export function closeTutorial() {
  clearTimers();
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
  document.body.style.overflow = '';
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
}

export function isTutorialActive() {
  return activeOverlay !== null;
}