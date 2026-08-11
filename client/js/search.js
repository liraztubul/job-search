'use strict';

/** Search page: filter the collected jobs and set an application status. */

let meta = { statusVocabulary: [], total: 0 };
let currentPage = 1;

function fillSelect(select, items, labels) {
  const previous = select.value;
  const fixed = [...select.options].filter((o) => o.value === '' || o.value === 'none');
  select.replaceChildren(...fixed);
  for (const item of items) {
    const value = String(item.value ?? item.id);
    const text = labels?.[value] ?? item.name ?? value;
    select.append(el('option', { value, textContent: `${text} (${item.count})` }));
  }
  select.value = previous;
}

// ------------------------------ company combobox -----------------------------
// A real listbox instead of a plain <select> — with 15+ companies, a native
// dropdown is a scroll-and-hunt exercise (poor "recognition rather than
// recall"). This one opens to the full list on click, like a normal picker,
// and narrows it live as you type — both, not one or the other.
let companies = []; // [{id, name, count}]
let selectedCompanyId = '';
let activeOptionIndex = -1;

const companyLabel = (c) => `${c.name} (${c.count})`;
const companyOptions = () => [...$('f-company-listbox').querySelectorAll('[role=option]')];

function matchingCompanies(query) {
  // Prefix match, not substring — typing "e" means "starts with e" (Elbit,
  // Eightfold-ish names), not "contains an e anywhere" (which would keep half
  // the list on screen and defeat the point of narrowing it down). toLowerCase()
  // on both sides makes this caps-lock-proof: "E" and "e" compare equal either way.
  const q = query.trim().toLowerCase();
  return q ? companies.filter((c) => c.name.toLowerCase().startsWith(q)) : companies;
}

function renderCompanyOptions(query) {
  const listbox = $('f-company-listbox');
  listbox.replaceChildren();
  activeOptionIndex = -1;

  const allOption = el('li', { className: 'combobox-option', textContent: 'כל החברות' });
  allOption.id = 'f-company-option-all';
  allOption.setAttribute('role', 'option');
  allOption.setAttribute('aria-selected', String(selectedCompanyId === ''));
  allOption.dataset.id = '';
  listbox.append(allOption);

  const items = matchingCompanies(query);
  if (query.trim() && items.length === 0) {
    listbox.append(el('li', { className: 'combobox-empty', textContent: 'לא נמצאה חברה תואמת' }));
  }
  for (const c of items) {
    const opt = el('li', { className: 'combobox-option', textContent: companyLabel(c) });
    opt.id = `f-company-option-${c.id}`;
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', String(String(c.id) === selectedCompanyId));
    opt.dataset.id = String(c.id);
    listbox.append(opt);
  }
}

function openCompanyListbox() {
  renderCompanyOptions($('f-company').value);
  $('f-company-listbox').hidden = false;
  $('f-company').setAttribute('aria-expanded', 'true');
}

function closeCompanyListbox() {
  $('f-company-listbox').hidden = true;
  $('f-company').setAttribute('aria-expanded', 'false');
  $('f-company').removeAttribute('aria-activedescendant');
  activeOptionIndex = -1;
}

function isCompanyListboxOpen() {
  return !$('f-company-listbox').hidden;
}

function setActiveCompanyOption(index) {
  const options = companyOptions();
  for (const o of options) o.classList.remove('active');
  if (index < 0 || index >= options.length) {
    activeOptionIndex = -1;
    $('f-company').removeAttribute('aria-activedescendant');
    return;
  }
  activeOptionIndex = index;
  options[index].classList.add('active');
  options[index].scrollIntoView({ block: 'nearest' });
  $('f-company').setAttribute('aria-activedescendant', options[index].id);
}

function selectCompany(id, label) {
  selectedCompanyId = id || '';
  $('f-company').value = id ? label : '';
  closeCompanyListbox();
  currentPage = 1;
  load();
}

