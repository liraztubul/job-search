const test = require('node:test');
const assert = require('node:assert');
const { SmartRecruitersAdapter, mapSmartRecruitersJob, matchesLocation } = require('../server/adapters/smartRecruitersAdapter');
const { matches } = require('../server/domain/matcher');

/**
 * One posting cut verbatim out of a real response captured 2026-08-11
 * (GET https://api.smartrecruiters.com/v1/companies/Syneron-Candela/postings).
 * Syneron-Candela had exactly one open posting at capture time, in the US —
 * there is no real Israel posting to fixture from this company right now,
 * so the Israel case below is a synthetic variant of the same shape.
 */
const US_JOB = {
    id: '743999667462885',
    name: 'Global Corporate Controller',
    refNumber: 'REF44W',
    company: { identifier: 'Syneron-Candela', name: 'Syneron- Candela' },
    releasedDate: '2018-03-16T11:32:36.000Z',
    location: {
        city: 'Wayland',
        region: 'MA',
        country: 'us',
        fullLocation: 'Wayland, MA, United States',
        remote: false,
    },
    function: { id: 'finance', label: 'Finance' },
    typeOfEmployment: { id: 'permanent', label: 'Full-time' },
    experienceLevel: { id: 'executive', label: 'Executive' },
};

const ISRAEL_JOB = {
    ...US_JOB,
    id: '999999999',
    name: 'R&D Team Lead',
    location: { city: 'Yokneam', country: 'il', fullLocation: 'Yokneam, Israel', remote: false },
    typeOfEmployment: { id: 'permanent', label: 'Full-time' },
    experienceLevel: { id: 'mid', label: 'Mid-Senior level' },
};

test('maps a real posting into RawJob', () => {
    const job = mapSmartRecruitersJob(US_JOB, 'Syneron-Candela');

    assert.equal(job.externalId, '743999667462885');
    assert.equal(job.title, 'Global Corporate Controller');
    assert.equal(job.location, 'Wayland, MA, United States');
    assert.equal(job.applyUrl, 'https://jobs.smartrecruiters.com/Syneron-Candela/743999667462885');
    assert.equal(job.employmentType, 'full-time');
    // Neither SmartRecruiters' own "Executive" label nor the title itself
    // matches the closed vocabulary's senior-signal words — null, not a guess.
    assert.equal(job.experienceLevel, null);
    assert.equal(job.postedAt, '2018-03-16');
});

test('throws rather than inventing an id', () => {
    const { id, ...noId } = US_JOB;
    assert.throws(() => mapSmartRecruitersJob(noId, 'Syneron-Candela'), /no id/);
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const job of [mapSmartRecruitersJob(US_JOB, 'Syneron-Candela'), mapSmartRecruitersJob(ISRAEL_JOB, 'Syneron-Candela')]) {
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

// ---------------------------------------------------------------------------
// Location matching — an explicit filter, or the site's own Israel whitelist
// ---------------------------------------------------------------------------

test('an explicit location filter is a case-insensitive substring match', () => {
    assert.equal(matchesLocation('Yokneam, Israel', 'israel'), true);
    assert.equal(matchesLocation('Wayland, MA, United States', 'israel'), false);
});

test('with no filter configured, falls back to the site-wide Israeli location whitelist', () => {
    assert.equal(matchesLocation('Yokneam, Israel', ''), true);
    assert.equal(matchesLocation('Wayland, MA, United States', ''), false);
});

// ---------------------------------------------------------------------------
// URL building — no slug needed, so this must not fetch a second time per job
// ---------------------------------------------------------------------------

test('builds an apply URL from company + id, no per-job lookup', () => {
    const job = mapSmartRecruitersJob(US_JOB, 'Syneron-Candela');
    assert.equal(job.applyUrl, 'https://jobs.smartrecruiters.com/Syneron-Candela/743999667462885');
});

test('builds the postings URL from config, not a constant', () => {
    const adapter = new SmartRecruitersAdapter({ companyIdentifier: 'Syneron-Candela' });
    assert.equal(adapter.postingsUrl, 'https://api.smartrecruiters.com/v1/companies/Syneron-Candela/postings?limit=100');
});

test('another SmartRecruiters company is configuration, not a new file', () => {
    const adapter = new SmartRecruitersAdapter({ companyIdentifier: 'some-other-company' });
    assert.equal(adapter.postingsUrl, 'https://api.smartrecruiters.com/v1/companies/some-other-company/postings?limit=100');
});

// ---------------------------------------------------------------------------
// The seam with the matcher
// ---------------------------------------------------------------------------

test('a parsed job survives a Yokneam profile', () => {
    const job = mapSmartRecruitersJob(ISRAEL_JOB, 'Syneron-Candela');
    assert.equal(matches(job, { keywords: 'r&d,team', location_filter: 'Yokneam' }), true);
    assert.equal(matches(job, { keywords: 'r&d,team', location_filter: 'Wayland' }), false);
});
