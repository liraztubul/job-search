const test = require('node:test');
const assert = require('node:assert');
const { AshbyAdapter, mapAshbyJob } = require('../server/adapters/ashbyAdapter');
const { EMPLOYMENT_TYPES } = require('../server/domain/vocabulary');
const { matches } = require('../server/domain/matcher');

/**
 * Two postings cut verbatim out of a real response captured 2026-08-06
 * (GET https://api.ashbyhq.com/posting-api/job-board/monday.com). Trimmed to
 * drop descriptionHtml/descriptionPlain — huge, and the mapper never reads them.
 */
const TEL_AVIV_JOB = {
    id: '6b945ea6-f095-42b4-a83d-b9b5f407feae',
    title: 'DevOps Tech Lead (BigBrain)',
    department: 'Information Technology & Data',
    employmentType: 'FullTime',
    location: 'Tel Aviv',
    secondaryLocations: [],
    publishedAt: '2026-08-03T10:12:57.014+00:00',
    isListed: true,
    address: {
        postalAddress: { addressCountry: 'Israel', addressLocality: 'Tel Aviv' },
    },
    jobUrl: 'https://jobs.ashbyhq.com/monday.com/6b945ea6-f095-42b4-a83d-b9b5f407feae',
    applyUrl: 'https://jobs.ashbyhq.com/monday.com/6b945ea6-f095-42b4-a83d-b9b5f407feae/application',
};

// Open in New York *and* Atlanta — both US, no Israel presence at all.
const MULTI_LOCATION_JOB = {
    id: '76c72596-b10c-463b-ae59-b585787b30ae',
    title: 'Senior Compensation Manager',
    department: 'Total Rewards & People Technologies',
    employmentType: 'FullTime',
    location: 'New York',
    secondaryLocations: [{ location: 'Atlanta', address: { postalAddress: { addressCountry: 'United States', addressLocality: 'Atlanta' } } }],
    publishedAt: '2026-07-30T19:53:21.509+00:00',
    isListed: true,
    address: {
        postalAddress: { addressCountry: 'United States', addressLocality: 'New York' },
    },
    jobUrl: 'https://jobs.ashbyhq.com/monday.com/76c72596-b10c-463b-ae59-b585787b30ae',
    applyUrl: 'https://jobs.ashbyhq.com/monday.com/76c72596-b10c-463b-ae59-b585787b30ae/application',
};

test('maps a real posting into RawJob', () => {
    const job = mapAshbyJob(TEL_AVIV_JOB);

    assert.equal(job.externalId, '6b945ea6-f095-42b4-a83d-b9b5f407feae');
    assert.equal(job.title, 'DevOps Tech Lead (BigBrain)');
    assert.equal(job.location, 'Tel Aviv');
    assert.equal(job.department, 'Information Technology & Data');
    assert.equal(job.employmentType, 'full-time');
    assert.equal(job.postedAt, '2026-08-03');
    assert.equal(job.applyUrl, 'https://jobs.ashbyhq.com/monday.com/6b945ea6-f095-42b4-a83d-b9b5f407feae');
});

test('joins secondary locations into the location string', () => {
    const job = mapAshbyJob(MULTI_LOCATION_JOB);
    assert.equal(job.location, 'New York · Atlanta');
});

test('throws rather than inventing an id', () => {
    const { id, ...noId } = TEL_AVIV_JOB;
    assert.throws(() => mapAshbyJob(noId), /no id/);
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const job of [mapAshbyJob(TEL_AVIV_JOB), mapAshbyJob(MULTI_LOCATION_JOB)]) {
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

test('never emits an employment type outside the vocabulary', () => {
    for (const job of [mapAshbyJob(TEL_AVIV_JOB), mapAshbyJob(MULTI_LOCATION_JOB)]) {
        assert.ok(job.employmentType === null || EMPLOYMENT_TYPES.includes(job.employmentType));
    }
});

// ---------------------------------------------------------------------------
// The country guard — mirrors Oracle HCM's: a job open in several countries
// keeps every one of them so the filter can't be fooled by a partial match.
// ---------------------------------------------------------------------------

test('keeps a job whose primary or secondary location matches the country', () => {
    const adapter = new AshbyAdapter({ boardName: 'monday.com', country: 'Israel' });
    assert.equal(adapter.matchesCountry(mapAshbyJob(TEL_AVIV_JOB)), true);
    assert.equal(adapter.matchesCountry(mapAshbyJob(MULTI_LOCATION_JOB)), false);
});

test('no country configured means keep everything', () => {
    const adapter = new AshbyAdapter({ boardName: 'monday.com' });
    assert.equal(adapter.matchesCountry(mapAshbyJob(TEL_AVIV_JOB)), true);
    assert.equal(adapter.matchesCountry(mapAshbyJob(MULTI_LOCATION_JOB)), true);
});

// ---------------------------------------------------------------------------
// URL building — this is a platform adapter, so the board must not be baked in
// ---------------------------------------------------------------------------

test('builds the board URL from config, not a constant', () => {
    const adapter = new AshbyAdapter({ boardName: 'monday.com' });
    assert.equal(adapter.boardUrl, 'https://api.ashbyhq.com/posting-api/job-board/monday.com');
});

test('another Ashby board is configuration, not a new file', () => {
    const adapter = new AshbyAdapter({ boardName: 'some-other-company' });
    assert.equal(adapter.boardUrl, 'https://api.ashbyhq.com/posting-api/job-board/some-other-company');
});

// ---------------------------------------------------------------------------
// The seam with the matcher
// ---------------------------------------------------------------------------

test('a parsed job survives a Tel Aviv profile', () => {
    const job = mapAshbyJob(TEL_AVIV_JOB);
    assert.equal(matches(job, { keywords: 'devops,tech lead', location_filter: 'Tel Aviv' }), true);
    assert.equal(matches(job, { keywords: 'devops,tech lead', location_filter: 'Atlanta' }), false);
});
