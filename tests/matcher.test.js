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

test('should honour experience_filter (dead column today)', { todo: true }, () => {
    const student = { ...backend, experience_filter: 'student,junior' };
    assert.equal(matches(job('Student Backend Position'), student), true);
    assert.equal(matches(job('Backend Team Lead'), student), false);
});

// ---------------------------------------------------------------------------
// Input robustness — the matcher runs on scraped data, which is never clean
// ---------------------------------------------------------------------------

test('should not throw on a job with a missing location', { todo: true }, () => {
    assert.doesNotThrow(() => matches({ title: 'Backend Engineer' }, backendHaifa));
});
