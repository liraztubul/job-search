const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mapElbitJob } = require('../server/adapters/elbitAdapter');
const { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS } = require('../server/domain/vocabulary');
const { matches } = require('../server/domain/matcher');
const { locationTokens } = require('../server/data');

/**
 * Five jobs cut verbatim out of the live cron/jobs.json captured on 2026-08-05
 * by `node tools/sniff.js elbit`. Chosen to cover the shapes that actually
 * occur: a Hebrew title, an English one, a student role, the single job that
 * sets employmentType, and one with no area at all.
 */
const REAL_JOBS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'elbit-jobs.json'), 'utf8'));

const byId = (id) => REAL_JOBS.find((j) => j.jobId === id);

test('maps a real Hebrew job', () => {
    const job = mapElbitJob(byId(20904));

    assert.equal(job.externalId, '20904');
    assert.equal(job.title, 'מנהל.ת תכנית');
    assert.equal(job.location, 'North');
    assert.equal(job.department, 'יבשה ותעש');
    assert.equal(job.jobCode, '7035');
    assert.equal(job.postedAt, '2026-07-29');
});

test('externalId is the jobId as a string', () => {
    for (const raw of REAL_JOBS) {
        assert.strictEqual(mapElbitJob(raw).externalId, String(raw.jobId));
    }
});

test('keeps the requisition number the site shows as "זיהוי דרישה"', () => {
    // This is the number you quote to a recruiter, so the tracker has to show
    // it. It is not the same as jobId — 7035 vs 20904 on the same posting.
    const job = mapElbitJob(byId(20904));
    assert.equal(job.jobCode, '7035');
    assert.notEqual(job.jobCode, job.externalId);
});

test('throws rather than inventing an id', () => {
    const { jobId, ...noId } = byId(20904);
    assert.throws(() => mapElbitJob(noId), /no jobId/);
});

// ---------------------------------------------------------------------------
// Hebrew seniority — the reason normalize.js needed teaching
// ---------------------------------------------------------------------------

test('reads seniority out of Hebrew titles', () => {
    assert.equal(mapElbitJob(byId(20904)).experienceLevel, 'senior'); // מנהל.ת תכנית
    assert.equal(mapElbitJob(byId(20898)).experienceLevel, 'intern'); // סטודנט.ית לשיווק
});

test('still reads seniority out of English titles', () => {
    assert.equal(mapElbitJob(byId(20862)).experienceLevel, 'senior'); // Senior System Engineer
    assert.equal(mapElbitJob(byId(19535)).experienceLevel, 'senior'); // Technical Manager
});

test('never emits a value outside the vocabularies', () => {
    for (const raw of REAL_JOBS) {
        const job = mapElbitJob(raw);
        assert.ok(
            job.experienceLevel === null || EXPERIENCE_LEVELS.includes(job.experienceLevel),
            `bad experienceLevel "${job.experienceLevel}" on ${job.title}`
        );
        assert.ok(
            job.employmentType === null || EMPLOYMENT_TYPES.includes(job.employmentType),
            `bad employmentType "${job.employmentType}" on ${job.title}`
        );
    }
});

test('maps the one job that declares an employment type', () => {
    assert.equal(mapElbitJob(byId(19535)).employmentType, 'full-time');
});

// ---------------------------------------------------------------------------
// Missing data must degrade, not crash
// ---------------------------------------------------------------------------

test('prefers locationAddress over area for Elbit locations', () => {
    const job = mapElbitJob(byId(19535));
    assert.equal(job.location, 'חיפה והקריות');
});

test('canonicalizes repeated location names like Tel Aviv and Haifa', () => {
    assert.deepEqual(locationTokens('Tel Aviv - Yafo'), ['Tel Aviv']);
    assert.deepEqual(locationTokens('Tel-Aviv, the city'), ['Tel Aviv']);
    assert.deepEqual(locationTokens('תל אביב והסביבה'), ['Tel Aviv']);
    assert.deepEqual(locationTokens('חיפה והקריות'), ['Haifa']);
});

test('a job with no area gets an empty location, not a crash', () => {
    const job = mapElbitJob(byId(20725));
    assert.equal(job.location, '');
    assert.ok(job.title);
});

test('trims the whitespace Elbit leaves in area values', () => {
    // Real value in the live feed: "Jerusalem\r\n". Left alone it becomes its
    // own entry in the filter dropdown, next to "Jerusalem Area".
    const job = mapElbitJob({ ...byId(20904), area: 'Jerusalem\r\n' });
    assert.equal(job.location, 'Jerusalem');
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const raw of REAL_JOBS) {
        const job = mapElbitJob(raw);
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

// ---------------------------------------------------------------------------
// Apply URL
// ---------------------------------------------------------------------------

test('falls back to the listing page rather than guessing a job URL', () => {
    // Elbit opens jobs through a client-side router and publishes no per-job
    // address we could verify. A plausible-looking 404 would be worse than a
    // link that definitely works.
    assert.equal(mapElbitJob(byId(20904)).applyUrl, 'https://elbitsystemscareer.com/jobs');
});

test('uses a per-job template once one is configured', () => {
    const job = mapElbitJob(byId(20904), 'https://elbitsystemscareer.com/jobs/{jobId}');
    assert.equal(job.applyUrl, 'https://elbitsystemscareer.com/jobs/20904');
});

test('a template can key off the requisition number instead', () => {
    const job = mapElbitJob(byId(20904), 'https://example.com/apply?req={jobCode}');
    assert.equal(job.applyUrl, 'https://example.com/apply?req=7035');
});

// ---------------------------------------------------------------------------
// The seam with the matcher
// ---------------------------------------------------------------------------

test('a parsed Elbit job survives a Hebrew keyword profile', () => {
    const job = mapElbitJob(byId(20898));
    assert.equal(matches(job, { keywords: 'סטודנט', location_filter: null }), true);
});

test('the region works as a location filter', () => {
    const job = mapElbitJob(byId(20904));
    assert.equal(matches(job, { keywords: 'מנהל', location_filter: 'North' }), true);
    assert.equal(matches(job, { keywords: 'מנהל', location_filter: 'South' }), false);
});
