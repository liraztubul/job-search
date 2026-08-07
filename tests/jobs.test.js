// Isolated in-memory DB — must be set before anything in server/data/ is
// required, connection.js reads it exactly once at module load. Every other
// test file that touches the real jobtracker.db runs in its own child
// process under node --test, so this has no effect on them.
process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../server/data/connection');
const { addCompany } = require('../server/data/companies');
const { createUser } = require('../server/data/users');
const { queryJobs, countJobs, upsertJobSnapshot } = require('../server/data/jobs');

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
