'use strict';

/** Dashboard: everything you've engaged with, with the date you applied. */

const SUMMARY_ORDER = ['saved', 'applied', 'interviewing', 'offer', 'rejected'];

let vocabulary = [];
let rows = [];

function renderSummary(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const list = $('summary');
  list.replaceChildren();

  list.append(el('li', {},
    el('span', { className: 'n', textContent: String(total) }),
    el('span', { className: 'k', textContent: 'סה״כ' })));

  for (const status of SUMMARY_ORDER) {
    if (!counts[status]) continue;
    list.append(el('li', {},
      el('span', { className: 'n', textContent: String(counts[status]) }),
      el('span', { className: 'k', textContent: HEBREW.status[status] })));
  }
}

function applicationRow(row) {
  const tr = el('tr');

  // --- date applied ---
  const dateId = `date-${row.jobId}`;
  const date = el('input', { type: 'date', id: dateId, value: row.appliedAt || '' });
  date.setAttribute('aria-label', `תאריך הגשה עבור ${row.title}`);
  date.addEventListener('change', async () => {
    try {
      await saveApplication({ jobId: row.jobId, appliedAt: date.value || null });
      announce(date.value
        ? `תאריך ההגשה של "${row.title}" נשמר: ${date.value}.`
        : `תאריך ההגשה של "${row.title}" נוקה.`);
    } catch (err) {
      announce('שמירת התאריך נכשלה: ' + err.message);
    }
  });
  tr.append(el('td', { className: 'col-date' }, date));

  // --- company ---
  tr.append(el('td', { textContent: row.company }));

  const displayJobNumber = row.jobCode || row.externalId;

  // --- job number ---
  tr.append(el('td', { className: 'col-id' },
    el('span', { className: 'mono ltr', textContent: displayJobNumber || '—' })));

  // --- role, linked to the company's own posting ---
  const link = el('a', {
    href: row.applyUrl, target: '_blank', rel: 'noopener noreferrer',
    className: 'ltr', textContent: row.title,
  });
  link.append(el('span', { className: 'visually-hidden', textContent: ' (נפתח בלשונית חדשה באתר החברה)' }));
  const cell = el('td', {}, link);
  if (row.location) cell.append(el('div', { className: 'job-meta', textContent: row.location }));
  if (!row.isStillOpen) cell.append(el('div', {},
    el('span', { className: 'tag closed', textContent: 'המשרה נסגרה' })));
  tr.append(cell);

  // --- status ---
  const statusId = `status-${row.jobId}`;
  const select = statusSelect(statusId, row.status, vocabulary);
  select.setAttribute('aria-label', `סטטוס עבור ${row.title}`);
  const badge = el('span', {
    className: row.status ? `status-badge status-${row.status}` : 'visually-hidden',
    textContent: row.status ? HEBREW.status[row.status] : '',
  });
  select.addEventListener('change', async () => {
    try {
      await saveApplication({ jobId: row.jobId, status: select.value || null });
      if (!select.value) { announce(`"${row.title}" הוסרה מהמעקב.`); load(); return; }
      badge.className = `status-badge status-${select.value}`;
      badge.textContent = HEBREW.status[select.value];
      announce(`הסטטוס של "${row.title}" עודכן ל־${HEBREW.status[select.value]}.`);
      load();
    } catch (err) {
      announce('שמירת הסטטוס נכשלה: ' + err.message);
    }
  });
  tr.append(el('td', { className: 'col-status' }, select, badge));

  // --- notes ---
  const notesId = `notes-${row.jobId}`;
  const notes = el('textarea', { id: notesId, rows: 1, value: row.notes || '', placeholder: 'הערות…' });
  notes.setAttribute('aria-label', `הערות עבור ${row.title}`);
  notes.addEventListener('blur', async () => {
    if ((notes.value || '') === (row.notes || '')) return;
    try {
      await saveApplication({ jobId: row.jobId, notes: notes.value });
      row.notes = notes.value;
      announce(`ההערות של "${row.title}" נשמרו.`);
    } catch (err) {
      announce('שמירת ההערות נכשלה: ' + err.message);
    }
  });
  tr.append(el('td', { className: 'col-notes' }, notes));

  return tr;
}

function renderTable() {
  const filter = $('f-status').value;
  const visible = filter ? rows.filter((r) => r.status === filter) : rows;

  $('results-count').textContent = visible.length === 0
    ? 'אין הגשות להצגה'
    : `${visible.length} הגשות במעקב`;

  if (rows.length === 0) {
    $('results').replaceChildren(el('div', { className: 'empty' },
      el('p', { textContent: 'עוד לא סימנת אף משרה.' }),
      el('p', {}, 'עברי ל', el('a', { href: '/', textContent: 'חיפוש משרות' }),
        ' ובחרי סטטוס לכל משרה שאת מגישה אליה.')));
    return;
  }

  if (visible.length === 0) {
    $('results').replaceChildren(el('div', { className: 'empty', textContent: 'אין הגשות בסטטוס הזה.' }));
    return;
  }

  const head = el('tr');
  for (const label of ['תאריך הגשה', 'חברה', 'מספר משרה', 'תפקיד', 'סטטוס', 'הערות']) {
    head.append(el('th', { scope: 'col', textContent: label }));
  }

  const table = el('table', {},
    el('caption', { textContent: 'מעקב הגשות — תאריך, חברה, מספר משרה וקישור למשרה' }),
    el('thead', {}, head),
    el('tbody', {}, ...visible.map(applicationRow)));

  $('results').replaceChildren(el('div', { className: 'table-wrap' }, table));
}

async function load() {
  let data;
  try {
    data = await fetchJson('/api/applications');
  } catch {
    $('results-count').textContent = 'לא ניתן לטעון את הנתונים';
    $('results').replaceChildren(serverDownPanel());
    return;
  }

  rows = data.applications;
  vocabulary = data.statusVocabulary;

  // Only offer statuses that actually exist, so the filter is never a dead end.
  const previous = $('f-status').value;
  $('f-status').replaceChildren(el('option', { value: '', textContent: 'כל הסטטוסים' }));
  for (const status of SUMMARY_ORDER) {
    if (!data.counts[status]) continue;
    $('f-status').append(el('option', {
      value: status, textContent: `${HEBREW.status[status]} (${data.counts[status]})`,
    }));
  }
  $('f-status').value = previous;

  renderSummary(data.counts);
  renderTable();
}

$('f-status').addEventListener('change', renderTable);

initUI();
load();
