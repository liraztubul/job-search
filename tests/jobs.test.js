// Isolated in-memory DB — must be set before anything in server/data/ is
// required, connection.js reads it exactly once at module load. Every other
// test file that touches the real jobtrail.db runs in its own child
// process under node --test, so this has no effect on them.
process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../server/data/connection');
const { addCompany, setFirstScrapedAt } = require('../server/data/companies');
const { createUser } = require('../server/data/users');
const { queryJobs, countJobs, upsertJobSnapshot, countOpenJobs, closeMissingJobs } = require('../server/data/jobs');

/**
 * Pagination is only trustworthy if countJobs and queryJobs can never
 * disagree, and if paging through every page accounts for every row exactly
 * once — the two properties Task 1 exists to guarantee. Both need real rows
 * in a real (if in-memory) SQLite, not a mock; that's the whole risk surface.
 */

let userId;

test.before(() => {
    userId = createUser({ email: 'pagination-test@example.com', passwordHash: 'x' });
});

/** Seeds `count` jobs for a fresh company, all sharing one first_seen_at. */
function seedJobsWithSharedTimestamp(count, sharedTimestamp) {
    const companyId = addCompany({
        name: `Seed Co ${Math.random()}`,
        careerUrl: '',
        adapterType: 'manual',
        config: {},
    });

    const insert = db.prepare(
        `INSERT INTO job_snapshots
            (company_id, external_id, title, location, apply_url, first_seen_at, last_seen_at, is_still_open)
         VALUES (@companyId, @externalId, @title, 'Tel Aviv', 'https://example.com', @ts, @ts, 1)`
    );
    for (let i = 0; i < count; i++) {
        insert.run({ companyId, externalId: `job-${companyId}-${i}`, title: `Job ${i}`, ts: sharedTimestamp });
    }
    return companyId;
}

// ---------------------------------------------------------------------------
// Tenancy guard — queryJobs/countJobs read the personal `applications` table
// via a join, so they must refuse to run without a user the same way every
// other repository function touching personal data does.
// ---------------------------------------------------------------------------

test('queryJobs and countJobs demand a user id', () => {
    assert.throws(() => queryJobs(), /requireUser/);
    assert.throws(() => countJobs(), /requireUser/);
});

// ---------------------------------------------------------------------------
// countJobs must match queryJobs's WHERE clause regardless of page/pageSize
// ---------------------------------------------------------------------------

test('countJobs returns the same total no matter what page or pageSize is asked for', () => {
    const companyId = seedJobsWithSharedTimestamp(37, '2026-08-01T00:00:00.000Z');
    const filters = { companyId };

    const total = countJobs(userId, filters);
    assert.equal(total, 37);

    for (const [page, pageSize] of [[1, 20], [2, 20], [1, 5], [8, 5], [1, 100]]) {
        assert.equal(countJobs(userId, { ...filters, page, pageSize }), 37, `page=${page} pageSize=${pageSize}`);
    }
});

// ---------------------------------------------------------------------------
// Full traversal: every row exactly once, even when they share a timestamp
// ---------------------------------------------------------------------------

test('paging through every page yields each job exactly once, no duplicates or gaps', () => {
    // All 673 Elbit jobs landed in one scrape and share a first_seen_at in the
    // real data — a test with unique timestamps would pass even if the
    // ordering were broken, so this seeds the same way on purpose.
    const companyId = seedJobsWithSharedTimestamp(47, '2026-08-01T00:00:00.000Z');
    const filters = { companyId };
    const pageSize = 10;
    const totalPages = Math.ceil(47 / pageSize);

    const seenIds = [];
    for (let page = 1; page <= totalPages; page++) {
        const { jobs } = queryJobs(userId, { ...filters, page, pageSize });
        for (const job of jobs) seenIds.push(job.id);
    }

    assert.equal(seenIds.length, 47, 'total rows collected across all pages');
    assert.equal(new Set(seenIds).size, 47, 'no id appeared on more than one page');
});

test('the same is true sorted by title, where every row also ties on title length in this fixture', () => {
    const companyId = seedJobsWithSharedTimestamp(23, '2026-08-01T00:00:00.000Z');
    // Overwrite every title to the exact same string, so "sort by title" is an
    // all-way tie too — only the `, j.id DESC` tiebreaker keeps it total.
    db.prepare('UPDATE job_snapshots SET title = ? WHERE company_id = ?').run('Same Title', companyId);

    const filters = { companyId, sort: 'title' };
    const pageSize = 7;
    const totalPages = Math.ceil(23 / pageSize);

    const seenIds = [];
    for (let page = 1; page <= totalPages; page++) {
        const { jobs } = queryJobs(userId, { ...filters, page, pageSize });
        for (const job of jobs) seenIds.push(job.id);
    }

    assert.equal(seenIds.length, 23);
    assert.equal(new Set(seenIds).size, 23);
});

