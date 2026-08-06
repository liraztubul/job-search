const test = require('node:test');
const assert = require('node:assert');
const { WorkdayAdapter, mapWorkdayJob, extractJobCode, descriptorMatchesCountry } = require('../server/adapters/workdayAdapter');
const { matches } = require('../server/domain/matcher');

/**
 * Three postings and one location-facet slice cut verbatim out of a real
 * Intel response captured 2026-08-06 (POST .../wday/cxs/intel/External/jobs).
 */
const HAIFA_JOB = {
    title: 'System Level Test Lead',
    externalPath: '/job/Israel-Haifa/System-Level-Test-Lead_JR0285893',
    locationsText: 'Israel, Haifa',
    postedOn: 'Posted Yesterday',
    bulletFields: ['JR0285893'],
};

const MULTI_LOCATION_JOB = {
    title: 'Wireless Connectivity System and Architecture Engineer',
    externalPath: '/job/Israel-Petah-Tikva/Wireless-Connectivity-System-and-Architecture-Engineer_JR0285825',
    locationsText: '2 Locations',
    postedOn: 'Posted Yesterday',
    bulletFields: ['JR0285825'],
};

// The URL slug carries a "-1" suffix (a repost) but the requisition code in
// bulletFields does not — the id has to come from the code, not the slug.
const RESLUGGED_JOB = {
    title: 'Logic Design Engineer',
    externalPath: '/job/Israel-Haifa/Logic-Design-Engineer_JR0283988-1',
    locationsText: 'Israel, Haifa',
    postedOn: 'Posted Yesterday',
    bulletFields: ['JR0283988'],
};

const FACETS = [
    {
        facetParameter: 'locationMainGroup',
        values: [
            {
                facetParameter: 'locations',
                values: [
                    { descriptor: 'India, Bangalore', id: '1e4a4eb3adf101f44070f976bf8184cf', count: 59 },
                    { descriptor: 'Israel, Haifa', id: '1e4a4eb3adf1013563ba9174bf817fcd', count: 26 },
                    { descriptor: 'Israel, Kiryat-Gat', id: '1e4a4eb3adf101cb242c9e74bf8189cd', count: 3 },
                    { descriptor: 'Israel, Petah-Tikva', id: '1e4a4eb3adf101aaeda8a474bf818ecd', count: 14 },
                    { descriptor: 'Japan, Tokyo', id: '1e4a4eb3adf1017e01a9cd74bf81b1cd', count: 9 },
                ],
            },
        ],
    },
];

const HOST = 'intel.wd1.myworkdayjobs.com';
const SITE = 'External';

test('maps a real posting into RawJob', () => {
    const job = mapWorkdayJob(HAIFA_JOB, HOST, SITE, 'en-US');

    assert.equal(job.externalId, 'JR0285893');
    assert.equal(job.title, 'System Level Test Lead');
    assert.equal(job.location, 'Israel, Haifa');
    assert.equal(job.postedAt, 'Posted Yesterday');
    assert.equal(
        job.applyUrl,
        'https://intel.wd1.myworkdayjobs.com/en-US/External/job/Israel-Haifa/System-Level-Test-Lead_JR0285893'
    );
});

test('extractJobCode reads the requisition number, not the URL slug', () => {
    assert.equal(extractJobCode(['JR0285893']), 'JR0285893');
    assert.equal(extractJobCode(['Spotlight Job', 'JR0281513']), 'JR0281513');
    assert.equal(extractJobCode([]), null);
    assert.equal(extractJobCode(undefined), null);
});

test('extractJobCode also reads a dash-separated code (Palo Alto Networks: "JR-020840")', () => {
    // Found the hard way: this tenant's bulletFields didn't match the
    // no-separator pattern, so every PANW job fell through to the raw
    // externalPath as its displayed "job number" instead of a real code.
    assert.equal(extractJobCode(['JR-020840']), 'JR-020840');
});

test('a resluggged repost keeps the requisition code as its id, not the "-1" slug', () => {
    const job = mapWorkdayJob(RESLUGGED_JOB, HOST, SITE, 'en-US');
    assert.equal(job.externalId, 'JR0283988');
    assert.match(job.applyUrl, /_JR0283988-1$/);
});

test('falls back to the URL path when there is no requisition code', () => {
    const { bulletFields, ...noCode } = HAIFA_JOB;
    const job = mapWorkdayJob({ ...noCode, bulletFields: [] }, HOST, SITE, 'en-US');
    assert.equal(job.externalId, HAIFA_JOB.externalPath);
});