function initCompanyCombobox() {
  const input = $('f-company');
  const listbox = $('f-company-listbox');

  input.addEventListener('focus', openCompanyListbox);
  input.addEventListener('input', () => {
    // Typing invalidates whatever was picked before, until they choose again —
    // a half-typed name is not a company id the API can filter on.
    selectedCompanyId = '';
    renderCompanyOptions(input.value);
    if (!isCompanyListboxOpen()) openCompanyListbox();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!isCompanyListboxOpen()) return openCompanyListbox();
      setActiveCompanyOption(Math.min(activeOptionIndex + 1, companyOptions().length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (isCompanyListboxOpen()) setActiveCompanyOption(Math.max(activeOptionIndex - 1, 0));
    } else if (event.key === 'Enter') {
      if (isCompanyListboxOpen() && activeOptionIndex >= 0) {
        event.preventDefault();
        const opt = companyOptions()[activeOptionIndex];
        selectCompany(opt.dataset.id, opt.textContent);
      }
    } else if (event.key === 'Escape') {
      if (isCompanyListboxOpen()) { event.preventDefault(); closeCompanyListbox(); }
    }
  });

  listbox.addEventListener('click', (event) => {
    const opt = event.target.closest('[role=option]');
    if (!opt) return;
    selectCompany(opt.dataset.id, opt.dataset.id ? opt.textContent : '');
  });

  document.addEventListener('click', (event) => {
    if (isCompanyListboxOpen() && !$('f-company-combobox').contains(event.target)) closeCompanyListbox();
  });
}

// ------------------------------ location multiselect -------------------------
// Checkboxes in a disclosure, not a <select multiple> — picking more than one
// option in a native multi-select needs a ctrl/cmd-click almost nobody knows
// about, and it still can't show a "(424)" count next to an option on its own.
function fillLocationMultiselect(locations) {
  const panel = $('f-location-options');
  panel.replaceChildren();
  for (const loc of locations) {
    const label = HEBREW.location?.[loc.value] || loc.value;
    const checkbox = el('input', { type: 'checkbox', value: loc.value });
    checkbox.dataset.label = label;
    checkbox.addEventListener('change', () => {
      updateLocationSummary();
      resetPageAndLoad();
    });
    panel.append(el('label', { className: 'multiselect-option' }, checkbox, ` ${label} (${loc.count})`));
  }
}

const locationCheckboxes = () => [...$('f-location-options').querySelectorAll('input[type=checkbox]')];
const selectedLocations = () => locationCheckboxes().filter((c) => c.checked).map((c) => c.value);

function updateLocationSummary() {
  const checked = locationCheckboxes().filter((c) => c.checked);
  const summary = $('f-location-summary');
  if (checked.length === 0) summary.textContent = 'כל המיקומים';
  else if (checked.length === 1) summary.textContent = checked[0].dataset.label;
  else summary.textContent = `${checked.length} מיקומים נבחרו`;
}

function initLocationMultiselect() {
  const menu = $('f-location-menu');
  // <details> has no built-in "close on outside click / Escape".
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
  });
}

async function loadMeta() {
  meta = await fetchJson('/api/meta');
  companies = meta.companies;
  fillSelect($('f-experience'), meta.experienceLevels, HEBREW.experience);
  fillSelect($('f-employment'), meta.employmentTypes, HEBREW.employment);
  fillLocationMultiselect(meta.locations);
  fillSelect($('f-status'), meta.statuses, HEBREW.status);
}

// The whole filter state (including page) lives in this one query string, so
// it can round-trip both to the API and to the browser's own address bar —
// that's what makes a filtered, paged result bookmarkable and shareable.
function buildQuery() {
  const params = new URLSearchParams();
  const add = (key, value) => { if (value) params.set(key, value); };
  add('q', $('f-q').value.trim());
  add('company', selectedCompanyId);
  add('experience', $('f-experience').value);
  add('employment', $('f-employment').value);
  for (const value of selectedLocations()) params.append('location', value);
  add('status', $('f-status').value);
  if (currentPage > 1) params.set('page', String(currentPage));
  return params;
}

