// Isolated in-memory DB — see tests/jobs.test.js for why this has to be set
// before anything in server/data/ is required.
process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { addCompany, setFirstScrapedAt } = require('../server/data/companies');
const { upsertJobSnapshot, closeMissingJobs } = require('../server/data/jobs');
const { createUser } = require('../server/data/users');
const { searchJobs, filterOptions } = require('../server/services/jobSearchService');
const { recordScrapeRun } = require('../server/data/scrapeRuns');
const { GUEST } = require('../server/data/tenancy');

let userId;

test.before(() => {
    userId = createUser({ email: 'search-service-test@example.com', passwordHash: 'x' });
});

function seedCompanyWithJobs(count, location) {
    const companyId = addCompany({ name: `SearchService Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    for (let i = 0; i < count; i++) {
        upsertJobSnapshot(companyId, {
            externalId: `job-${companyId}-${i}`,
            title: `Job ${i}`,
            location,
            applyUrl: 'https://example.com',
        });
    }
    return companyId;
}

test('a page beyond the last real page returns an empty jobs array, not another page\'s rows', () => {
    const companyId = seedCompanyWithJobs(5, 'Tel Aviv');

    const params = new URLSearchParams({ company: String(companyId), pageSize: '20', page: '99999' });
    const result = searchJobs(userId, params);

    assert.equal(result.page, 99999, 'the requested page is echoed back, not silently substituted');
    assert.deepEqual(result.jobs, []);
    // The count is still honest about what the filter actually matches — an
    // empty `jobs` array here means "nothing on THIS page", not "no matches".
    assert.equal(result.totalMatching, 5);
    assert.equal(result.totalPages, 1);
});

test('page=0 and negative pages sanitize to page 1 — that is invalid input, not "beyond totalPages"', () => {
    const companyId = seedCompanyWithJobs(3, 'Haifa');

    for (const page of ['0', '-1', 'not-a-number', '']) {
        const params = new URLSearchParams({ company: String(companyId), page });
        const result = searchJobs(userId, params);
        assert.equal(result.page, 1, `page=${JSON.stringify(page)} should sanitize to 1`);
        assert.equal(result.jobs.length, 3);
    }
});

test('pageSize is still capped at 100 regardless of how far out of range the page is', () => {
    const companyId = seedCompanyWithJobs(2, 'Jerusalem');
    const params = new URLSearchParams({ company: String(companyId), page: '5000', pageSize: '9999' });
    const result = searchJobs(userId, params);

    assert.equal(result.pageSize, 100);
    assert.deepEqual(result.jobs, []);
});

// ---------------------------------------------------------------------------
// Closed jobs never show, and every returned job carries freshness fields
// ---------------------------------------------------------------------------

test('a closed job never appears in search results, an open one at the same company still does', () => {
    const companyId = addCompany({ name: `Closed Filter Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    upsertJobSnapshot(companyId, { externalId: 'stays-open', title: 'Open Job', location: 'Tel Aviv', applyUrl: 'https://example.com' });
    upsertJobSnapshot(companyId, { externalId: 'will-close', title: 'Closing Job', location: 'Tel Aviv', applyUrl: 'https://example.com' });

    closeMissingJobs(companyId, ['stays-open']); // "will-close" wasn't in this run's results

    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId) }));
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].externalId, 'stays-open');
    assert.equal(result.totalMatching, 1, 'the count must agree with the list, not include the closed job either');
});

test('every job in a search result carries displayDate, dateSource and isNew', () => {
    const companyId = seedCompanyWithJobs(1, 'Tel Aviv');
    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId) }));

    assert.equal(result.jobs.length, 1);
    const job = result.jobs[0];
    assert.ok('displayDate' in job);
    assert.ok('dateSource' in job);
    assert.ok('isNew' in job);
    // Internal-only fields used to compute the above / drive ordering — must
    // not leak into the API shape.
    assert.equal('companyFirstScrapedAt' in job, false);
    assert.equal('companyRecency' in job, false);
});

// ---------------------------------------------------------------------------
// filterOptions() exposes when the data was last refreshed
// ---------------------------------------------------------------------------

test('filterOptions reports lastScrapeAt null and scrapeStale true when no cycle has ever run', () => {
    const result = filterOptions(GUEST);
    assert.equal(result.lastScrapeAt, null);
    assert.equal(result.scrapeStale, true);
});

test('filterOptions reflects the most recently recorded scrape run', () => {
    const recentFinish = new Date().toISOString();
    recordScrapeRun({
        startedAt: new Date(Date.now() - 1000).toISOString(),
        finishedAt: recentFinish,
        companies: 3,
        newJobs: 5,
        closedJobs: 0,
        failures: [],
    });

    const result = filterOptions(GUEST);
    assert.equal(result.lastScrapeAt, recentFinish);
    assert.equal(result.scrapeStale, false, 'a run that just finished must not read as stale');
});

test('filterOptions reports scrapeStale true once the last run is over 24 hours old', () => {
    const oldFinish = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    recordScrapeRun({
        startedAt: oldFinish,
        finishedAt: oldFinish,
        companies: 1,
        newJobs: 0,
        closedJobs: 0,
        failures: [],
    });

    const result = filterOptions(GUEST);
    assert.equal(result.lastScrapeAt, oldFinish);
    assert.equal(result.scrapeStale, true);
});

