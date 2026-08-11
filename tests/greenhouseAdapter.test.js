const test = require('node:test');
const assert = require('node:assert');
const { GreenhouseAdapter, mapGreenhouseJob, matchesLocation } = require('../server/adapters/greenhouseAdapter');
const { matches } = require('../server/domain/matcher');

/**
 * Two postings cut verbatim out of a real response captured 2026-08-11
 * (GET https://boards-api.greenhouse.io/v1/boards/riskified/jobs).
 */
const TEL_AVIV_JOB = {
    absolute_url: 'https://www.riskified.com/careers/job-description/?gh_jid=8487227002',
    internal_job_id: 6390154002,
    location: { name: 'Tel Aviv' },
    id: 8487227002,
    updated_at: '2026-08-04T05:52:03-04:00',
    requisition_id: '6390154002',
    title: 'Data Science Team Lead ',
    company_name: 'Riskified',
    first_published: '2026-04-20T09:45:52-04:00',
    language: 'en',
};

const NEW_YORK_JOB = {
    absolute_url: 'https://www.riskified.com/careers/job-description/?gh_jid=8541108002',
    internal_job_id: 6411146002,
    location: { name: 'New York' },
    id: 8541108002,
    updated_at: '2026-07-28T07:46:29-04:00',
    requisition_id: '6411146002',
    title: 'Corporate & Securities Counsel',
    company_name: 'Riskified',
    first_published: '2026-05-11T17:01:44-04:00',
    language: 'en',
};

test('maps a real posting into RawJob', () => {
    const job = mapGreenhouseJob(TEL_AVIV_JOB);

    assert.equal(job.externalId, '8487227002');
    // The trailing space Greenhouse's own title carries is trimmed.
    assert.equal(job.title, 'Data Science Team Lead');
    assert.equal(job.location, 'Tel Aviv');
    assert.equal(job.applyUrl, 'https://www.riskified.com/careers/job-description/?gh_jid=8487227002');
    assert.equal(job.postedAt, '2026-04-20');
});

test('throws rather than inventing an id', () => {
    const { id, ...noId } = TEL_AVIV_JOB;
    assert.throws(() => mapGreenhouseJob(noId), /no id/);
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const job of [mapGreenhouseJob(TEL_AVIV_JOB), mapGreenhouseJob(NEW_YORK_JOB)]) {
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

// ---------------------------------------------------------------------------
// Location matching — an explicit filter, or the site's own Israel whitelist
// ---------------------------------------------------------------------------

test('an explicit location filter is a case-insensitive substring match', () => {
    assert.equal(matchesLocation('Tel Aviv', 'tel aviv'), true);
    assert.equal(matchesLocation('New York', 'tel aviv'), false);
});

test('with no filter configured, falls back to the site-wide Israeli location whitelist', () => {
    assert.equal(matchesLocation('Tel Aviv', ''), true);
    assert.equal(matchesLocation('Herzliya', ''), true);
    assert.equal(matchesLocation('New York', ''), false);
});

test('the configured adapter location filters Tel Aviv in and New York out', () => {
    const adapter = new GreenhouseAdapter({ boardToken: 'riskified', location: 'Tel Aviv' });
    assert.equal(matchesLocation(TEL_AVIV_JOB.location.name, adapter.location), true);
    assert.equal(matchesLocation(NEW_YORK_JOB.location.name, adapter.location), false);
});

// ---------------------------------------------------------------------------
// URL building — this is a platform adapter, so the board must not be baked in
// ---------------------------------------------------------------------------

test('builds the board URL from config, not a constant', () => {
    const adapter = new GreenhouseAdapter({ boardToken: 'riskified' });
    assert.equal(adapter.boardUrl, 'https://boards-api.greenhouse.io/v1/boards/riskified/jobs');
});

test('another Greenhouse board is configuration, not a new file', () => {
    const adapter = new GreenhouseAdapter({ boardToken: 'some-other-company' });
    assert.equal(adapter.boardUrl, 'https://boards-api.greenhouse.io/v1/boards/some-other-company/jobs');
});

// ---------------------------------------------------------------------------
// The seam with the matcher
// ---------------------------------------------------------------------------

test('a parsed job survives a Tel Aviv profile', () => {
    const job = mapGreenhouseJob(TEL_AVIV_JOB);
    assert.equal(matches(job, { keywords: 'data,science', location_filter: 'Tel Aviv' }), true);
    assert.equal(matches(job, { keywords: 'data,science', location_filter: 'New York' }), false);
});
