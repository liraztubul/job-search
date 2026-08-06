const test = require('node:test');
const assert = require('node:assert');
const { mapManualJob, parseManualJobs, ManualAdapter } = require('../server/adapters/manualAdapter');
const { EMPLOYMENT_TYPES } = require('../server/domain/vocabulary');
const { matches } = require('../server/domain/matcher');

const ENTRY = {
    externalId: 'RAF-1001',
    title: 'מהנדס.ת תוכנה בכיר.ה',
    applyUrl: 'https://career.rafael.co.il/',
    location: 'Haifa',
    department: 'R&D',
    employmentType: 'Full time',
    postedAt: '2026-08-01',
    jobCode: 'REQ-88',
};

const file = (rows) => JSON.stringify(rows);

test('maps a hand-written entry into a RawJob', () => {
    const job = mapManualJob(ENTRY, 0);

    assert.equal(job.externalId, 'RAF-1001');
    assert.equal(job.location, 'Haifa');
    assert.equal(job.employmentType, 'full-time');
    assert.equal(job.jobCode, 'REQ-88');
    assert.equal(job.postedAt, '2026-08-01');
});

test('reads Hebrew seniority the same as every other adapter', () => {
    assert.equal(mapManualJob(ENTRY, 0).experienceLevel, 'senior');
});

test('normalizes employment type instead of storing free text', () => {
    for (const wording of ['Full time', 'full-time', 'Part Time', 'Contractor']) {
        const job = mapManualJob({ ...ENTRY, employmentType: wording }, 0);
        assert.ok(EMPLOYMENT_TYPES.includes(job.employmentType), `${wording} -> ${job.employmentType}`);
    }
});

// ---------------------------------------------------------------------------
// Errors have to name the entry — this file is edited by hand
// ---------------------------------------------------------------------------

test('a missing required field says which entry', () => {
    assert.throws(() => parseManualJobs(file([ENTRY, { title: 'x', applyUrl: 'y' }])), /entry 2.*externalId/);
    assert.throws(() => parseManualJobs(file([{ externalId: 'A', applyUrl: 'y' }])), /entry 1 \(A\).*title/);
    assert.throws(() => parseManualJobs(file([{ externalId: 'A', title: 'B' }])), /entry 1 \(B\).*applyUrl/);
});

test('a trailing comma is reported as bad JSON, not a crash', () => {
    assert.throws(() => parseManualJobs('[{"externalId":"A"},]', 'rafael.json'), /rafael\.json is not valid JSON/);
});

test('an object instead of an array is caught', () => {
    assert.throws(() => parseManualJobs('{"externalId":"A"}', 'rafael.json'), /must contain a JSON array/);
});

test('duplicate ids are refused rather than silently overwriting', () => {
    // Without this, the second entry wins on every cycle and the first job is
    // permanently invisible — with no error to explain why.
    assert.throws(
        () => parseManualJobs(file([ENTRY, { ...ENTRY, title: 'Something else' }]), 'rafael.json'),
        /two entries with externalId "RAF-1001"/
    );
});

// ---------------------------------------------------------------------------
// The file name is config, so it must not be able to escape the folder
// ---------------------------------------------------------------------------

test('a path in the file name cannot reach outside data/manual', () => {
    const adapter = new ManualAdapter({ file: '../../server/data/schema' });
    assert.match(adapter.filePath, /data[\\/]manual[\\/]schema\.json$/);
});

test('a .json suffix in config is tolerated', () => {
    assert.equal(new ManualAdapter({ file: 'rafael.json' }).file, 'rafael');
});

// ---------------------------------------------------------------------------
// The seam with the rest of the system
// ---------------------------------------------------------------------------

test('a manual job survives the matcher like any other', () => {
    const job = mapManualJob(ENTRY, 0);
    assert.equal(matches(job, { keywords: 'מהנדס', location_filter: 'Haifa' }), true);
    assert.equal(matches(job, { keywords: 'מהנדס', location_filter: 'Tel Aviv' }), false);
});

test('emits every key the schema stores', () => {
    const job = mapManualJob(ENTRY, 0);
    for (const key of ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel']) {
        assert.ok(key in job, `missing "${key}"`);
    }
});
