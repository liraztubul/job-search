'use strict';

/** Search page: filter the collected jobs and set an application status. */

let meta = { statusVocabulary: [], total: 0 };

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

async function loadMeta() {
  meta = await fetchJson('/api/meta');
  companies = meta.companies;
  fillSelect($('f-experience'), meta.experienceLevels, HEBREW.experience);
  fillSelect($('f-employment'), meta.employmentTypes, HEBREW.employment);
  fillSelect($('f-location'), meta.locations, HEBREW.location);
  fillSelect($('f-status'), meta.statuses, HEBREW.status);
}

function buildQuery() {
  const params = new URLSearchParams();
  const add = (key, value) => { if (value) params.set(key, value); };
  add('q', $('f-q').value.trim());
  add('company', selectedCompanyId);
  add('experience', $('f-experience').value);
  add('employment', $('f-employment').value);
  add('location', $('f-location').value);
  add('status', $('f-status').value);
  return params;
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

function emptyState() {
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
  let jobs;
  try {
    ({ jobs } = await fetchJson('/api/jobs?' + buildQuery()));
  } catch {
    $('results-count').textContent = 'לא ניתן לטעון את המשרות';
    $('results').replaceChildren(serverDownPanel());
    return;
  }

  $('results-count').textContent =
    jobs.length === 0 ? 'לא נמצאו משרות' : `נמצאו ${jobs.length} משרות מתוך ${meta.total} במאגר`;
  announce('');

  if (jobs.length === 0) {
    $('results').replaceChildren(emptyState());
    return;
  }

  const list = el('ul', { className: 'jobs' }, ...jobs.map(jobCard));
  list.setAttribute('aria-label', 'רשימת משרות');
  $('results').replaceChildren(list);
}

// Dropdowns filter instantly (the company combobox does too — selectCompany()
// calls load() itself); free text waits for the search button or Enter, so
// results don't shift under you while you're still typing.
for (const id of ['f-experience', 'f-employment', 'f-location', 'f-status']) {
  $(id).addEventListener('change', load);
}
$('filters').addEventListener('submit', (event) => { event.preventDefault(); load(); });
$('reset').addEventListener('click', () => {
  $('f-q').value = '';
  for (const id of ['f-experience', 'f-employment', 'f-location', 'f-status']) $(id).value = '';
  selectedCompanyId = '';
  $('f-company').value = '';
  load();
  announce('הסינון נוקה.');
});

initCompanyCombobox();
initUI();
// If the meta call fails, load() renders the explanation panel — so the page
// never sits on "טוען…" without saying why.
loadMeta().catch(() => {}).then(load);