/** Keeps the address bar in sync without adding a history entry per filter tweak. */
function updateUrl() {
  const qs = buildQuery().toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

/** Everything the filters could be initialised from, read once at startup. */
function readFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  return {
    q: params.get('q') || '',
    company: params.get('company') || '',
    experience: params.get('experience') || '',
    employment: params.get('employment') || '',
    locations: params.getAll('location'),
    status: params.get('status') || '',
    page: Math.max(1, Math.trunc(Number(params.get('page'))) || 1),
  };
}

/** Applied once companies/experience/etc. are loaded — a <select> ignores a
 *  value set before its <option>s exist, and the company id needs the loaded
 *  company list to resolve to a label at all. */
function applyInitialFilters(initial) {
  $('f-q').value = initial.q;
  $('f-experience').value = initial.experience;
  $('f-employment').value = initial.employment;
  $('f-status').value = initial.status;
  currentPage = initial.page;

  if (initial.locations.length) {
    for (const checkbox of locationCheckboxes()) checkbox.checked = initial.locations.includes(checkbox.value);
    updateLocationSummary();
  }

  if (initial.company) {
    const match = companies.find((c) => String(c.id) === initial.company);
    if (match) {
      selectedCompanyId = String(match.id);
      $('f-company').value = companyLabel(match);
    }
  }
}

// A small pin, built once and cloned per card rather than re-parsed from a
// string every time — el()'s innerHTML only ever sees this fixed constant,
// never job data, so there's no injection risk in giving it raw markup.
const LOCATION_PIN = el('span', {
  className: 'tag-icon',
  innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
    + '<path d="M12 21s-7-6.7-7-11a7 7 0 0 1 14 0c0 4.3-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
});

