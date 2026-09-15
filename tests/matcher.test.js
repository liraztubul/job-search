const test = require('node:test');
const assert = require('node:assert');
const { matches } = require('../server/domain/matcher');

// Helpers so each test reads as one line of intent, not object soup.
const job = (title, location = 'Haifa') => ({ title, location });
const profile = (keywords, location_filter = null) => ({ keywords, location_filter });

const backend = profile('backend,server,node,python');
const backendHaifa = profile('backend,server,node,python', 'Haifa');

// ---------------------------------------------------------------------------
// Keyword matching — current behaviour
// ---------------------------------------------------------------------------

test('matches a keyword in the title', () => {
    assert.equal(matches(job('Backend Engineer'), backend), true);
});

test('is case insensitive', () => {
    assert.equal(matches(job('BACKEND ENGINEER'), backend), true);
    assert.equal(matches(job('backend engineer'), backend), true);
});

test('matches on any keyword, not all of them', () => {
    assert.equal(matches(job('Python Developer'), backend), true);
});

test('rejects a title with no keyword', () => {
    assert.equal(matches(job('Marketing Manager'), backend), false);
});

test('tolerates spaces around commas in the keyword list', () => {
    assert.equal(matches(job('Backend Engineer'), profile('backend , python')), true);
});

// ---------------------------------------------------------------------------
// Location filter
// ---------------------------------------------------------------------------

test('no location filter means any location passes', () => {
    assert.equal(matches(job('Backend Engineer', 'Tel Aviv'), backend), true);
});

test('location filter rejects a different city', () => {
    assert.equal(matches(job('Backend Engineer', 'Tel Aviv'), backendHaifa), false);
});

test('location filter accepts a partial match', () => {
    assert.equal(matches(job('Backend Engineer', 'Haifa, Israel'), backendHaifa), true);
});

test('keyword miss is rejected even when the location matches', () => {
    assert.equal(matches(job('HR Coordinator', 'Haifa'), backendHaifa), false);
});

// ---------------------------------------------------------------------------
// Location filter — multiple locations (OR), comma-separated like keywords
// ---------------------------------------------------------------------------

test('a job matches any one of several selected locations', () => {
    const multi = profile('backend', 'Haifa,Tel Aviv');
    assert.equal(matches(job('Backend Engineer', 'Tel Aviv'), multi), true);
    assert.equal(matches(job('Backend Engineer', 'Haifa'), multi), true);
    assert.equal(matches(job('Backend Engineer', 'Jerusalem'), multi), false);
});

// ---------------------------------------------------------------------------
// Experience filter — see ARCHITECTURE.md §4.4, item 3 (was a dead column;
// now read by matches()).
// ---------------------------------------------------------------------------

function jobWithLevel(title, experience_level, location = 'Haifa') {
    return { title, location, experience_level };
}

test('experience filter accepts a job at one of the selected levels', () => {
    const junior = { ...backend, experience_filter: 'entry,intern' };
    assert.equal(matches(jobWithLevel('Backend Engineer', 'entry'), junior), true);
    assert.equal(matches(jobWithLevel('Backend Engineer', 'intern'), junior), true);
});

test('experience filter rejects a job at a different level', () => {
    const junior = { ...backend, experience_filter: 'entry,intern' };
    assert.equal(matches(jobWithLevel('Backend Engineer', 'senior'), junior), false);
});

test('experience filter rejects a job with no known level at all', () => {
    const junior = { ...backend, experience_filter: 'entry,intern' };
    assert.equal(matches(jobWithLevel('Backend Engineer', null), junior), false);
});

test('no experience filter means any level passes', () => {
    assert.equal(matches(jobWithLevel('Backend Engineer', 'senior'), backend), true);
});

// ---------------------------------------------------------------------------
// Employment filter — same OR/comma shape, added alongside the browser CRUD
// UI (docs/ROADMAP.md's "Managing everything from the browser").
// ---------------------------------------------------------------------------

function jobWithType(title, employment_type, location = 'Haifa') {
    return { title, location, employment_type };
}

test('employment filter accepts a job of the selected type', () => {
    const fullTimeOnly = { ...backend, employment_filter: 'full-time' };
    assert.equal(matches(jobWithType('Backend Engineer', 'full-time'), fullTimeOnly), true);
});

test('employment filter rejects a job of a different type', () => {
    const fullTimeOnly = { ...backend, employment_filter: 'full-time' };
    assert.equal(matches(jobWithType('Backend Engineer', 'internship'), fullTimeOnly), false);
});

test('no employment filter means any type passes', () => {
    assert.equal(matches(jobWithType('Backend Engineer', 'contract'), backend), true);
});

// ---------------------------------------------------------------------------
// Known gaps — see ARCHITECTURE.md §4.4
//
// These describe what the matcher SHOULD do, and currently does not. They run
// as `todo`, so they report without failing the suite. When you implement the
// fix, delete the `{ todo: true }` and the test turns into a real green light.
// ---------------------------------------------------------------------------

test('should match hyphenated variants', { todo: true }, () => {
    assert.equal(matches(job('Back-End Developer'), backend), true);
});

test('should support excluding senior roles', { todo: true }, () => {
    const junior = { ...backend, exclude_keywords: 'senior,staff,principal,manager' };
    assert.equal(matches(job('Senior Backend Architect'), junior), false);
    assert.equal(matches(job('Junior Backend Engineer'), junior), true);
});

// ---------------------------------------------------------------------------
// Input robustness — the matcher runs on scraped data, which is never clean
// ---------------------------------------------------------------------------

test('should not throw on a job with a missing location', { todo: true }, () => {
    assert.doesNotThrow(() => matches({ title: 'Backend Engineer' }, backendHaifa));
});