test('a job with a real posted_at reports dateSource "source" through the full search path', () => {
    const companyId = addCompany({ name: `Posted Date Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const today = new Date().toISOString().slice(0, 10);
    upsertJobSnapshot(companyId, {
        externalId: 'dated', title: 'Dated Job', location: 'Tel Aviv', applyUrl: 'https://example.com', postedAt: today,
    });

    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId) }));
    assert.equal(result.jobs[0].dateSource, 'source');
    assert.equal(result.jobs[0].displayDate, today);
    assert.equal(result.jobs[0].isNew, true);
});

// ---------------------------------------------------------------------------
// locationCanonical — the boundary fix for the "Haifa, Israel" displayed in
// English bug (docs/ROADMAP.md). Resolved once on the server, sent alongside
// the raw location so the client can do a plain exact-key lookup.
// ---------------------------------------------------------------------------

test('a job carries locationCanonical resolved from its raw location', () => {
    const companyId = addCompany({ name: `Canonical Loc Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    upsertJobSnapshot(companyId, {
        externalId: 'haifa-job', title: 'Job', location: 'Haifa, Israel', applyUrl: 'https://example.com',
    });

    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId) }));
    assert.equal(result.jobs[0].location, 'Haifa, Israel', 'the raw string is still sent — the client falls back to it');
    assert.equal(result.jobs[0].locationCanonical, 'Haifa');
});

test('locationCanonical is null when nothing in the raw location resolves', () => {
    const companyId = addCompany({ name: `Unresolved Loc Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    upsertJobSnapshot(companyId, {
        externalId: 'foreign-job', title: 'Job', location: 'Shanghai', applyUrl: 'https://example.com',
    });

    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId) }));
    assert.equal(result.jobs[0].locationCanonical, null);
});

// ---------------------------------------------------------------------------
// employmentGap / experienceGap — the honest "and N more don't say" companion
// to a filter that excludes unknown values (docs/ROADMAP.md's count-mismatch
// writeup). Only present when that specific filter is active.
// ---------------------------------------------------------------------------

function seedEmploymentMix(companyId) {
    upsertJobSnapshot(companyId, {
        externalId: 'full-time-1', title: 'A', location: 'Tel Aviv', applyUrl: 'https://example.com', employmentType: 'full-time',
    });
    upsertJobSnapshot(companyId, {
        externalId: 'contract-1', title: 'B', location: 'Tel Aviv', applyUrl: 'https://example.com', employmentType: 'contract',
    });
    upsertJobSnapshot(companyId, {
        externalId: 'unknown-1', title: 'C', location: 'Tel Aviv', applyUrl: 'https://example.com',
    });
    upsertJobSnapshot(companyId, {
        externalId: 'unknown-2', title: 'D', location: 'Tel Aviv', applyUrl: 'https://example.com',
    });
}

test('no employmentGap/experienceGap when neither filter is active', () => {
    const companyId = addCompany({ name: `No Gap Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    seedEmploymentMix(companyId);

    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId) }));
    assert.equal('employmentGap' in result, false);
    assert.equal('experienceGap' in result, false);
});

test('employmentGap reports how many OTHER jobs (matching everything else) have no employment type at all', () => {
    const companyId = addCompany({ name: `Emp Gap Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    seedEmploymentMix(companyId);

    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId), employment: 'full-time' }));
    assert.equal(result.totalMatching, 1, 'only the one full-time job matches the strict filter');
    assert.deepEqual(result.employmentGap, { totalWithoutFilter: 4, unknownCount: 2 });
    assert.equal('experienceGap' in result, false, 'the experience filter was never set');
});

test('a job from a company\'s initial bulk load reports dateSource "unknown" through the full search path', () => {
    const companyId = addCompany({ name: `Bulk Load Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    upsertJobSnapshot(companyId, { externalId: 'old-catalogue', title: 'Old Job', location: 'Tel Aviv', applyUrl: 'https://example.com' });
    // Simulates what scrapeService.js does at the end of a company's first
    // healthy cycle — set AFTER the job above, so its first_seen_at falls at
    // or before the cutoff.
    setFirstScrapedAt(companyId, new Date().toISOString());

    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId) }));
    assert.equal(result.jobs[0].dateSource, 'unknown');
    assert.equal(result.jobs[0].displayDate, null);
    assert.equal(result.jobs[0].isNew, false);
});

// ---------------------------------------------------------------------------
// "רק היי-טק" — on by default (docs/ROADMAP.md). A default-on filter that
// never announces itself is the same bug as the employment/experience gap
// above, in a new costume — totalWithoutTechFilter is what lets the client
// say "X מתוך Y" while it's silently narrowing the results.
// ---------------------------------------------------------------------------

function seedTechMix(companyId) {
    upsertJobSnapshot(companyId, { externalId: 'eng-1', title: 'Backend Engineer', location: 'Tel Aviv', applyUrl: 'https://example.com' });
    upsertJobSnapshot(companyId, { externalId: 'eng-2', title: 'Data Scientist', location: 'Tel Aviv', applyUrl: 'https://example.com' });
    upsertJobSnapshot(companyId, { externalId: 'sales-1', title: 'Sales Manager', location: 'Tel Aviv', applyUrl: 'https://example.com' });
}

test('the tech filter is on by default — no ?tech= param at all', () => {
    const companyId = addCompany({ name: `Tech Default Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    seedTechMix(companyId);

    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId) }));
    assert.equal(result.techOnly, true);
    assert.equal(result.totalMatching, 2, 'the Sales Manager job must be filtered out by default');
    assert.equal(result.totalWithoutTechFilter, 3);
});

test('?tech=0 shows everything, and stops reporting totalWithoutTechFilter', () => {
    const companyId = addCompany({ name: `Tech Off Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    seedTechMix(companyId);

    const result = searchJobs(userId, new URLSearchParams({ company: String(companyId), tech: '0' }));
    assert.equal(result.techOnly, false);
    assert.equal(result.totalMatching, 3);
    assert.equal('totalWithoutTechFilter' in result, false, 'nothing was narrowed, so there is nothing to explain');
});
