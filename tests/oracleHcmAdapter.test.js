const test = require('node:test');
const assert = require('node:assert');
const { OracleHcmAdapter, mapOracleJob } = require('../server/adapters/oracleHcmAdapter');
const { matches } = require('../server/domain/matcher');

/**
 * Two requisitions cut verbatim out of a real Dell response captured 2026-08-06
 * (recruitingCEJobRequisitions, siteNumber=CX_1, expand=requisitionList).
 * Trimmed to the fields the mapper reads — nothing renamed.
 */
const ISRAEL_JOB = {
    Id: '292332',
    Title: 'ML Ops Engineer',
    PostedDate: '2026-08-04',
    PrimaryLocationCountry: 'IL',
    PrimaryLocation: 'Herzliya, Tel Aviv, Israel',
    WorkplaceType: 'On-site',
    JobFamily: null,
    Organization: null,
    BusinessUnit: null,
};

const TAIWAN_JOB = {
    Id: 'R287877',
    Title: 'Hardware Engineer 2 (Project Management Team)',
    PostedDate: '2026-08-05',
    PrimaryLocationCountry: 'TW',
    PrimaryLocation: 'Taipei City, Taiwan',
    WorkplaceType: 'On-site',
    JobFamily: null,
    Organization: null,
    BusinessUnit: null,
};

const HOST = 'enterpriseplatform.dell.com';
const SITE = 'CX_1';

test('maps a real requisition into RawJob', () => {
    const job = mapOracleJob(ISRAEL_JOB, HOST, SITE);

    assert.equal(job.externalId, '292332');
    assert.equal(job.title, 'ML Ops Engineer');
    assert.equal(job.location, 'Herzliya, Tel Aviv, Israel');
    assert.equal(job.postedAt, '2026-08-04');
    assert.equal(job.applyUrl, 'https://enterpriseplatform.dell.com/hcmUI/CandidateExperience/en/sites/CX_1/job/292332');
});

test('the requisition id survives whether or not it carries the R prefix', () => {
    assert.equal(mapOracleJob(TAIWAN_JOB, HOST, SITE).externalId, 'R287877');
    assert.equal(mapOracleJob(ISRAEL_JOB, HOST, SITE).externalId, '292332');
});

test('throws rather than inventing an id', () => {
    const { Id, ...noId } = ISRAEL_JOB;
    assert.throws(() => mapOracleJob(noId, HOST, SITE), /no Id/);
});

test('leaves employmentType null instead of reusing the workplace arrangement', () => {
    // WorkplaceType ("On-site") is where you sit, not whether the job is full
    // time — same call the Eightfold adapter makes for workLocationOption.
    assert.equal(mapOracleJob(ISRAEL_JOB, HOST, SITE).employmentType, null);
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const job of [mapOracleJob(ISRAEL_JOB, HOST, SITE), mapOracleJob(TAIWAN_JOB, HOST, SITE)]) {
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

// ---------------------------------------------------------------------------
// The client-side country guard — Dell's own location facet only lists its
// top-N countries by count, and Israel doesn't make that cut despite having
// real open reqs. Filtering client-side against PrimaryLocationCountry is
// what makes those reqs visible at all.
// ---------------------------------------------------------------------------

test('keeps IL jobs and drops the rest', () => {
    const adapter = new OracleHcmAdapter({ host: HOST, siteNumber: SITE, country: 'IL' });
    const kept = [ISRAEL_JOB, TAIWAN_JOB].map((raw) => mapOracleJob(raw, HOST, SITE)).filter((job) => adapter.matchesCountry(job));

    assert.equal(kept.length, 1);
    assert.equal(kept[0].externalId, '292332');
});

test('no country configured means keep everything', () => {
    const adapter = new OracleHcmAdapter({ host: HOST, siteNumber: SITE });
    for (const raw of [ISRAEL_JOB, TAIWAN_JOB]) {
        assert.equal(adapter.matchesCountry(mapOracleJob(raw, HOST, SITE)), true);
    }
});

// ---------------------------------------------------------------------------
// URL building — this is a platform adapter, so the tenant must not be baked in
// ---------------------------------------------------------------------------

test('builds the search URL from config, not constants', () => {
    const adapter = new OracleHcmAdapter({ host: HOST, siteNumber: SITE, country: 'IL' });
    const url = new URL(adapter.buildUrl(0));

    assert.equal(url.host, HOST);
    assert.match(url.searchParams.get('finder'), /siteNumber=CX_1/);
    assert.match(url.searchParams.get('finder'), /offset=0/);
    assert.equal(url.searchParams.get('expand'), 'requisitionList');
});

test('another Oracle tenant is configuration, not a new file', () => {
    const adapter = new OracleHcmAdapter({ host: 'careers.example.com', siteNumber: 'EX_9' });
    const url = new URL(adapter.buildUrl(200));

    assert.equal(url.host, 'careers.example.com');
    assert.match(url.searchParams.get('finder'), /siteNumber=EX_9/);
    assert.match(url.searchParams.get('finder'), /offset=200/);
});

// ---------------------------------------------------------------------------
// The seam with the matcher
// ---------------------------------------------------------------------------

test('a parsed job survives a Herzliya profile', () => {
    const job = mapOracleJob(ISRAEL_JOB, HOST, SITE);
    assert.equal(matches(job, { keywords: 'ml,mlops', location_filter: 'Herzliya' }), true);
    assert.equal(matches(job, { keywords: 'ml,mlops', location_filter: 'Taipei' }), false);
});