// ---------------------------------------------------------------------------
// Clamping — bad input is tolerated, not thrown
// ---------------------------------------------------------------------------

test('page and pageSize are clamped rather than trusted as-is', () => {
    const companyId = seedJobsWithSharedTimestamp(5, '2026-08-01T00:00:00.000Z');
    const filters = { companyId };

    for (const page of [0, -1, 99999]) {
        const result = queryJobs(userId, { ...filters, page, pageSize: 20 });
        assert.ok(result.page >= 1, `page=${page} produced ${result.page}`);
        assert.ok(Array.isArray(result.jobs));
    }

    const oversized = queryJobs(userId, { ...filters, page: 1, pageSize: 1000 });
    assert.ok(oversized.pageSize <= 100, `pageSize should be capped, got ${oversized.pageSize}`);

    const zeroed = queryJobs(userId, { ...filters, page: 1, pageSize: 0 });
    assert.ok(zeroed.pageSize >= 1);
});

// ---------------------------------------------------------------------------
// Multi-select location filter — any one of several cities, not all of them
// ---------------------------------------------------------------------------

test('filters.locations matches any of the given cities (OR), not their intersection', () => {
    const companyId = addCompany({ name: `Multiloc Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    for (const location of ['Tel Aviv', 'Haifa', 'Jerusalem']) {
        upsertJobSnapshot(companyId, {
            externalId: `job-${location}`,
            title: `Engineer in ${location}`,
            location,
            applyUrl: 'https://example.com',
        });
    }

    const telAvivAndHaifa = queryJobs(userId, { companyId, locations: ['Tel Aviv', 'Haifa'] }).jobs;
    assert.equal(telAvivAndHaifa.length, 2);
    assert.ok(telAvivAndHaifa.every((j) => j.location === 'Tel Aviv' || j.location === 'Haifa'));
    assert.ok(!telAvivAndHaifa.some((j) => j.location === 'Jerusalem'));

    assert.equal(countJobs(userId, { companyId, locations: ['Tel Aviv', 'Haifa'] }), 2);
    assert.equal(countJobs(userId, { companyId, locations: [] }), 3, 'an empty list means no location filter at all');
});

// ---------------------------------------------------------------------------
// posted_at is a strict invariant: real ISO date or NULL, enforced here so
// no adapter's mistake (or a future one nobody's written yet) can smuggle
// relative text or a future date into storage.
// ---------------------------------------------------------------------------

test('upsertJobSnapshot silently nulls out a posted_at that is not a valid, non-future ISO date', () => {
    const companyId = addCompany({ name: `Bad Date Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });

    for (const bad of ['Posted 3 Days Ago', '2099-01-01', 'not-a-date', '']) {
        const { id } = upsertJobSnapshot(companyId, {
            externalId: `job-${Math.random()}`,
            title: 'Test Job',
            location: 'Tel Aviv',
            applyUrl: 'https://example.com',
            postedAt: bad,
        });
        const stored = db.prepare('SELECT posted_at FROM job_snapshots WHERE id = ?').get(id);
        assert.equal(stored.posted_at, null, `"${bad}" must not reach storage`);
    }
});