function jobCard(job) {
  const titleId = `job-${job.id}-title`;
  const statusId = `job-${job.id}-status`;

  const link = el('a', {
    href: job.applyUrl, target: '_blank', rel: 'noopener noreferrer',
    className: 'ltr', textContent: job.title,
  });
  link.append(el('span', { className: 'visually-hidden', textContent: ' (נפתח בלשונית חדשה באתר החברה)' }));

  // Named jobMeta, not meta — a local `meta` would shadow the module-level
  // `meta` and quietly break the status dropdown below. The job number lived
  // here too once; it's dropped from the browsing view (nobody needs a
  // requisition id while skimming search results) and kept where it's
  // actually useful — the tracker table, once you're applying for real.
  const jobMeta = el('p', { className: 'job-meta' }, el('strong', { textContent: job.company }));

  const tags = el('ul', { className: 'tags' });
  const addTag = (cls, ...content) => tags.append(el('li', { className: cls }, ...content));
  // Location and experience are the two facts someone scans a results list
  // for first, so they lead the tag row with an accent that sets them apart
  // from the plainer employment/department detail tags after them.
  if (job.location) addTag('tag tag-highlight tag-location', LOCATION_PIN.cloneNode(true), job.location);
  if (job.experienceLevel) addTag('tag tag-highlight', HEBREW.experience[job.experienceLevel] || job.experienceLevel);
  if (job.employmentType) addTag('tag', HEBREW.employment[job.employmentType] || job.employmentType);
  if (job.department) addTag('tag', job.department);
  if (!job.isStillOpen) addTag('tag closed', 'נסגרה');

  const main = el('div', { className: 'job-main' },
    el('h3', { className: 'job-title', id: titleId }, link), jobMeta,
    tags.children.length ? tags : null);

  const select = statusSelect(statusId, job.status, meta.statusVocabulary);
  const badge = job.status
    ? el('span', { className: `status-badge status-${job.status}`, textContent: HEBREW.status[job.status] })
    : el('span', { className: 'visually-hidden' });

  select.addEventListener('change', async () => {
    try {
      await saveApplication({ jobId: job.id, status: select.value || null });
      badge.className = select.value ? `status-badge status-${select.value}` : 'visually-hidden';
      badge.textContent = select.value ? HEBREW.status[select.value] : '';
      announce(select.value
        ? `הסטטוס של "${job.title}" עודכן ל־${HEBREW.status[select.value]}.`
        : `הסטטוס של "${job.title}" נוקה.`);
      loadMeta();
    } catch (err) {
      announce('שמירת הסטטוס נכשלה: ' + err.message);
    }
  });

  const statusBox = el('div', { className: 'job-status' },
    el('label', { htmlFor: statusId, textContent: 'סטטוס הגשה' }), select, badge);

  const article = el('article', { className: `job${job.isStillOpen ? '' : ' is-closed'}` }, main, statusBox);
  article.setAttribute('aria-labelledby', titleId);
  return el('li', {}, article);
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Which page numbers to show: first, last, current and two neighbours either
 * side, with a "…" wherever that leaves a gap. A 107-page result set gets a
 * handful of buttons, not 107 of them.
 */
function paginationRange(current, total) {
  if (total <= 1) return [];
  const keep = new Set([1, total]);
  for (let p = current - 2; p <= current + 2; p++) {
    if (p >= 1 && p <= total) keep.add(p);
  }
  const sorted = [...keep].sort((a, b) => a - b);

  const result = [];
  let previous = 0;
  for (const p of sorted) {
    if (p - previous > 1) result.push('…');
    result.push(p);
    previous = p;
  }
  return result;
}

function formatRange(page, pageSize, jobsOnPage) {
  const start = (page - 1) * pageSize + 1;
  const end = start + jobsOnPage - 1;
  return `${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')}`;
}

async function goToPage(page) {
  currentPage = page;
  await load();
  // "the results heading" — #results doubles as that; it's already the skip
  // link's target and already has tabindex="-1" for exactly this purpose.
  const results = $('results');
  results.scrollIntoView({ block: 'start' });
  results.focus();
}

function renderPagination(page, totalPages) {
  const nav = $('pagination');
  nav.replaceChildren();
  if (totalPages <= 1) return;

  // RTL: page 2 sits visually to the LEFT of page 1, so "next" — the button
  // that moves you further into that direction — points left (‹) and
  // "previous" points right (›). Backwards from an LTR habit, correct here.
  const prev = el('button', { type: 'button', className: 'btn page-nav', disabled: page <= 1 });
  const prevArrow = el('span', { textContent: '›' });
  prevArrow.setAttribute('aria-hidden', 'true');
  prev.append(prevArrow, ' הקודם');
  prev.addEventListener('click', () => goToPage(page - 1));

  const next = el('button', { type: 'button', className: 'btn page-nav', disabled: page >= totalPages });
  const nextArrow = el('span', { textContent: '‹' });
  nextArrow.setAttribute('aria-hidden', 'true');
  next.append('הבא ', nextArrow);
  next.addEventListener('click', () => goToPage(page + 1));

  const numbers = el('div', { className: 'page-numbers' });
  for (const item of paginationRange(page, totalPages)) {
    if (item === '…') {
      const ellipsis = el('span', { className: 'page-ellipsis', textContent: '…' });
      ellipsis.setAttribute('aria-hidden', 'true');
      numbers.append(ellipsis);
      continue;
    }

    const isCurrent = item === page;
    const btn = el('button', {
      type: 'button',
      className: isCurrent ? 'page-number current' : 'page-number',
      textContent: String(item),
      disabled: isCurrent,
    });
    if (isCurrent) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.setAttribute('aria-label', `עמוד ${item}`);
      btn.addEventListener('click', () => goToPage(item));
    }
    numbers.append(btn);
  }

  nav.setAttribute('aria-label', 'ניווט בין עמודי תוצאות');
  nav.append(prev, numbers, next);
}

function emptyState(totalMatching, page) {
  // A page past the end of the real result set (typed into the URL, or a
  // bookmark from before the filter narrowed) is not "no matches" — the
  // filter matches plenty, just not on this page number. Telling someone to
  // remove filters when the actual fix is "go to page 1" sends them the
  // wrong way.
  if (totalMatching > 0 && page > 1) {
    const backToStart = el('button', { type: 'button', className: 'btn', textContent: 'לעמוד הראשון' });
    backToStart.addEventListener('click', () => goToPage(1));
    return el('div', { className: 'empty' },
      el('p', {
        textContent: `אין משרות בעמוד ${page.toLocaleString('en-US')} — ` +
          `יש ${totalMatching.toLocaleString('en-US')} משרות תואמות בסך הכל.`,
      }),
      backToStart);
  }

  if (meta.total) {
    return el('div', { className: 'empty' }, 'אין משרות שעונות על הסינון הנוכחי. נסי להסיר חלק מהמסננים.');
  }

  const steps = el('ol');
  for (const command of [
    'node tools/add-company.js --name "Mobileye" --type mobileye',
    'node tools/add-company.js --name "Amazon Israel" --type amazon --country ISR',
    'node server/main.js',
  ]) {
    steps.append(el('li', {}, el('code', { textContent: command })));
  }

  return el('div', { className: 'empty' },
    el('p', { textContent: 'המאגר ריק — עוד לא נאספו משרות.' }), steps);
}

