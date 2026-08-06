const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EightfoldAdapter, mapEightfoldJob } = require('../server/adapters/eightfoldAdapter');
const { EXPERIENCE_LEVELS } = require('../server/domain/vocabulary');
const { matches } = require('../server/domain/matcher');

/**
 * Four positions cut verbatim out of the live response captured on 2026-08-05
 * by `node tools/sniff.js nvidia`. Chosen for their location shapes: one
 * abroad, one open in two Israeli cities, one in a single Israeli city, and one
 * open across two US states.
 */
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nvidia-jobs.json'), 'utf8'));
const HOST = 'jobs.nvidia.com';

const byId = (id) => FIXTURE.positions.find((p) => p.id === id);

test('maps a real position', () => {
    const job = mapEightfoldJob(byId(893396868956), HOST);

    assert.equal(job.externalId, '893396868956');
    assert.equal(job.title, 'Senior Firmware Core Engineer');
    assert.equal(job.location, 'Israel, Yokneam');
    // NVIDIA files firmware roles under "Engineer, Sys SW", not the
    // "Engineer, Firmware" you'd expect from the title. Read the payload.
    assert.equal(job.department, 'Engineer, Sys SW');
    assert.equal(job.jobCode, 'JR2022515');
});

test('builds the apply URL from the host and positionUrl', () => {
    const job = mapEightfoldJob(byId(893396868956), HOST);
    assert.equal(job.applyUrl, 'https://jobs.nvidia.com/careers/job/893396868956');
});

test('keeps every office a position is open in', () => {
    // JR2022200 is open in Yokneam and Tel Aviv. Dropping one would hide the
    // job from whichever city filter you happened to pick.
    const job = mapEightfoldJob(byId(893396868930), HOST);
    assert.equal(job.location, 'Israel, Yokneam · Israel, Tel Aviv');
});

test('converts the unix timestamp to a date', () => {
    const job = mapEightfoldJob(byId(893396352447), HOST);
    assert.match(job.postedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test('throws rather than inventing an id', () => {
    const { id, ...noId } = byId(893396352447);
    assert.throws(() => mapEightfoldJob(noId, HOST), /no id/);
});

test('leaves employmentType null instead of reusing the work arrangement', () => {
    // The payload carries workLocationOption: "onsite". That is where you sit,
    // not whether the job is full time — putting it in the employment filter
    // would be a confident wrong answer.
    for (const raw of FIXTURE.positions) {
        assert.equal(mapEightfoldJob(raw, HOST).employmentType, null);
    }
});

test('never emits an experience level outside the vocabulary', () => {
    for (const raw of FIXTURE.positions) {
        const level = mapEightfoldJob(raw, HOST).experienceLevel;
        assert.ok(level === null || EXPERIENCE_LEVELS.includes(level), `bad level "${level}"`);
    }
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const raw of FIXTURE.positions) {
        const job = mapEightfoldJob(raw, HOST);
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

// ---------------------------------------------------------------------------
// The client-side location guard
// ---------------------------------------------------------------------------

test('keeps Israeli jobs and drops the rest', () => {
    const adapter = new EightfoldAdapter({ host: HOST, domain: 'nvidia.com', location: 'Israel' });
    const kept = FIXTURE.positions
        .map((raw) => mapEightfoldJob(raw, HOST))
        .filter((job) => adapter.matchesLocation(job));

    assert.equal(kept.length, 2);
    assert.ok(kept.every((job) => job.location.includes('Israel')));
});

test('a city filter still matches a multi-office job', () => {
    const adapter = new EightfoldAdapter({ host: HOST, domain: 'nvidia.com', location: 'Tel Aviv' });
    const job = mapEightfoldJob(byId(893396868930), HOST); // Yokneam + Tel Aviv
    assert.equal(adapter.matchesLocation(job), true);
});

test('no location configured means keep everything', () => {
    const adapter = new EightfoldAdapter({ host: HOST, domain: 'nvidia.com' });
    for (const raw of FIXTURE.positions) {
        assert.equal(adapter.matchesLocation(mapEightfoldJob(raw, HOST)), true);
    }
});

// ---------------------------------------------------------------------------
// URL building — this is a platform adapter, so the host must not be baked in
// ---------------------------------------------------------------------------

test('builds the search URL from config, not constants', () => {
    const adapter = new EightfoldAdapter({ host: HOST, domain: 'nvidia.com', location: 'Israel' });
    const url = new URL(adapter.buildUrl(0));

    assert.equal(url.host, 'jobs.nvidia.com');
    assert.equal(url.pathname, '/api/pcsx/search');
    assert.equal(url.searchParams.get('domain'), 'nvidia.com');
    assert.equal(url.searchParams.get('location'), 'Israel');
    assert.equal(url.searchParams.get('start'), '0');
});

test('another tenant is configuration, not a new file', () => {
    const adapter = new EightfoldAdapter({
        host: 'careers.example.com',
        domain: 'example.com',
        apiPath: '/api/apply/v2/jobs',
    });
    const url = new URL(adapter.buildUrl(40));

    assert.equal(url.host, 'careers.example.com');
    assert.equal(url.pathname, '/api/apply/v2/jobs');
    assert.equal(url.searchParams.get('start'), '40');
});

// ---------------------------------------------------------------------------
// The seam with the matcher
// ---------------------------------------------------------------------------

test('a parsed job survives a Yokneam profile', () => {
    const job = mapEightfoldJob(byId(893396868930), HOST);
    assert.equal(matches(job, { keywords: 'firmware', location_filter: 'Yokneam' }), true);
    assert.equal(matches(job, { keywords: 'firmware', location_filter: 'Haifa' }), false);
});
