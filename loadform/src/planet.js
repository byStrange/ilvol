/**
 * LoadForm planet chip — the content rendered inside a single layer-shell
 * planet window. One of these runs per filled field. Data arrives via the
 * `planet:data` Tauri event, sent by the Rust backend when the planet window
 * is created or when re-extraction updates the value.
 */

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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function tauriListen(event, handler) {
  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.event) {
    return window.__TAURI__.event.listen(event, handler);
  }
  return Promise.resolve();
}

function tauriInvoke(cmd, args = {}) {
  if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.core) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  return Promise.reject(new Error('Tauri runtime not available.'));
}

window.addEventListener('DOMContentLoaded', async () => {
  const planet = document.getElementById('planet');
  const iconEl = document.getElementById('p-icon');
  const labelEl = document.getElementById('p-label');
  const valueEl = document.getElementById('p-value');

  function render(d) {
    if (!d) return;
    if (d.icon) {
      const path = FIELD_ICONS[d.icon] || FIELD_ICONS['map-pin'];
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    }
    if (d.label) labelEl.textContent = d.label;
    if (d.value !== undefined) valueEl.innerHTML = escapeHtml(d.value);
    planet.classList.toggle('is-confident', (d.confidence ?? 0) >= 0.8);
    planet.classList.toggle('is-demo', !!d.is_demo);
  }

  // Listen first, so an update that lands during the initial fetch isn't lost.
  await tauriListen('planet:data', (e) => render(e.payload));

  // Pull our own data. The backend stores it before this window is even
  // created, so this can't race — unlike an event pushed at creation time,
  // which would arrive before this listener existed.
  const key = new URLSearchParams(window.location.search).get('key');
  if (key) {
    try {
      render(await tauriInvoke('get_planet_data', { key }));
    } catch (err) {
      console.error('planet get_planet_data failed:', err);
    }
  }
});