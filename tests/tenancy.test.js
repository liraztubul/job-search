const test = require('node:test');
const assert = require('node:assert');
const { requireUser, PERSONAL_TABLES, SHARED_TABLES } = require('../server/data/tenancy');

/**
 * The bug these tests exist for: one query somewhere forgets `WHERE user_id`,
 * and one account's applications render on another account's screen. It throws
 * no error and a single-user test database never notices.
 *
 * So the check is structural. Every repository function that touches a personal
 * table must refuse to run without a user id — not by convention, by crashing.
 */

test('a missing user id is a crash, not a default', () => {
    for (const bad of [undefined, null, '', 0, -1, 1.5, 'all', {}, []]) {
        assert.throws(() => requireUser(bad), /requireUser/, `accepted ${JSON.stringify(bad)}`);
    }
});

test('the error says what to do about it', () => {
    try {
        requireUser(undefined);
        assert.fail('should have thrown');
    } catch (err) {
        assert.match(err.message, /per-account data/);
        assert.match(err.message, /logged-in user/);
    }
});

test('a real id passes through as a number', () => {
    assert.strictEqual(requireUser(7), 7);
    assert.strictEqual(requireUser('7'), 7); // query strings arrive as text
});

test('personal and shared tables do not overlap', () => {
    // A table in both lists means someone was unsure who owns its rows, and
    // that uncertainty is exactly where the leak gets written.
    const overlap = PERSONAL_TABLES.filter((t) => SHARED_TABLES.includes(t));
    assert.deepEqual(overlap, [], `tables classified as both: ${overlap.join(', ')}`);
});

test('the job market itself is shared, not copied per account', () => {
    // Scraping once for everyone is the whole reason this scales past one user.
    assert.ok(SHARED_TABLES.includes('job_snapshots'));
    assert.ok(SHARED_TABLES.includes('watched_companies'));
});

test('everything personal is classified as personal', () => {
    for (const table of ['applications', 'search_profiles', 'notifications_sent']) {
        assert.ok(PERSONAL_TABLES.includes(table), `${table} is not marked personal`);
    }
});

// ---------------------------------------------------------------------------
// Repository contract
// ---------------------------------------------------------------------------

test('every application repository function demands a user', () => {
    // Loaded lazily: this file must stay runnable without better-sqlite3 built.
    let applications;
    try {
        applications = require('../server/data/applications');
    } catch {
        return; // native module unavailable in this environment
    }

    assert.throws(() => applications.listApplications(), /requireUser/);
    assert.throws(() => applications.setApplication({ jobSnapshotId: 1, status: 'saved' }), /requireUser/);
});
