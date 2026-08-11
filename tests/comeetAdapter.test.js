const test = require('node:test');
const assert = require('node:assert');
const { ComeetAdapter, mapComeetJob, comeetLocationText } = require('../server/adapters/comeetAdapter');
const { matches } = require('../server/domain/matcher');

/**
 * Two postings cut verbatim out of a real response captured 2026-08-11
 * (GET https://www.comeet.com/careers-api/2.0/company/A1.00C/positions?token=...).
 */
const YOKNEAM_JOB = {
    name: 'Assistant Controller- EMEA',
    department: 'Finance',
    location: {
        name: 'Lumenis HQ - Yokneam',
        country: 'IL',
        city: "Yokne'am Illit",
        state: 'North District',
    },
    url_comeet_hosted_page: 'https://www.comeet.com/jobs/lumenis/A1.00C/assistant-controller--emea/2E.C6E',
    employment_type: 'Full-time',
    experience_level: 'Intermediate',
    uid: '2E.C6E',
    time_updated: '2026-08-09T08:38:12Z',
};

// A multi-office posting: Comeet returns one array entry per office, the base
// uid suffixed with the office's own location_uid — not one job with a list.
const UK_JOB = {
    name: 'Business Development Manager',
    department: 'Sales',
    location: { name: 'United Kingdom', country: 'GB', city: 'England', state: 'England' },
    url_comeet_hosted_page: 'https://www.comeet.com/jobs/lumenis/A1.00C/business-development-manager/C5.F67-51.308',
    employment_type: 'Full-time',
    experience_level: 'Senior',
    uid: 'C5.F67-51.308',
    time_updated: '2026-08-01T00:00:00Z',
};

test('maps a real posting into RawJob', () => {
    const job = mapComeetJob(YOKNEAM_JOB);

    assert.equal(job.externalId, '2E.C6E');
    assert.equal(job.title, 'Assistant Controller- EMEA');
    assert.equal(job.location, "Yokne'am Illit, IL");
    assert.equal(job.applyUrl, YOKNEAM_JOB.url_comeet_hosted_page);
    assert.equal(job.employmentType, 'full-time');
    assert.equal(job.experienceLevel, 'mid');
    assert.equal(job.postedAt, '2026-08-09');
});

test('throws rather than inventing an id', () => {
    const { uid, ...noUid } = YOKNEAM_JOB;
    assert.throws(() => mapComeetJob(noUid), /no uid/);
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const job of [mapComeetJob(YOKNEAM_JOB), mapComeetJob(UK_JOB)]) {
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

// ---------------------------------------------------------------------------
// Location matching — an explicit filter, or the site's own Israel whitelist
// ---------------------------------------------------------------------------

test('comeetLocationText joins city and country, skipping the vague office name', () => {
    assert.equal(comeetLocationText(YOKNEAM_JOB.location), "Yokne'am Illit, IL");
    assert.equal(comeetLocationText(null), '');
});

test('with no filter configured, falls back to the site-wide Israeli location whitelist', () => {
    const adapter = new ComeetAdapter({ companyUid: 'A1.00C', token: 'x' });
    assert.equal(adapter.matchesLocation(YOKNEAM_JOB.location), true);
    assert.equal(adapter.matchesLocation(UK_JOB.location), false);
});

test('an explicit location filter is a case-insensitive substring match', () => {
    const adapter = new ComeetAdapter({ companyUid: 'A1.00C', token: 'x', location: "Yokne'am" });
    assert.equal(adapter.matchesLocation(YOKNEAM_JOB.location), true);
    assert.equal(adapter.matchesLocation(UK_JOB.location), false);
});

// ---------------------------------------------------------------------------
// URL building — the token has to travel with the uid, not be baked in
// ---------------------------------------------------------------------------

test('builds the positions URL from config, not constants', () => {
    const adapter = new ComeetAdapter({ companyUid: 'A1.00C', token: 'abc123' });
    assert.equal(adapter.positionsUrl, 'https://www.comeet.com/careers-api/2.0/company/A1.00C/positions?token=abc123');
});

test('another Comeet company is configuration, not a new file', () => {
    const adapter = new ComeetAdapter({ companyUid: 'Z9.999', token: 'zzz' });
    assert.equal(adapter.positionsUrl, 'https://www.comeet.com/careers-api/2.0/company/Z9.999/positions?token=zzz');
});

// ---------------------------------------------------------------------------
// The seam with the matcher
// ---------------------------------------------------------------------------

test('a parsed job survives a Yokneam profile', () => {
    const job = mapComeetJob(YOKNEAM_JOB);
    assert.equal(matches(job, { keywords: 'controller,finance', location_filter: "Yokne'am" }), true);
    assert.equal(matches(job, { keywords: 'controller,finance', location_filter: 'London' }), false);
});
