const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseMobileyeJobs } = require('../src/adapters/mobileyeAdapter');
const { parseGoogleJobs } = require('../src/adapters/googleAdapter');
const { decodeEntities, stripTags } = require('../src/adapters/htmlUtils');
const { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS } = require('../src/adapters/normalize');
const { matches } = require('../src/matcher');

/**
 * The fixtures are real markup, cut verbatim out of pages fetched on 2026-08-05
 * by tools/probe-all.js. Not hand-written, not idealised.
 *
 * That matters: a fixture you wrote yourself only proves the parser agrees with
 * your imagination. This one proves it agrees with Mobileye and Google.
 */
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// ---------------------------------------------------------------------------
// Mobileye
// ---------------------------------------------------------------------------

test('Mobileye: parses jobs out of the real page', () => {
    const jobs = parseMobileyeJobs(fixture('mobileye-jobs.html'));
    assert.ok(jobs.length >= 3, `expected at least 3 jobs, got ${jobs.length}`);
});

test('Mobileye: fills every field on every job', () => {
    for (const job of parseMobileyeJobs(fixture('mobileye-jobs.html'))) {
        assert.ok(job.externalId, 'missing externalId');
        assert.ok(job.title, `missing title on ${job.externalId}`);
        assert.ok(job.location, `missing location on ${job.title}`);
        assert.match(job.applyUrl, /^https:\/\/careers\.mobileye\.com\/jobs\//);
    }
});

test('Mobileye: reads a known job correctly', () => {
    const jobs = parseMobileyeJobs(fixture('mobileye-jobs.html'));
    const job = jobs.find((j) => j.externalId === 'bb661a53-79b8-459d-a8df-5dd419d62596');

    assert.ok(job, '3D Algorithm Developer not found');
    assert.equal(job.title, '3D Algorithm Developer');
    assert.equal(job.location, 'Ramat Gan');
    assert.equal(job.department, 'Algorithms');
});

test('Mobileye: the uuid is the id, and cards are not double counted', () => {
    const jobs = parseMobileyeJobs(fixture('mobileye-jobs.html'));
    const ids = jobs.map((j) => j.externalId);

    assert.equal(new Set(ids).size, ids.length, 'duplicate jobs — the mobile/desktop dedupe broke');
    for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

test('Google: parses jobs out of the real page', () => {
    const jobs = parseGoogleJobs(fixture('google-jobs.html'));
    assert.ok(jobs.length >= 2, `expected at least 2 jobs, got ${jobs.length}`);
});

test('Google: fills every field on every job', () => {
    for (const job of parseGoogleJobs(fixture('google-jobs.html'))) {
        assert.match(job.externalId, /^\d+$/);
        assert.ok(job.title, `missing title on ${job.externalId}`);
        assert.ok(job.location, `missing location on ${job.title}`);
        assert.match(job.applyUrl, /^https:\/\/www\.google\.com\/about\/careers\//);
    }
});

test('Google: reads a known job correctly', () => {
    const jobs = parseGoogleJobs(fixture('google-jobs.html'));
    const job = jobs.find((j) => j.externalId === '119725794359419590');

    assert.ok(job, 'Software Engineer II not found');
    assert.equal(job.title, 'Software Engineer II, Search Platforms');
    assert.equal(job.location, 'Tel Aviv, Israel');
});

test('Google: strips the tracking query off the apply URL', () => {
    for (const job of parseGoogleJobs(fixture('google-jobs.html'))) {
        assert.ok(!job.applyUrl.includes('?'), `apply URL kept a query string: ${job.applyUrl}`);
    }
});

// ---------------------------------------------------------------------------
// The fields the UI filters on
// ---------------------------------------------------------------------------

test('Mobileye: reads the commitment tag as employment type', () => {
    const jobs = parseMobileyeJobs(fixture('mobileye-jobs.html'));
    assert.ok(
        jobs.every((j) => j.employmentType === null || EMPLOYMENT_TYPES.includes(j.employmentType)),
        'an employment type escaped the vocabulary'
    );
    assert.ok(jobs.some((j) => j.employmentType === 'full-time'), 'expected at least one full-time job');
});

test('Google: reads the Early/Mid/Advanced grading', () => {
    const jobs = parseGoogleJobs(fixture('google-jobs.html'));
    assert.ok(
        jobs.every((j) => j.experienceLevel === null || EXPERIENCE_LEVELS.includes(j.experienceLevel)),
        'an experience level escaped the vocabulary'
    );
    assert.ok(jobs.some((j) => j.experienceLevel), 'expected at least one graded job');
});

test('both adapters emit every field the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    const all = [...parseMobileyeJobs(fixture('mobileye-jobs.html')), ...parseGoogleJobs(fixture('google-jobs.html'))];

    for (const job of all) {
        for (const key of required) {
            assert.ok(key in job, `${job.title} is missing the key "${key}"`);
        }
    }
});

// ---------------------------------------------------------------------------
// The seam: parsed jobs have to survive the matcher
// ---------------------------------------------------------------------------

test('a parsed Google job matches a Tel Aviv profile', () => {
    const jobs = parseGoogleJobs(fixture('google-jobs.html'));
    const job = jobs.find((j) => j.externalId === '119725794359419590');
    assert.equal(matches(job, { keywords: 'software,backend', location_filter: 'Tel Aviv' }), true);
});

test('a parsed Mobileye job matches a Ramat Gan profile', () => {
    const jobs = parseMobileyeJobs(fixture('mobileye-jobs.html'));
    const job = jobs.find((j) => j.externalId === 'bb661a53-79b8-459d-a8df-5dd419d62596');
    assert.equal(matches(job, { keywords: 'algorithm', location_filter: 'Ramat Gan' }), true);
});

// ---------------------------------------------------------------------------
// htmlUtils
// ---------------------------------------------------------------------------

test('decodes the entities that show up in job titles', () => {
    assert.equal(decodeEntities('Q&amp;A  Engineer'), 'Q&A Engineer');
    assert.equal(decodeEntities('R&amp;D&nbsp;Lead'), 'R&D Lead');
    assert.equal(decodeEntities('  spaced   out  '), 'spaced out');
});

test('strips tags without gluing words together', () => {
    assert.equal(stripTags('<p>Tel Aviv</p><p>Israel</p>'), 'Tel Aviv Israel');
});
