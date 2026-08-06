const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseAppleJobs, parseAppleDate } = require('../server/adapters/appleAdapter');
const { EXPERIENCE_LEVELS } = require('../server/domain/vocabulary');
const { matches } = require('../server/domain/matcher');

/**
 * Six job cards cut verbatim out of a real page fetched 2026-08-06
 * (https://jobs.apple.com/en-il/search?location=israel-ISR). Not hand-written.
 */
const fixture = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'apple-jobs.html'), 'utf8');

test('parses jobs out of the real page', () => {
    const jobs = parseAppleJobs(fixture());
    assert.equal(jobs.length, 6);
});

test('fills every field the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const job of parseAppleJobs(fixture())) {
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
        assert.ok(job.location, `missing location on ${job.title}`);
        assert.match(job.applyUrl, /^https:\/\/jobs\.apple\.com\/en-il\/details\//);
    }
});

test('reads a known job correctly', () => {
    const jobs = parseAppleJobs(fixture());
    const job = jobs.find((j) => j.externalId === '200674985-0865');

    assert.ok(job, 'Silicon Validation/Emulation Design Engineer not found');
    assert.equal(job.title, 'Silicon Validation/Emulation Design Engineer');
    assert.equal(job.location, 'Herzliya');
    assert.equal(job.department, 'Hardware');
    assert.equal(job.postedAt, '2026-07-30');
});

test('the same requisition open in two cities gets two distinct ids', () => {
    // Apple posts "CAD Engineer – PDV" separately for Haifa and Herzliya —
    // same title, different jobId-locationId pair. Both must survive, not dedupe.
    const jobs = parseAppleJobs(fixture()).filter((j) => j.title === 'CAD Engineer – PDV');
    assert.equal(jobs.length, 2);
    assert.deepEqual(
        jobs.map((j) => j.location).sort(),
        ['Haifa', 'Herzliya']
    );
});

test('decodes the en-dash and other entities in titles', () => {
    const job = parseAppleJobs(fixture()).find((j) => j.externalId === '200675366-1451');
    assert.equal(job.title, 'CAD Engineer – PDV');
});

test('never emits an experience level outside the vocabulary', () => {
    for (const job of parseAppleJobs(fixture())) {
        assert.ok(job.experienceLevel === null || EXPERIENCE_LEVELS.includes(job.experienceLevel));
    }
});

test('parseAppleDate: "03 Aug 2026" -> "2026-08-03"', () => {
    assert.equal(parseAppleDate('03 Aug 2026'), '2026-08-03');
});

test('parseAppleDate: unrecognized text -> null, not a guess', () => {
    assert.equal(parseAppleDate('recently'), null);
    assert.equal(parseAppleDate(''), null);
});

test('a parsed job matches a Herzliya profile', () => {
    const job = parseAppleJobs(fixture()).find((j) => j.externalId === '200673054-0865');
    assert.equal(matches(job, { keywords: 'qa,quality', location_filter: 'Herzliya' }), true);
    assert.equal(matches(job, { keywords: 'qa,quality', location_filter: 'Haifa' }), false);
});