async function load() {
  let jobs, page, pageSize, totalMatching, totalPages;
  try {
    ({ jobs, page, pageSize, totalMatching, totalPages } = await fetchJson('/api/jobs?' + buildQuery()));
  } catch {
    $('results-count').textContent = 'לא ניתן לטעון את המשרות';
    $('results').replaceChildren(serverDownPanel());
    $('pagination').replaceChildren();
    return;
  }

  // The server never substitutes a different page than the one asked for —
  // page=99999 against 8 real pages comes back as page 99999 with an empty
  // jobs array, not page 8's rows wearing page 99999's number. Adopt exactly
  // what it echoed back so the UI and the URL always agree with the request.
  currentPage = page;
  updateUrl();

  // Three numbers, never conflated: how many match the filter (totalMatching),
  // which of those are on screen (the range), how many exist in total (meta.total,
  // used only by emptyState() below to tell "no matches" from "no data at all").
  // A page with nothing on it (out of range) has no range to show — "מציג" of
  // zero rows is not a range, it's a symptom, and emptyState() explains it below.
  $('results-count').textContent =
    totalMatching === 0
      ? 'לא נמצאו משרות'
      : jobs.length === 0
        ? `${totalMatching.toLocaleString('en-US')} משרות תואמות`
        : `${totalMatching.toLocaleString('en-US')} משרות תואמות · מציג ${formatRange(page, pageSize, jobs.length)}`;
  announce('');

  if (jobs.length === 0) {
    $('results').replaceChildren(emptyState(totalMatching, page));
    $('pagination').replaceChildren();
    return;
  }

  const list = el('ul', { className: 'jobs' }, ...jobs.map(jobCard));
  list.setAttribute('aria-label', 'רשימת משרות');
  $('results').replaceChildren(list);

  renderPagination(page, totalPages);
}

// A changed filter is a new question, not a continuation of the last one —
// it always goes back to page 1. Landing on page 6 of a result set the
// filter just shrank to two pages reads as "no results", which is wrong.
function resetPageAndLoad() {
  currentPage = 1;
  load();
}

// Dropdowns filter instantly (the company combobox and location checkboxes do
// too, each wired at creation time above); free text waits for the search
// button or Enter, so results don't shift under you while you're still typing.
for (const id of ['f-experience', 'f-employment', 'f-status']) {
  $(id).addEventListener('change', resetPageAndLoad);
}
$('filters').addEventListener('submit', (event) => { event.preventDefault(); resetPageAndLoad(); });
$('reset').addEventListener('click', () => {
  $('f-q').value = '';
  for (const id of ['f-experience', 'f-employment', 'f-status']) $(id).value = '';
  for (const checkbox of locationCheckboxes()) checkbox.checked = false;
  updateLocationSummary();
  selectedCompanyId = '';
  $('f-company').value = '';
  resetPageAndLoad();
  announce('הסינון נוקה.');
});

initCompanyCombobox();
initLocationMultiselect();
initUI();
// If the meta call fails, load() renders the explanation panel — so the page
// never sits on "טוען…" without saying why. Filters (including page) come
// from the URL first, so a bookmarked/shared/refreshed link lands back where
// it was instead of resetting to an unfiltered page 1.
const initialFilters = readFiltersFromUrl();
loadMeta()
  .then(() => applyInitialFilters(initialFilters))
  .catch(() => {})
  .then(load);
