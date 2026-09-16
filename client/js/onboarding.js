'use strict';

/**
 * First-run onboarding — docs/ROADMAP.md Phase 2.
 *
 * Shown whenever the signed-in account has zero search profiles: a new
 * account otherwise lands on every job from every company, which is
 * meaningless. Saving the wizard POSTs to /api/profiles — the exact same
 * endpoint client/js/settings.js uses — there is no second way to create a
 * profile.
 *
 * A guest (not signed in) never sees this: there is no account to save a
 * profile into, and GET /api/profiles would 401 for them anyway.
 */

let onbVocabulary = { employmentTypes: [], experienceLevels: [], locations: [] };
let onbStep = 1;
const ONB_LAST_STEP = 3;

function onbFillSelect(select, values, labels) {
  const placeholder = select.firstElementChild;
  select.replaceChildren(placeholder);
  for (const value of values) select.append(el('option', { value, textContent: labels?.[value] || value }));
}

// Same checkboxes-in-a-<details> pattern as client/js/search.js's
// fillLocationMultiselect / client/js/settings.js's fillProfileLocationOptions.
function onbFillLocationOptions(locations) {
  const panel = $('onb-location-options');
  panel.replaceChildren();
  for (const value of locations) {
    const label = HEBREW.location?.[value] || value;
    const checkbox = el('input', { type: 'checkbox', value });
    checkbox.dataset.label = label;
    checkbox.addEventListener('change', onbUpdateLocationSummary);
    panel.append(el('label', { className: 'multiselect-option' }, checkbox, ` ${label}`));
  }
}

const onbLocationCheckboxes = () => [...$('onb-location-options').querySelectorAll('input[type=checkbox]')];
const onbSelectedLocations = () => onbLocationCheckboxes().filter((c) => c.checked).map((c) => c.value);

function onbUpdateLocationSummary() {
  const checked = onbLocationCheckboxes().filter((c) => c.checked);
  const summary = $('onb-location-summary');
  if (checked.length === 0) summary.textContent = 'כל המיקומים';
  else if (checked.length === 1) summary.textContent = checked[0].dataset.label;
  else summary.textContent = `${checked.length} מיקומים נבחרו`;
}

function onbInitLocationMenu() {
  const menu = $('onb-location-menu');
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    // Escape here only closes the location dropdown inside the wizard — it
    // must never bubble into closing the wizard itself (see the module
    // comment: skipping is only ever the explicit "דלגי" button).
    event.stopPropagation();
    menu.open = false;
    menu.querySelector('summary')?.focus();
  });
}

function showOnbStep(step) {
  onbStep = step;
  for (let i = 1; i <= ONB_LAST_STEP; i++) $(`onboarding-step-${i}`).hidden = i !== step;
  $('onboarding-step-indicator').textContent = `שלב ${step} מתוך ${ONB_LAST_STEP}`;
  $('onboarding-back').hidden = step === 1;
  $('onboarding-next').hidden = step === ONB_LAST_STEP;
  $('onboarding-finish').hidden = step !== ONB_LAST_STEP;
  $('onboarding-error').textContent = '';

  const focusTarget = step === 1 ? $('onb-keywords')
    : step === 2 ? $('onb-location-menu').querySelector('summary')
    : $('onb-experience');
  focusTarget?.focus();
}

function openOnboarding() {
  $('onboarding-overlay').hidden = false;
  document.body.style.overflow = 'hidden'; // the modal is the only scrollable thing while it's up
  showOnbStep(1);
}

function closeOnboarding() {
  $('onboarding-overlay').hidden = true;
  document.body.style.overflow = '';
}

function requireKeywords() {
  if ($('onb-keywords').value.trim()) return true;
  showOnbStep(1);
  $('onboarding-error').textContent = 'נא להקליד לפחות מילת מפתח אחת.';
  $('onb-keywords').focus();
  return false;
}

$('onboarding-next').addEventListener('click', () => {
  if (onbStep === 1 && !requireKeywords()) return;
  showOnbStep(Math.min(ONB_LAST_STEP, onbStep + 1));
});

$('onboarding-back').addEventListener('click', () => showOnbStep(Math.max(1, onbStep - 1)));

// The one deliberate way out without saving anything — see the module
// comment. Nothing else (backdrop click, Escape) is wired to this.
$('onboarding-skip').addEventListener('click', closeOnboarding);

$('onboarding-finish').addEventListener('click', async () => {
  if (!requireKeywords()) return;

  const submitButton = $('onboarding-finish');
  submitButton.disabled = true;

  const payload = {
    name: 'החיפוש שלי',
    keywords: $('onb-keywords').value.trim(),
    locations: onbSelectedLocations(),
    experienceLevel: $('onb-experience').value || null,
    employmentType: $('onb-employment').value || null,
  };

  const response = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);

  if (!response) {
    $('onboarding-error').textContent = 'אין חיבור לשרת.';
    submitButton.disabled = false;
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    $('onboarding-error').textContent = body.error || 'שמירת הפרופיל נכשלה. נסי שוב.';
    submitButton.disabled = false;
    return;
  }

  closeOnboarding();
  landOnFilteredSearch(payload);
});

/**
 * Reuses the exact ?q=/&experience=/&employment=/&location= query params
 * client/js/search.js already reads on load (readFiltersFromUrl) — a
 * profile-filtered landing is just a bookmarked search with the wizard's
 * answers in the URL, not a second filtering mechanism.
 */
function landOnFilteredSearch(payload) {
  const params = new URLSearchParams();
  if (payload.keywords) params.set('q', payload.keywords);
  if (payload.experienceLevel) params.set('experience', payload.experienceLevel);
  if (payload.employmentType) params.set('employment', payload.employmentType);
  for (const loc of payload.locations || []) params.append('location', loc);

  location.href = `index.html?${params.toString()}#onboarded`;
}

function showOnboardingBanner() {
  const banner = $('onboarding-banner');
  if (banner) banner.hidden = false;
}

$('onboarding-show-all')?.addEventListener('click', () => {
  location.href = 'index.html';
});

async function initOnboarding() {
  let session;
  try {
    session = await (await fetch('/api/session')).json();
  } catch {
    return; // server unreachable — search.js's own error panel already covers this
  }
  if (!session.authenticated) return; // no account to save a profile into

  // Just landed here from finishing the wizard: the profile already exists
  // (that's what got us here), so there's nothing to check — show the
  // banner and stop, rather than re-fetching /api/profiles to confirm what
  // we already know.
  if (location.hash === '#onboarded') {
    showOnboardingBanner();
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  let profilesData;
  try {
    profilesData = await (await fetch('/api/profiles')).json();
  } catch {
    return;
  }
  if (profilesData.profiles && profilesData.profiles.length > 0) return;

  onbVocabulary = profilesData.vocabulary;
  onbFillSelect($('onb-employment'), onbVocabulary.employmentTypes, HEBREW.employment);
  onbFillSelect($('onb-experience'), onbVocabulary.experienceLevels, HEBREW.experience);
  onbFillLocationOptions(onbVocabulary.locations);
  openOnboarding();
}

onbInitLocationMenu();
initOnboarding();
