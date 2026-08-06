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

async function loadMeta() {
  meta = await fetchJson('/api/meta');
  fillSelect($('f-company'), meta.companies.map((c) => ({ value: c.id, name: c.name, count: c.count })));
  fillSelect($('f-experience'), meta.experienceLevels, HEBREW.experience);
  fillSelect($('f-employment'), meta.employmentTypes, HEBREW.employment);
  fillSelect($('f-location'), meta.locations, HEBREW.location);
  fillSelect($('f-status'), meta.statuses, HEBREW.status);
}

function buildQuery() {
  const params = new URLSearchParams();
  const add = (key, value) => { if (value) params.set(key, value); };
  add('q', $('f-q').value.trim());
  add('company', $('f-company').value);
  add('experience', $('f-experience').value);
  add('employment', $('f-employment').value);
  add('location', $('f-location').value);
  add('status', $('f-status').value);
  if ($('f-open').checked) params.set('open', '1');
  return params;
}

function jobCard(job) {
  const titleId = `job-${job.id}-title`;
  const statusId = `job-${job.id}-status`;

  const link = el('a', {
    href: job.applyUrl, target: '_blank', rel: 'noopener noreferrer',
    className: 'ltr', textContent: job.title,
  });
  link.append(el('span', { className: 'visually-hidden', textContent: ' (נפתח בלשונית חדשה באתר החברה)' }));

  // Named jobMeta, not meta — a local `meta` would shadow the module-level
  // `meta` and quietly break the status dropdown below.
  const displayJobNumber = job.jobCode || job.externalId;
  const jobNumberLabel = displayJobNumber ? ` · משרה מס׳ ` : '';

  const jobMeta = el('p', { className: 'job-meta' },
    el('strong', { textContent: job.company }),
    job.location ? ` · ${job.location}` : '',
    jobNumberLabel,
    displayJobNumber ? el('span', { className: 'mono ltr', textContent: displayJobNumber }) : null);

  const tags = el('ul', { className: 'tags' });
  const addTag = (text, cls) => tags.append(el('li', { className: cls || 'tag', textContent: text }));
  if (job.experienceLevel) addTag(HEBREW.experience[job.experienceLevel] || job.experienceLevel);
  if (job.employmentType) addTag(HEBREW.employment[job.employmentType] || job.employmentType);
  if (job.department) addTag(job.department);
  if (!job.isStillOpen) addTag('נסגרה', 'tag closed');

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

// Dropdowns filter instantly; free text waits for the search button or Enter,
// so results don't shift under you while you're still typing.
for (const id of ['f-company', 'f-experience', 'f-employment', 'f-location', 'f-status', 'f-open']) {
  $(id).addEventListener('change', load);
}
$('filters').addEventListener('submit', (event) => { event.preventDefault(); load(); });
$('reset').addEventListener('click', () => {
  $('f-q').value = '';
  for (const id of ['f-company', 'f-experience', 'f-employment', 'f-location', 'f-status']) $(id).value = '';
  $('f-open').checked = true;
  load();
  announce('הסינון נוקה.');
});

initUI();
// If the meta call fails, load() renders the explanation panel — so the page
// never sits on "טוען…" without saying why.
loadMeta().catch(() => {}).then(load);
