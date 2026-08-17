const test = require('node:test');
const assert = require('node:assert');
const { mapAmazonJob, parseAmazonDate } = require('../server/adapters/amazonAdapter');

/**
 * Captured verbatim from https://www.amazon.jobs/search.json?country=ISR
 * on 2026-08-03. Trimmed to the fields the mapper reads — nothing renamed.
 *
 * If Amazon changes their shape, these tests keep passing (they test the mapper,
 * not the network) but `node server/main.js` will throw. That split is deliberate:
 * unit tests protect the mapping logic, the live run protects the contract.
 */
const REAL_JOB = {
    id: 'ff6a6c27-ee2c-4cbe-9cb1-66742b39057f',
    id_icims: '10490457',
    title: 'Supply Chain Planner',
    city: 'Haifa',
    country_code: 'ISR',
    location: 'IL, Haifa',
    normalized_location: 'Haifa, Haifa, ISR',
    job_path: '/en/jobs/10490457/supply-chain-planner',
    posted_date: 'August  3, 2026',
    company_name: 'Annapurna Labs Ltd.',
    job_category: 'Operations, IT, & Support Engineering',
};

test('maps a real Amazon job into RawJob', () => {
    const job = mapAmazonJob(REAL_JOB);

    assert.equal(job.externalId, '10490457');
    assert.equal(job.title, 'Supply Chain Planner');
    assert.equal(job.location, 'Haifa, Haifa, ISR');
    assert.equal(job.applyUrl, 'https://www.amazon.jobs/en/jobs/10490457/supply-chain-planner');
    // Parsed to a real ISO date, not the source's raw prose — posted_at is a
    // strict invariant (real date or null) enforced from the adapter up.
    assert.equal(job.postedAt, '2026-08-03');
});

test('parseAmazonDate: "August  3, 2026" (literal double space, as the real API sends it) -> "2026-08-03"', () => {
    assert.equal(parseAmazonDate('August  3, 2026'), '2026-08-03');
});

test('parseAmazonDate: a single space also works', () => {
    assert.equal(parseAmazonDate('August 3, 2026'), '2026-08-03');
});

test('parseAmazonDate: unrecognized text -> null, not a guess', () => {
    assert.equal(parseAmazonDate('recently'), null);
    assert.equal(parseAmazonDate(''), null);
    assert.equal(parseAmazonDate(null), null);
});

test('externalId is a string, so DB lookups stay type-stable', () => {
    const job = mapAmazonJob({ ...REAL_JOB, id_icims: 10490457 });
    assert.strictEqual(job.externalId, '10490457');
});

test('prefers the requisition number over the uuid', () => {
    // Both present: id_icims wins, because it is what appears in the job URL
    // and it survives edits to the posting.
    assert.equal(mapAmazonJob(REAL_JOB).externalId, '10490457');
});

test('falls back to the uuid when the requisition number is missing', () => {
    const { id_icims, ...withoutIcims } = REAL_JOB;
    assert.equal(mapAmazonJob(withoutIcims).externalId, REAL_JOB.id);
});

test('throws rather than inventing an id', () => {
    const { id, id_icims, ...noIds } = REAL_JOB;
    assert.throws(() => mapAmazonJob(noIds), /no usable id/);
});

test('builds a working apply URL when job_path is missing', () => {
    const { job_path, ...noPath } = REAL_JOB;
    assert.equal(mapAmazonJob(noPath).applyUrl, 'https://www.amazon.jobs/en/jobs/10490457');
});

test('location falls back through normalized -> location -> city', () => {
    const { normalized_location, ...noNormalized } = REAL_JOB;
    assert.equal(mapAmazonJob(noNormalized).location, 'IL, Haifa');

    const { location, ...noLocation } = noNormalized;
    assert.equal(mapAmazonJob(noLocation).location, 'Haifa');
});

test('a Haifa job survives a Haifa location_filter', () => {
    // The mapper and the matcher have to agree on what a location looks like.
    // This is the seam where they meet, so it gets a test.
    const { matches } = require('../server/domain/matcher');
    const job = mapAmazonJob(REAL_JOB);
    assert.equal(matches(job, { keywords: 'supply,chain', location_filter: 'Haifa' }), true);
});
