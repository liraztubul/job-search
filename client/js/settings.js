'use strict';

/**
 * Settings page: the "פרופילי חיפוש" (search profiles) CRUD section.
 *
 * The account-deletion form on this page is handled by its own inline
 * <script> (unchanged) — this file owns only the profiles feature, reusing
 * the same building blocks (el/$, HEBREW, fetchJson) ui.js already provides.
 */

let profileVocabulary = { employmentTypes: [], experienceLevels: [], locations: [] };
let profiles = [];
let editingId = null;

const locationLabel = (value) => HEBREW.location?.[value] || value;

/** Fills a plain single <select> — same shape as search.js's fillSelect,
 *  minus the per-option counts a search filter has and a profile form doesn't. */
function fillSingleSelect(select, values, labels) {
  const placeholder = select.firstElementChild;
  select.replaceChildren(placeholder);
  for (const value of values) {
    select.append(el('option', { value, textContent: labels?.[value] || value }));
  }
}

// ------------------------------ location multiselect -------------------------
// Same checkboxes-in-a-<details> pattern as client/js/search.js's
// fillLocationMultiselect, without the per-option job counts a filter has and
// a profile form has no use for.
function fillProfileLocationOptions(locations) {
  const panel = $('pf-location-options');
  panel.replaceChildren();
  for (const value of locations) {
    const label = locationLabel(value);
    const checkbox = el('input', { type: 'checkbox', value });
    checkbox.dataset.label = label;
    checkbox.addEventListener('change', updatePfLocationSummary);
    panel.append(el('label', { className: 'multiselect-option' }, checkbox, ` ${label}`));
  }
}

const pfLocationCheckboxes = () => [...$('pf-location-options').querySelectorAll('input[type=checkbox]')];
const pfSelectedLocations = () => pfLocationCheckboxes().filter((c) => c.checked).map((c) => c.value);

function updatePfLocationSummary() {
  const checked = pfLocationCheckboxes().filter((c) => c.checked);
  const summary = $('pf-location-summary');
  if (checked.length === 0) summary.textContent = 'כל המיקומים';
  else if (checked.length === 1) summary.textContent = checked[0].dataset.label;
  else summary.textContent = `${checked.length} מיקומים נבחרו`;
}

function initPfLocationMenu() {
  const menu = $('pf-location-menu');
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
  });
}

// --------------------------------- list -------------------------------------

function profileTags(profile) {
  const tags = el('ul', { className: 'tags' });
  const add = (cls, text) => tags.append(el('li', { className: cls, textContent: text }));

  if (profile.location_filter) {
    add('tag tag-highlight tag-location', profile.location_filter.split(',').map(locationLabel).join(', '));
  }
  if (profile.experience_filter) {
    add('tag tag-highlight', profile.experience_filter.split(',').map((v) => HEBREW.experience[v] || v).join(', '));
  }
  if (profile.employment_filter) {
    add('tag', profile.employment_filter.split(',').map((v) => HEBREW.employment[v] || v).join(', '));
  }
  if (!profile.is_active) add('tag closed', 'מושהה');

  return tags;
}

// Reuses the job-card component classes (.job/.job-main/.job-status/.tags) —
// same "card row with content on one side, actions on the other" shape
// already used for a job listing, not a second visual language.
function profileCard(profile) {
  const main = el('div', { className: 'job-main' },
    el('h3', { className: 'job-title', textContent: profile.name }),
    el('p', { className: 'job-meta' },
      'מילות מפתח: ', el('span', { className: 'ltr', textContent: profile.keywords.split(',').join(', ') })),
    profileTags(profile));

  const editBtn = el('button', { type: 'button', className: 'btn', textContent: 'עריכה' });
  editBtn.addEventListener('click', () => openForm(profile));

  const deleteBtn = el('button', { type: 'button', className: 'btn btn-danger', textContent: 'מחיקה' });
  deleteBtn.addEventListener('click', () => removeProfile(profile));

  const article = el('article', { className: 'job' }, main, el('div', { className: 'job-status' }, editBtn, deleteBtn));
  return el('li', {}, article);
}

function renderProfiles() {
  const list = $('profiles-list');
  list.replaceChildren();
  const note = $('profiles-note');

  if (profiles.length === 0) {
    note.textContent = 'עדיין אין לך פרופיל חיפוש — לחצי על "פרופיל חדש" כדי להתחיל לקבל משרות מותאמות.';
    return;
  }
  note.textContent = '';
  list.append(...profiles.map(profileCard));
}

async function loadProfiles() {
  let data;
  try {
    data = await fetchJson('/api/profiles');
  } catch {
    $('profiles-note').textContent = 'לא ניתן לטעון את פרופילי החיפוש.';
    return;
  }

  profiles = data.profiles;
  profileVocabulary = data.vocabulary;
  fillSingleSelect($('pf-employment'), profileVocabulary.employmentTypes, HEBREW.employment);
  fillSingleSelect($('pf-experience'), profileVocabulary.experienceLevels, HEBREW.experience);
  fillProfileLocationOptions(profileVocabulary.locations);
  renderProfiles();
}

// --------------------------------- form ---------------------------------

function openForm(profile) {
  editingId = profile ? profile.id : null;
  $('pf-heading').textContent = profile ? 'עריכת פרופיל' : 'פרופיל חדש';
  $('pf-id').value = profile ? profile.id : '';
  $('pf-name').value = profile ? profile.name : '';
  $('pf-keywords').value = profile ? profile.keywords.split(',').join(', ') : '';
  $('pf-employment').value = profile?.employment_filter || '';
  $('pf-experience').value = profile?.experience_filter || '';

  const selected = profile?.location_filter ? profile.location_filter.split(',') : [];
  for (const checkbox of pfLocationCheckboxes()) checkbox.checked = selected.includes(checkbox.value);
  updatePfLocationSummary();

  $('pf-error').textContent = '';
  $('profile-form').hidden = false;
  $('new-profile-btn').hidden = true;
  $('pf-name').focus();
}

function closeForm() {
  $('profile-form').hidden = true;
  $('new-profile-btn').hidden = false;
  editingId = null;
}

async function removeProfile(profile) {
  if (!confirm(`למחוק את הפרופיל "${profile.name}"?`)) return;

  const response = await fetch(`/api/profiles/${profile.id}`, { method: 'DELETE' }).catch(() => null);
  if (!response || !response.ok) {
    $('profiles-note').textContent = 'מחיקת הפרופיל נכשלה.';
    return;
  }
  await loadProfiles();
}

$('new-profile-btn').addEventListener('click', () => openForm(null));
$('pf-cancel').addEventListener('click', closeForm);

$('profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('pf-error').textContent = '';

  const payload = {
    name: $('pf-name').value.trim(),
    keywords: $('pf-keywords').value,
    locations: pfSelectedLocations(),
    experienceLevel: $('pf-experience').value || null,
    employmentType: $('pf-employment').value || null,
  };

  const method = editingId ? 'PUT' : 'POST';
  const url = editingId ? `/api/profiles/${editingId}` : '/api/profiles';

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);

  if (!response) {
    $('pf-error').textContent = 'אין חיבור לשרת.';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    $('pf-error').textContent = body.error || 'שמירת הפרופיל נכשלה.';
    return;
  }

  closeForm();
  await loadProfiles();
});

initPfLocationMenu();
loadProfiles();