test('throws rather than inventing an id', () => {
    assert.throws(() => mapWorkdayJob({ title: 'x', bulletFields: [] }, HOST, SITE, 'en-US'), /no usable id/);
});

test('leaves employmentType null — Workday does not publish it on the list payload', () => {
    assert.equal(mapWorkdayJob(HAIFA_JOB, HOST, SITE, 'en-US').employmentType, null);
});

test('a job open in more than one office keeps the vague "N Locations" text as-is', () => {
    // Getting the real per-office breakdown means fetching the job's own detail
    // page — not worth turning one request per page into one per job.
    const job = mapWorkdayJob(MULTI_LOCATION_JOB, HOST, SITE, 'en-US');
    assert.equal(job.location, '2 Locations');
});

test('every job emits the keys the schema stores', () => {
    const required = ['externalId', 'title', 'location', 'applyUrl', 'employmentType', 'experienceLevel'];
    for (const posting of [HAIFA_JOB, MULTI_LOCATION_JOB, RESLUGGED_JOB]) {
        const job = mapWorkdayJob(posting, HOST, SITE, 'en-US');
        for (const key of required) assert.ok(key in job, `${job.title} is missing "${key}"`);
    }
});

// ---------------------------------------------------------------------------
// Location facet resolution — this is the seam that makes filtering possible;
// there is no plain "country=Israel" query parameter on this API.
// ---------------------------------------------------------------------------

test('resolves every location under a country to its facet ids', () => {
    const group = FACETS[0].values.find((v) => v.facetParameter === 'locations').values;
    const ids = group.filter((v) => descriptorMatchesCountry(v.descriptor, 'Israel')).map((v) => v.id);

    assert.deepEqual(ids, [
        '1e4a4eb3adf1013563ba9174bf817fcd',
        '1e4a4eb3adf101cb242c9e74bf8189cd',
        '1e4a4eb3adf101aaeda8a474bf818ecd',
    ]);
});

test('country matching survives a comma-delimited descriptor (Intel: "Israel, Haifa")', () => {
    assert.equal(descriptorMatchesCountry('Israel, Haifa', 'Israel'), true);
    assert.equal(descriptorMatchesCountry('India, Bangalore', 'Israel'), false);
});

test('country matching survives a dash-delimited descriptor (Palo Alto Networks: "Office - Israel - City")', () => {
    // Real descriptor from PANW's tenant, captured 2026-08-06 — their Israel
    // offices are still labeled with CyberArk's own site names post-acquisition.
    assert.equal(descriptorMatchesCountry("Office - Israel - CyberArk Be'er Sheva", 'Israel'), true);
    assert.equal(descriptorMatchesCountry('Office - Japan - Tokyo', 'Israel'), false);
});

test('country matching is a whole-segment match, not a substring one', () => {
    // "Israeli" or a city that happens to contain the country name as a
    // substring must not silently pass — that would falsely widen the filter.
    assert.equal(descriptorMatchesCountry('Israeli-American Chamber, NY', 'Israel'), false);
});

// ---------------------------------------------------------------------------
// URL building — this is a platform adapter, so the tenant must not be baked in
// ---------------------------------------------------------------------------

test('builds the jobs URL from config, not constants', () => {
    const adapter = new WorkdayAdapter({ host: HOST, tenant: 'intel', site: SITE });
    assert.equal(adapter.jobsUrl, 'https://intel.wd1.myworkdayjobs.com/wday/cxs/intel/External/jobs');
});

test('another Workday tenant is configuration, not a new file', () => {
    const adapter = new WorkdayAdapter({ host: 'example.wd5.myworkdayjobs.com', tenant: 'example', site: 'Careers' });
    assert.equal(adapter.jobsUrl, 'https://example.wd5.myworkdayjobs.com/wday/cxs/example/Careers/jobs');
});

// ---------------------------------------------------------------------------
// The seam with the matcher
// ---------------------------------------------------------------------------

test('a parsed job survives a Haifa profile', () => {
    const job = mapWorkdayJob(HAIFA_JOB, HOST, SITE, 'en-US');
    assert.equal(matches(job, { keywords: 'test,system', location_filter: 'Haifa' }), true);
    assert.equal(matches(job, { keywords: 'test,system', location_filter: 'Tokyo' }), false);
});
