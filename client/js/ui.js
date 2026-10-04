'use strict';

/**
 * Shared front-end plumbing for both pages: DOM helpers, persisted preferences,
 * the night-mode toggle.
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
  // Mirrors the value set server/db/index.js's LOCATION_CANONICAL produces —
  // the filter is sent and matched by these English values, this is display only.
  location: {
    'Tel Aviv':'תל אביב', Haifa:'חיפה', Jerusalem:'ירושלים', 'Ramat Gan':'רמת גן',
    Netanya:'נתניה', Herzliya:'הרצליה', 'Beer Sheva':'באר שבע', 'Petah Tikva':'פתח תקווה',
    Yokneam:'יקנעם', Raanana:'רעננה', 'Tel Hai':'תל חי', "Modi'in":'מודיעין',
    "Migdal Ha'emek":'מגדל העמק', Karmiel:'כרמיאל', Nesher:'נשר', 'Tirat Carmel':'טירת כרמל',
    'Kiryat Ata':'קרית אתא', 'Kiryat Bialik':'קרית ביאליק', 'Kiryat Motzkin':'קרית מוצקין',
    Nahariya:'נהריה', Akko:'עכו', Afula:'עפולה', Caesarea:'קיסריה', "Zikhron Ya'akov":'זכרון יעקב',
    North:'צפון', South:'דרום', Center:'מרכז', Sharon:'השרון', Shfela:'השפלה',
    'Gush Dan':'גוש דן',
  },
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

/**
 * The account control in the top-left corner.
 *
 * One slot, three honest states — never a button that lies about what it does:
 *
 *   signed in        red "התנתקות"   — the only destructive control in the
 *                                      header, and the only red thing in the UI
 *   signed out       "התחברות"       — the HTML default, already in the page
 *   accounts off     nothing         — running locally as a single account;
 *                                      a logout button with no session to end
 *                                      would do nothing and say otherwise
 *
 * Red is doing real work here rather than decoration: it is reserved for the
 * one action that throws away state. Colour alone never carries meaning, so the
 * word "התנתקות" says the same thing for anyone who cannot distinguish it.
 *
 * Every state also gets a greeting ("Hello, <name>" / "Hello, Guest") in front
 * of the controls. It is added only once /api/session has answered (or failed),
 * never up front — a signed-in visitor must not see "Hello, Guest" flash first.
 */
async function initSessionNav() {
  const slot = $('account-slot');
  if (!slot) return;

  let session = null;
  try {
    session = await (await fetch('/api/session')).json();
  } catch {
    // Server down; the page already says so elsewhere. Greet as a guest rather
    // than leave a gap, and keep the default "התחברות" link.
  }

  const greeting = greetingElement(session);

  if (session && !session.authRequired) {
    slot.replaceChildren(greeting);
    return;
  }

  if (!session?.authenticated) {
    slot.prepend(greeting); // the default "התחברות" link is correct
    return;
  }

  const settings = el('a', { className: 'btn', href: 'settings.html', textContent: 'הגדרות' });

  const logout = el('button', {
    type: 'button',
    className: 'btn btn-danger',
    textContent: 'התנתקות',
  });

  logout.addEventListener('click', async () => {
    // Disabled immediately: a second click while the first is in flight logs
    // out twice and races the redirect.
    logout.disabled = true;
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    // replace(), not href: going "back" to a page rendered while signed in
    // would show stale personal data from the browser's cache.
    location.replace('index.html');
  });

  slot.replaceChildren(greeting, settings, logout);
}

/**
 * The name the header greets someone by: the part of their email before the
 * `@`. `users` has no name column, and the full address is never shown — the
 * header ends up in screenshots and screen-shares; the local part is enough.
 * Returns null when there is nothing usable, which the caller reads as "Guest".
 */
function greetingName(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  // lastIndexOf: whatever else the local part holds, the domain is always cut.
  const at = trimmed.lastIndexOf('@');
  const local = (at === -1 ? trimmed : trimmed.slice(0, at)).trim();
  return local || null;
}

/**
 * "Hello, Guest" unless there is a real, signed-in session. With accounts off
 * every request runs as account 1 (a placeholder, not a person), so that is a
 * guest too — not a made-up name.
 */
function greetingText(session) {
  const real = session?.authRequired && session.authenticated;
  return 'Hello, ' + ((real && greetingName(session.email)) || 'Guest');
}

/**
 * English on an RTL page, on purpose. dir="ltr" keeps "Hello, liraz.t41" in
 * that order, and <bdi> isolates the name so its own characters (dots, digits,
 * Hebrew) can't reorder the comma around it. textContent only — the name is
 * user-controlled.
 */
function greetingElement(session) {
  const name = greetingText(session).slice('Hello, '.length);
  return el('span', { className: 'greeting', dir: 'ltr' },
    'Hello, ', el('bdi', { textContent: name, title: name }));
}

function initUI() {
  // Theme: an explicit choice wins; otherwise follow the operating system.
  const system = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(store.get('jt-theme') || system);

  $('theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.set('jt-theme', next);
  });

  initSessionNav();
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
  // 401 only happens when the server has auth switched on and this browser has
  // no valid session. Nothing on the page is worth rendering in that state.
  if (response.status === 401) {
    location.replace('login.html');
    throw new Error('UNAUTHENTICATED');
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
  steps.append(el('li', {}, 'הריצי ', el('code', { textContent: 'node server/web/server.js' })));
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
