const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseCheckpointJobs } = require('../server/adapters/checkpointAdapter');
const { EXPERIENCE_LEVELS } = require('../server/domain/vocabulary');
const { matches } = require('../server/domain/matcher');

/**
 * Five job cards cut verbatim out of a real page fetched 2026-08-06
 * (careers.checkpoint.com, filtered to fa[]=country_s:Israel). Not hand-written.
 */
const fixture = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'checkpoint-jobs.html'), 'utf8');

test('parses jobs out of the real page', () => {
    const jobs = parseCheckpointJobs(fixture());
    assert.equal(jobs.length, 5);
});

test('fills every field the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const job of parseCheckpointJobs(fixture())) {
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
        assert.ok(job.location, `missing location on ${job.title}`);
        assert.match(job.applyUrl, /^https:\/\/careers\.checkpoint\.com\/index\.php\?m=cpcareers&a=show&joborderid=\d+$/);
    }
});

test('reads a known job correctly', () => {
    const jobs = parseCheckpointJobs(fixture());
    const job = jobs.find((j) => j.externalId === '8038542');

    assert.ok(job, 'AI Acceleration Group Manager not found');
    assert.equal(job.title, 'AI Acceleration Group Manager');
    assert.equal(job.location, 'Israel: Tel Aviv/ Hybrid (Israel)');
    assert.equal(job.department, 'R&D');
});

test('decodes the ampersand in the R&D department label', () => {
    for (const job of parseCheckpointJobs(fixture())) {
        assert.equal(job.department, 'R&D');
    }
});

test('the requisition id is the id, and cards are not double counted', () => {
    const jobs = parseCheckpointJobs(fixture());
    const ids = jobs.map((j) => j.externalId);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^\d+$/);
});

test('never emits an experience level outside the vocabulary', () => {
    for (const job of parseCheckpointJobs(fixture())) {
        assert.ok(job.experienceLevel === null || EXPERIENCE_LEVELS.includes(job.experienceLevel));
    }
});

test('a parsed job matches a Tel Aviv profile', () => {
    const job = parseCheckpointJobs(fixture()).find((j) => j.externalId === '9294179');
    assert.equal(matches(job, { keywords: 'data,engineering', location_filter: 'Tel Aviv' }), true);
    assert.equal(matches(job, { keywords: 'data,engineering', location_filter: 'Haifa' }), false);
});
