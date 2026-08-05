'use strict';

/**
 * Shared front-end plumbing for both pages: DOM helpers, persisted preferences,
 * the night-mode toggle and the accessibility panel.
 *
 * Loaded before each page's own script. Everything lives on `window` because
 * this is two small pages served from disk, not a bundled app — a module
 * system here would be more ceremony than it saves.
 */

const HEBREW = {
  experience: { intern:'סטודנט / התמחות', entry:'ג׳וניור', mid:'ביניים', senior:'סניור' },
  employment: { 'full-time':'משרה מלאה', 'part-time':'משרה חלקית', contract:'קבלן / פרילנס',
                temporary:'זמני', internship:'התמחות' },
  status: { saved:'שמור', applied:'הוגש', interviewing:'בראיונות', offer:'הצעה', rejected:'נדחה' },
};

const ICONS = {
  moon:'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};

const $ = (id) => document.getElementById(id);

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
};

/** localStorage that can't throw — Safari private mode blocks it outright. */
const store = {
  get(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

/** Announce something to screen readers via the page's live region. */
const announce = (message) => { const n = $('results-note'); if (n) n.textContent = message; };

/* ---------------------------------- theme ---------------------------------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  const toggle = $('theme-toggle');
  if (!toggle) return;
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.setAttribute('aria-label', dark ? 'עבור למצב יום' : 'עבור למצב לילה');
  $('theme-label').textContent = dark ? 'מצב יום' : 'מצב לילה';
  $('theme-icon').innerHTML = dark ? ICONS.sun : ICONS.moon;
}

/* ---------------------------- accessibility panel --------------------------- */
const A11Y_KEYS = ['font', 'contrast', 'readable', 'links', 'motion'];

function syncA11yButtons() {
  const root = document.documentElement.dataset;
  for (const button of document.querySelectorAll('[data-set="font"]')) {
    button.setAttribute('aria-pressed', String((root.font || 'normal') === button.dataset.value));
  }
  for (const button of document.querySelectorAll('[data-toggle]')) {
    button.setAttribute('aria-pressed', String(root[button.dataset.toggle] === button.dataset.on));
  }
}

function applyA11y(key, value) {
  if (value) {
    document.documentElement.dataset[key] = value;
    store.set('jt-a11y-' + key, value);
  } else {
    delete document.documentElement.dataset[key];
    store.remove('jt-a11y-' + key);
  }
  syncA11yButtons();
}

function openA11yPanel(open) {
  const panel = $('a11y-panel');
  panel.hidden = !open;
  $('a11y-fab').setAttribute('aria-expanded', String(open));
  if (open) panel.querySelector('.a11y-opt').focus();
  else $('a11y-fab').focus();
}

function initUI() {
  // Theme: an explicit choice wins; otherwise follow the operating system.
  const system = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(store.get('jt-theme') || system);

  for (const key of A11Y_KEYS) {
    const saved = store.get('jt-a11y-' + key);
    if (saved) document.documentElement.dataset[key] = saved;
  }
  syncA11yButtons();

  $('theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.set('jt-theme', next);
  });

  $('a11y-fab')?.addEventListener('click', () => openA11yPanel($('a11y-panel').hidden));

  $('a11y-panel')?.addEventListener('click', (event) => {
    const button = event.target.closest('.a11y-opt');
    if (!button) return;

    if (button.dataset.set === 'font') {
      applyA11y('font', button.dataset.value === 'normal' ? null : button.dataset.value);
    } else if (button.dataset.toggle) {
      const key = button.dataset.toggle;
      const active = document.documentElement.dataset[key] === button.dataset.on;
      applyA11y(key, active ? null : button.dataset.on);
    }
  });

  $('a11y-reset')?.addEventListener('click', () => {
    for (const key of A11Y_KEYS) applyA11y(key, null);
    announce('הגדרות הנגישות אופסו.');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('a11y-panel')?.hidden) openA11yPanel(false);
  });

  document.addEventListener('click', (event) => {
    const panel = $('a11y-panel');
    if (!panel || panel.hidden) return;
    if (!panel.contains(event.target) && !$('a11y-fab').contains(event.target)) {
      panel.hidden = true;
      $('a11y-fab').setAttribute('aria-expanded', 'false');
    }
  });
}

/* ------------------------------- shared bits -------------------------------- */

/** A status <select> with the shared vocabulary, in Hebrew. */
function statusSelect(id, current, vocabulary) {
  const select = el('select', { id });
  select.append(el('option', { value: '', textContent: '— לא טופל —' }));
  for (const status of vocabulary || []) {
    select.append(el('option', { value: status, textContent: HEBREW.status[status] || status }));
  }
  select.value = current || '';
  return select;
}

/**
 * GET some JSON, or throw something we can explain.
 *
 * The failure this exists for: opening the page by double-clicking the file
 * gives it a file:// address, where the stylesheet, the scripts and every API
 * call all resolve against the filesystem root and quietly 404. The page then
 * sits on "טוען…" forever with no clue why. A dead end that says nothing is
 * worse than an error.
 */
async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('UNREACHABLE');
  }
  if (!response.ok) throw new Error('HTTP ' + response.status);
  try {
    return await response.json();
  } catch {
    throw new Error('UNREACHABLE');
  }
}

/** Explain a dead API rather than spinning forever. */
function serverDownPanel() {
  const viaFile = location.protocol === 'file:';
  const box = el('div', { className: 'empty' });

  box.append(el('p', { textContent: viaFile
    ? 'הדף נפתח כקובץ מקומי, ולכן אין לו שרת לדבר איתו.'
    : 'הדף לא מצליח להגיע לשרת.' }));

  const steps = el('ol');
  steps.append(el('li', {}, 'הריצי ', el('code', { textContent: 'node src/server.js' })));
  steps.append(el('li', {}, 'פתחי בדפדפן ', el('code', { textContent: 'http://localhost:3000' })));
  if (viaFile) steps.append(el('li', { textContent: 'אל תפתחי את קובץ ה-HTML בדאבל־קליק — הוא חייב לעבור דרך השרת.' }));
  box.append(steps);

  return box;
}

/** POST a partial application update. Omitted keys are left untouched server-side. */
async function saveApplication(patch) {
  const response = await fetch('/api/application', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'save failed');
  return (await response.json()).application;
}
