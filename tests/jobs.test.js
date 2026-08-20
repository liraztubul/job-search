// Isolated in-memory DB — must be set before anything in server/data/ is
// required, connection.js reads it exactly once at module load. Every other
// test file that touches the real jobtrail.db runs in its own child
// process under node --test, so this has no effect on them.
process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../server/data/connection');
const { addCompany, setFirstScrapedAt, setCompanyActive } = require('../server/data/companies');
const { createUser } = require('../server/data/users');
const {
    queryJobs,
    countJobs,
    upsertJobSnapshot,
    upsertJobSnapshots,
    countOpenJobs,
    closeMissingJobs,
    filterOptions,
} = require('../server/data/jobs');
const { GUEST } = require('../server/data/tenancy');

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
// Default sort interleaves companies — one company's bulk-loaded history must
// not bury every other company on page one (see the comment on queryJobs).
// ---------------------------------------------------------------------------

test('the default sort shows every company\'s newest job before anyone\'s second-newest', () => {
    // Company A gets 5 jobs all bulk-loaded at once, all newer than anything
    // company B has — the exact shape that used to monopolize page one.
    const companyA = seedJobsWithSharedTimestamp(5, '2026-08-10T00:00:00.000Z');
    const companyB = addCompany({ name: `Interleave B ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    upsertJobSnapshot(companyB, {
        externalId: 'b-1', title: 'B Job', location: 'Tel Aviv', applyUrl: 'https://example.com',
    });
    // Force B's single job to be older than every one of A's, so a plain
    // first_seen_at DESC sort would put all 5 of A's jobs ahead of it.
    db.prepare('UPDATE job_snapshots SET first_seen_at = ? WHERE company_id = ?').run('2026-08-01T00:00:00.000Z', companyB);

    // pageSize large enough to include every row from every company seeded by
    // every test in this file (they share one in-memory database) — the point
    // here is A and B's relative order, not isolating them to their own page.
    const { jobs } = queryJobs(userId, { page: 1, pageSize: 100 });
    const companiesInOrder = jobs.filter((j) => j.companyId === companyA || j.companyId === companyB).map((j) => j.companyId);

    // B's one job must appear before A's SECOND job — not pushed behind all 5
    // of A's bulk-loaded rows just because every one of them has a later
    // first_seen_at than B's single job.
    const bIndex = companiesInOrder.indexOf(companyB);
    const aIndices = companiesInOrder.reduce((acc, id, i) => (id === companyA ? [...acc, i] : acc), []);
    assert.ok(bIndex >= 0, 'company B\'s job must be on the first page at all');
    assert.equal(aIndices.length, 5, 'sanity check: all 5 of company A\'s jobs are on this page');
    assert.ok(bIndex < aIndices[1], 'company B must interleave before company A\'s second job, not trail all of A\'s jobs');
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
// upsertJobSnapshots — the batched, whole-company version scrapeService.js
// actually calls. Must produce the exact same {isNew, id} per job as calling
// upsertJobSnapshot once per job would, in one SELECT + a handful of batched
// writes + one more SELECT, not two round trips per job — see the comment on
// it in server/data/jobs.js for why that distinction is the whole point.
// ---------------------------------------------------------------------------

const rawJob = (externalId, overrides = {}) => ({
    externalId,
    title: `Job ${externalId}`,
    location: 'Tel Aviv',
    applyUrl: 'https://example.com',
    ...overrides,
});

test('upsertJobSnapshots inserts every new job and reports isNew:true for each', () => {
    const companyId = addCompany({ name: `Batch New Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const jobs = [rawJob('a'), rawJob('b'), rawJob('c')];

    const results = upsertJobSnapshots(companyId, jobs);

    assert.equal(results.size, 3);
    for (const job of jobs) {
        const result = results.get(job.externalId);
        assert.equal(result.isNew, true, job.externalId);
        assert.ok(Number.isInteger(result.id), job.externalId);
    }
    assert.equal(countOpenJobs(companyId), 3);
});

test('upsertJobSnapshots reports isNew:false and keeps the same id for an already-seen job', () => {
    const companyId = addCompany({ name: `Batch Existing Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const { id: firstId } = upsertJobSnapshot(companyId, rawJob('x', { title: 'Old Title' }));

    const results = upsertJobSnapshots(companyId, [rawJob('x', { title: 'New Title' })]);

    const result = results.get('x');
    assert.equal(result.isNew, false);
    assert.equal(result.id, firstId);
    assert.equal(db.prepare('SELECT title FROM job_snapshots WHERE id = ?').get(firstId).title, 'New Title');
});

test('upsertJobSnapshots handles a mix of new and existing jobs in one call correctly', () => {
    const companyId = addCompany({ name: `Batch Mix Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const { id: existingId } = upsertJobSnapshot(companyId, rawJob('already-here'));

    const results = upsertJobSnapshots(companyId, [rawJob('already-here'), rawJob('brand-new')]);

    assert.deepEqual(results.get('already-here'), { isNew: false, id: existingId });
    assert.equal(results.get('brand-new').isNew, true);
    assert.notEqual(results.get('brand-new').id, existingId);
});

test('upsertJobSnapshots never overwrites first_seen_at on a re-scrape of an unchanged job — this is the regression the batching most easily introduces', async () => {
    const companyId = addCompany({ name: `Batch FirstSeen Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const { id } = upsertJobSnapshot(companyId, rawJob('stable', { title: 'Original' }));
    const originalFirstSeenAt = db.prepare('SELECT first_seen_at, last_seen_at FROM job_snapshots WHERE id = ?').get(id).first_seen_at;

    // A real (if tiny) gap, so last_seen_at moving forward is a genuine
    // second timestamp rather than two calls that happen to land on the same
    // millisecond — proof this is a live UPDATE, not a no-op.
    await new Promise((resolve) => setTimeout(resolve, 5));
    upsertJobSnapshots(companyId, [rawJob('stable', { title: 'Refreshed on re-scrape' })]);

    const row = db.prepare('SELECT first_seen_at, last_seen_at, title FROM job_snapshots WHERE id = ?').get(id);
    assert.equal(row.first_seen_at, originalFirstSeenAt, 'first_seen_at must survive a re-scrape unchanged');
    assert.equal(row.title, 'Refreshed on re-scrape', 'sanity check: the batched UPDATE path did run, not a silent no-op');
    assert.ok(row.last_seen_at >= originalFirstSeenAt, 'last_seen_at should have moved forward');
});

test('upsertJobSnapshots reopens a previously-closed job that reappears in a scrape', () => {
    const companyId = addCompany({ name: `Batch Reopen Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const { id } = upsertJobSnapshot(companyId, rawJob('flaky'));
    closeMissingJobs(companyId, []); // closes it
    assert.equal(db.prepare('SELECT is_still_open FROM job_snapshots WHERE id = ?').get(id).is_still_open, 0);

    upsertJobSnapshots(companyId, [rawJob('flaky')]);

    assert.equal(db.prepare('SELECT is_still_open FROM job_snapshots WHERE id = ?').get(id).is_still_open, 1);
});

test('upsertJobSnapshots handles more jobs than fit in one batch statement', () => {
    const companyId = addCompany({ name: `Batch Large Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    // Comfortably more than one batch (13 columns -> 69 rows/batch) without
    // being slow to run as a test.
    const jobs = Array.from({ length: 150 }, (_, i) => rawJob(`job-${i}`));

    const results = upsertJobSnapshots(companyId, jobs);

    assert.equal(results.size, 150);
    assert.equal(countOpenJobs(companyId), 150);
    assert.ok([...results.values()].every((r) => r.isNew && Number.isInteger(r.id)));

    // Re-run unchanged: every one must now read isNew:false, still across
    // multiple batches, proving the "before" snapshot isn't stale mid-run.
    const secondPass = upsertJobSnapshots(companyId, jobs);
    assert.ok([...secondPass.values()].every((r) => r.isNew === false));
});

test('upsertJobSnapshots on an empty job list is a no-op, not an error', () => {
    const companyId = addCompany({ name: `Batch Empty Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const results = upsertJobSnapshots(companyId, []);
    assert.equal(results.size, 0);
    assert.equal(countOpenJobs(companyId), 0);
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

// ---------------------------------------------------------------------------
// filterOptions()'s company list — a deactivated company must not still be
// offered as a filter option (see CLAUDE.md's note on IBM Israel, which
// genuinely, confirmedly returns zero Israel jobs — deactivating it is the
// fix, not a mapping bug).
// ---------------------------------------------------------------------------

test('a deactivated company is excluded from the filterable company list', () => {
    const companyId = addCompany({ name: `Deactivate Me ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    upsertJobSnapshot(companyId, { externalId: 'x', title: 'X', location: 'Tel Aviv', applyUrl: 'https://example.com' });

    const before = filterOptions(GUEST).companies;
    assert.ok(before.some((c) => c.id === companyId), 'sanity check: the active company starts out listed');

    setCompanyActive(companyId, false);

    const after = filterOptions(GUEST).companies;
    assert.ok(!after.some((c) => c.id === companyId), 'a deactivated company must not appear as a filter option');
});

test('setCompanyActive(true) makes a company reappear in the filter list', () => {
    const companyId = addCompany({ name: `Reactivate Me ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    setCompanyActive(companyId, false);
    assert.ok(!filterOptions(GUEST).companies.some((c) => c.id === companyId));

    setCompanyActive(companyId, true);
    assert.ok(filterOptions(GUEST).companies.some((c) => c.id === companyId));
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