test('upsertJobSnapshot keeps a real, non-future posted_at, and re-validates it on update too', () => {
    const companyId = addCompany({ name: `Good Date Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const externalId = `job-${Math.random()}`;

    const { id } = upsertJobSnapshot(companyId, {
        externalId, title: 'Test Job', location: 'Tel Aviv', applyUrl: 'https://example.com', postedAt: '2026-08-01',
    });
    assert.equal(db.prepare('SELECT posted_at FROM job_snapshots WHERE id = ?').get(id).posted_at, '2026-08-01');

    // A re-scrape that suddenly sends garbage must not be trusted just
    // because the row already existed.
    upsertJobSnapshot(companyId, {
        externalId, title: 'Test Job', location: 'Tel Aviv', applyUrl: 'https://example.com', postedAt: 'garbage',
    });
    assert.equal(db.prepare('SELECT posted_at FROM job_snapshots WHERE id = ?').get(id).posted_at, null);
});

// ---------------------------------------------------------------------------
// Closure detection — countOpenJobs / closeMissingJobs (scrapeService.js's
// data-layer half; the sanity-gate decision itself is tested in
// tests/scrapeSanity.test.js as a pure function).
// ---------------------------------------------------------------------------

test('closeMissingJobs closes exactly the open jobs absent from this run, and only those', () => {
    const companyId = addCompany({ name: `Closure Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    for (const externalId of ['keep-1', 'keep-2', 'gone-1', 'gone-2']) {
        upsertJobSnapshot(companyId, {
            externalId, title: `Job ${externalId}`, location: 'Tel Aviv', applyUrl: 'https://example.com',
        });
    }
    assert.equal(countOpenJobs(companyId), 4);

    const closedCount = closeMissingJobs(companyId, ['keep-1', 'keep-2']);
    assert.equal(closedCount, 2);
    assert.equal(countOpenJobs(companyId), 2);

    const rows = db.prepare('SELECT external_id, is_still_open, closed_at FROM job_snapshots WHERE company_id = ? ORDER BY external_id').all(companyId);
    assert.deepEqual(
        rows.map((r) => [r.external_id, r.is_still_open]),
        [['gone-1', 0], ['gone-2', 0], ['keep-1', 1], ['keep-2', 1]]
    );
    assert.ok(rows.find((r) => r.external_id === 'gone-1').closed_at, 'closed_at must be stamped');
    assert.equal(rows.find((r) => r.external_id === 'keep-1').closed_at, null);
});

test('closeMissingJobs never touches an already-closed job again', () => {
    const companyId = addCompany({ name: `Closure Co B ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    upsertJobSnapshot(companyId, { externalId: 'x', title: 'X', location: 'Tel Aviv', applyUrl: 'https://example.com' });

    closeMissingJobs(companyId, []); // closes it
    const firstClosedAt = db.prepare('SELECT closed_at FROM job_snapshots WHERE company_id = ?').get(companyId).closed_at;

    // A second pass with the job still absent must not re-stamp closed_at —
    // the query only ever looks at currently-OPEN rows.
    const secondPassCount = closeMissingJobs(companyId, []);
    assert.equal(secondPassCount, 0);
    const secondClosedAt = db.prepare('SELECT closed_at FROM job_snapshots WHERE company_id = ?').get(companyId).closed_at;
    assert.equal(secondClosedAt, firstClosedAt);
});

test('closeMissingJobs on a company with nothing missing closes nothing', () => {
    const companyId = addCompany({ name: `Closure Co C ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    upsertJobSnapshot(companyId, { externalId: 'a', title: 'A', location: 'Tel Aviv', applyUrl: 'https://example.com' });
    assert.equal(closeMissingJobs(companyId, ['a']), 0);
    assert.equal(countOpenJobs(companyId), 1);
});

test('countOpenJobs only counts is_still_open=1 rows for that company', () => {
    const companyId = addCompany({ name: `Open Count Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const otherCompanyId = addCompany({ name: `Other Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    upsertJobSnapshot(companyId, { externalId: 'a', title: 'A', location: 'Tel Aviv', applyUrl: 'https://example.com' });
    upsertJobSnapshot(companyId, { externalId: 'b', title: 'B', location: 'Tel Aviv', applyUrl: 'https://example.com' });
    upsertJobSnapshot(otherCompanyId, { externalId: 'c', title: 'C', location: 'Tel Aviv', applyUrl: 'https://example.com' });

    assert.equal(countOpenJobs(companyId), 2);
    closeMissingJobs(companyId, ['a']);
    assert.equal(countOpenJobs(companyId), 1, 'closing one job at this company must not touch the other company');
    assert.equal(countOpenJobs(otherCompanyId), 1);
});

test('setFirstScrapedAt is set once, and every later call is a no-op — the new-company trap depends on this', () => {
    const companyId = addCompany({ name: `First Scrape Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    assert.equal(db.prepare('SELECT first_scraped_at FROM watched_companies WHERE id = ?').get(companyId).first_scraped_at, null);

    setFirstScrapedAt(companyId, '2026-01-01T00:00:00.000Z');
    assert.equal(
        db.prepare('SELECT first_scraped_at FROM watched_companies WHERE id = ?').get(companyId).first_scraped_at,
        '2026-01-01T00:00:00.000Z'
    );

    // A later cycle calling this again (as scrapeService.js does, unconditionally,
    // after every healthy cycle) must never move the timestamp forward.
    setFirstScrapedAt(companyId, '2026-06-01T00:00:00.000Z');
    assert.equal(
        db.prepare('SELECT first_scraped_at FROM watched_companies WHERE id = ?').get(companyId).first_scraped_at,
        '2026-01-01T00:00:00.000Z'
    );
});

// ---------------------------------------------------------------------------
// The bug Task 1 was written around: applications must not leak across users
// ---------------------------------------------------------------------------

test("one account's application status never appears on another account's job row", () => {
    const companyId = seedJobsWithSharedTimestamp(1, '2026-08-01T00:00:00.000Z');
    const job = queryJobs(userId, { companyId }).jobs[0];

    const otherUserId = createUser({ email: `other-${Math.random()}@example.com`, passwordHash: 'x' });
    db.prepare(
        `INSERT INTO applications (user_id, job_snapshot_id, status, updated_at) VALUES (?, ?, 'applied', ?)`
    ).run(otherUserId, job.id, new Date().toISOString());

    const mine = queryJobs(userId, { companyId }).jobs[0];
    assert.equal(mine.status, null, "another account's application status leaked onto this one's job list");

    const theirs = queryJobs(otherUserId, { companyId }).jobs[0];
    assert.equal(theirs.status, 'applied');
});
