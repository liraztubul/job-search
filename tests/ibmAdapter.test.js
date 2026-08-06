const test = require('node:test');
const assert = require('node:assert');
const { mapIbmJob } = require('../server/adapters/ibmAdapter');
const { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS } = require('../server/domain/vocabulary');
const { matches } = require('../server/domain/matcher');

/**
 * Real search hits cut verbatim out of https://www-api.ibm.com/search/api/v2
 * on 2026-08-06 (`node tools/sniff.js ibm`, then the site's own POST body
 * replayed directly — see server/adapters/ibmAdapter.js for how that URL and
 * request body were found). Trimmed to the _source fields the mapper reads.
 */
const PROFESSIONAL_HIT = {
    _id: 'fad40638b810ba1c594461532cccc4367b9648ed6a56453214e3dc67b6e2f349',
    _source: {
        url: 'https://careers.ibm.com/careers/JobDetail?jobId=113190',
        title: 'Deputy Manager - PROCURE TO PAY',
        field_keyword_05: 'India',
        field_keyword_08: 'Enterprise Operations',
        field_keyword_18: 'Professional',
        field_keyword_19: 'Chennai, IN',
    },
};

const INTERNSHIP_HIT = {
    _id: '3344ab93b9448b76a25f3905a7a5975243ea3501033eedc193d65187b34f6449',
    _source: {
        url: 'https://careers.ibm.com/careers/JobDetail?jobId=126608',
        title: 'IBM Internship Junior DevOps Engineer',
        field_keyword_05: 'Lithuania',
        field_keyword_08: 'Software Engineering',
        field_keyword_18: 'Internship',
        field_keyword_19: 'Vilnius, LT',
    },
};

test('maps a real search hit into RawJob', () => {
    const job = mapIbmJob(PROFESSIONAL_HIT);

    assert.equal(job.externalId, '113190');
    assert.equal(job.title, 'Deputy Manager - PROCURE TO PAY');
    assert.equal(job.location, 'Chennai, IN');
    assert.equal(job.department, 'Enterprise Operations');
    assert.equal(job.applyUrl, 'https://careers.ibm.com/careers/JobDetail?jobId=113190');
});

test('the requisition id comes from the jobId query param, not the ES hash', () => {
    // The ES _id is opaque and changes on reindex; jobId is what the site
    // itself, and a human reading the URL, treat as the job's identity.
    assert.equal(mapIbmJob(PROFESSIONAL_HIT).externalId, '113190');
    assert.notEqual(mapIbmJob(PROFESSIONAL_HIT).externalId, PROFESSIONAL_HIT._id);
});

test('falls back to the ES id when the url has no jobId', () => {
    const hit = { _id: 'fallback-hash', _source: { ...PROFESSIONAL_HIT._source, url: 'https://careers.ibm.com/careers/' } };
    assert.equal(mapIbmJob(hit).externalId, 'fallback-hash');
});

test('throws rather than inventing an id', () => {
    const hit = { _id: '', _source: { ...PROFESSIONAL_HIT._source, url: '' } };
    assert.throws(() => mapIbmJob(hit), /no usable id/);
});

test('reads the career track into both employmentType and experienceLevel', () => {
    const job = mapIbmJob(INTERNSHIP_HIT);
    assert.equal(job.employmentType, 'internship');
    assert.equal(job.experienceLevel, 'intern');
});

test('a Professional track job gets no employmentType guess, but may infer seniority from the title', () => {
    const job = mapIbmJob(PROFESSIONAL_HIT);
    assert.equal(job.employmentType, null);
});

test('never emits values outside the closed vocabularies', () => {
    for (const hit of [PROFESSIONAL_HIT, INTERNSHIP_HIT]) {
        const job = mapIbmJob(hit);
        assert.ok(job.employmentType === null || EMPLOYMENT_TYPES.includes(job.employmentType));
        assert.ok(job.experienceLevel === null || EXPERIENCE_LEVELS.includes(job.experienceLevel));
    }
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const hit of [PROFESSIONAL_HIT, INTERNSHIP_HIT]) {
        const job = mapIbmJob(hit);
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

test('a parsed job survives a Chennai profile', () => {
    const job = mapIbmJob(PROFESSIONAL_HIT);
    assert.equal(matches(job, { keywords: 'procure,manager', location_filter: 'Chennai' }), true);
    assert.equal(matches(job, { keywords: 'procure,manager', location_filter: 'Vilnius' }), false);
});
