process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { db, isStreamNotFoundError, transientErrorCase, isReadStatement, retryOnTransientError } = require('../server/data/connection');

// ---------------------------------------------------------------------------
// isStreamNotFoundError — matched narrowly, on purpose (see connection.js's
// own comment): both the Hrana wrapper AND "stream not found" have to be
// present, so an unrelated failure is never mistaken for a stale stream.
// ---------------------------------------------------------------------------

// The exact shape observed live (DB-RECONNECT-PROMPT.md) — a real
// GET /api/meta response body, not a guess at what the error might look like.
const REAL_HRANA_STREAM_ERROR = new Error(
    'Hrana(Api("status=404 Not Found, body={\\"error\\":\\"stream not found: 0aa7883d:d4a4a3\\"}"))'
);

test('matches the real Hrana stream-not-found error shape', () => {
    assert.equal(isStreamNotFoundError(REAL_HRANA_STREAM_ERROR), true);
});

test('does not match a generic error', () => {
    assert.equal(isStreamNotFoundError(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed')), false);
});

test('does not match "stream not found" without the Hrana wrapper', () => {
    assert.equal(isStreamNotFoundError(new Error('stream not found somewhere unrelated')), false);
});

test('does not match a different Hrana error', () => {
    assert.equal(isStreamNotFoundError(new Error('Hrana(Api("status=401 Unauthorized"))')), false);
});

test('does not throw on null/undefined/a non-Error', () => {
    assert.equal(isStreamNotFoundError(null), false);
    assert.equal(isStreamNotFoundError(undefined), false);
    assert.equal(isStreamNotFoundError('just a string'), false);
});

// ---------------------------------------------------------------------------
// transientErrorCase — the dropped-connection shape (TURSO-DROP-PROMPT.md)
// joins stream-not-found, matched just as narrowly: Hrana wrapper AND the
// specific text.
// ---------------------------------------------------------------------------

// The exact message from the failed scheduled scrape on 2026-10-06.
const REAL_HRANA_CONNECTION_CLOSED = new Error('Hrana(Http("connection closed before message completed"))');

test('matches the real Hrana connection-closed error shape', () => {
    assert.equal(transientErrorCase(REAL_HRANA_CONNECTION_CLOSED)?.name, 'connection closed');
    assert.equal(transientErrorCase(REAL_HRANA_STREAM_ERROR)?.name, 'stream not found');
});

test('a connection-closed error is not mistaken for a stale stream', () => {
    assert.equal(isStreamNotFoundError(REAL_HRANA_CONNECTION_CLOSED), false);
});

test('unrelated Hrana errors and plain SQL errors are not transient', () => {
    for (const message of [
        'Hrana(Api("status=401 Unauthorized"))',
        'Hrana(Http("InvalidUri(InvalidUriChar)"))',
        'SQLITE_CONSTRAINT: UNIQUE constraint failed: users.email',
        'connection closed before message completed', // the text without the Hrana wrapper
    ]) {
        assert.equal(transientErrorCase(new Error(message)), null, message);
    }
    assert.equal(transientErrorCase(null), null);
    assert.equal(transientErrorCase('Hrana connection closed before message completed'), null);
});

test('isReadStatement: only SELECT (and PRAGMA table_info) count as reads', () => {
    assert.equal(isReadStatement('SELECT 1'), true);
    assert.equal(isReadStatement('\n   select id FROM job_snapshots'), true);
    assert.equal(isReadStatement('PRAGMA table_info(users)'), true);
    assert.equal(isReadStatement('INSERT INTO scrape_runs VALUES (1)'), false);
    assert.equal(isReadStatement('UPDATE job_snapshots SET is_still_open = 0'), false);
    assert.equal(isReadStatement('PRAGMA foreign_keys = ON'), false);
    assert.equal(isReadStatement('WITH x AS (SELECT 1) DELETE FROM t'), false);
});

// ---------------------------------------------------------------------------
// retryOnTransientError — the retry orchestration itself, kept free of any
// reference to db/openDatabase specifically so it can be driven with a fake
// failing connection here. Turso can't be made to time out a stream or drop a
// connection on demand from a test, so this is what's actually verified
// instead of an end-to-end reconnect. `sleep` and `log` are injected so the
// backoff costs no real time and the log line can be asserted on.
// ---------------------------------------------------------------------------

/** A fake attempt that throws `errors` in order, then returns 'ok'. */
function failing(...errors) {
    const state = { calls: 0, reconnects: 0, sleeps: [], logs: [] };
    state.attempt = () => {
        state.calls++;
        if (state.calls <= errors.length) throw errors[state.calls - 1];
        return 'ok';
    };
    state.reconnect = () => {
        state.reconnects++;
    };
    state.options = (extra) => ({ sleep: (ms) => state.sleeps.push(ms), log: (l) => state.logs.push(l), ...extra });
    return state;
}

test('runs attempt() once and returns its value when nothing fails', () => {
    const f = failing();
    assert.equal(retryOnTransientError(f.attempt, f.reconnect, f.options()), 'ok');
    assert.equal(f.calls, 1);
    assert.equal(f.reconnects, 0);
    assert.deepEqual(f.logs, []);
});

test('stale stream: reconnects and retries once, for a write too, then succeeds', () => {
    const f = failing(REAL_HRANA_STREAM_ERROR);
    assert.equal(retryOnTransientError(f.attempt, f.reconnect, f.options({ isRead: false })), 'ok');
    assert.equal(f.calls, 2);
    assert.equal(f.reconnects, 1);
    assert.match(f.logs[0], /stream not found/);
});

test('stale stream: a second consecutive failure propagates for real', () => {
    const f = failing(REAL_HRANA_STREAM_ERROR, REAL_HRANA_STREAM_ERROR);
    assert.throws(() => retryOnTransientError(f.attempt, f.reconnect, f.options({ isRead: true })), /stream not found/);
    assert.equal(f.calls, 2);
    assert.equal(f.reconnects, 1);
});

test('connection closed: a read is retried with backoff and succeeds on a later attempt — and says so', () => {
    const f = failing(REAL_HRANA_CONNECTION_CLOSED, REAL_HRANA_CONNECTION_CLOSED);
    assert.equal(retryOnTransientError(f.attempt, f.reconnect, f.options({ isRead: true })), 'ok');
    assert.equal(f.calls, 3);
    assert.equal(f.reconnects, 2);
    assert.deepEqual(f.sleeps, [500, 2000]);
    // The line to look for in a CI log once this happens for real.
    for (const line of f.logs) console.log(`    [captured log] ${line}`);
    assert.equal(f.logs.length, 2);
    assert.match(f.logs[0], /^Turso connection closed \(HTTP connection dropped mid-request\) — reopening the connection and retrying the read \(retry 1 of 2, after 500ms\)\.$/);
    assert.match(f.logs[1], /retry 2 of 2, after 2000ms/);
});

test('connection closed: gives up after the bound and propagates the real error', () => {
    const f = failing(REAL_HRANA_CONNECTION_CLOSED, REAL_HRANA_CONNECTION_CLOSED, REAL_HRANA_CONNECTION_CLOSED);
    assert.throws(
        () => retryOnTransientError(f.attempt, f.reconnect, f.options({ isRead: true })),
        (err) => err === REAL_HRANA_CONNECTION_CLOSED
    );
    assert.equal(f.calls, 3); // the original + 2 retries, no more
    assert.equal(f.reconnects, 2);
});

test('connection closed: a write NOT declared idempotent is never retried — it may already have been applied', () => {
    const f = failing(REAL_HRANA_CONNECTION_CLOSED);
    assert.throws(() => retryOnTransientError(f.attempt, f.reconnect, f.options({ isRead: false })), /connection closed/);
    assert.equal(f.calls, 1);
    assert.equal(f.reconnects, 0);
    assert.deepEqual(f.logs, []);
});

test('connection closed: the default (no options) is the safe one — treated as a non-idempotent write', () => {
    const f = failing(REAL_HRANA_CONNECTION_CLOSED);
    assert.throws(() => retryOnTransientError(f.attempt, f.reconnect), /connection closed/);
    assert.equal(f.calls, 1);
});

test('connection closed: a write declared idempotent is retried', () => {
    const f = failing(REAL_HRANA_CONNECTION_CLOSED);
    assert.equal(retryOnTransientError(f.attempt, f.reconnect, f.options({ isRead: false, idempotent: true })), 'ok');
    assert.equal(f.calls, 2);
    assert.match(f.logs[0], /retrying an idempotent write/);
});

test('a different error propagates immediately, without reconnecting', () => {
    for (const err of [new Error('SQLITE_BUSY: database is locked'), new Error('Hrana(Api("status=401 Unauthorized"))')]) {
        const f = failing(err);
        assert.throws(() => retryOnTransientError(f.attempt, f.reconnect, f.options({ isRead: true, idempotent: true })), (e) => e === err);
        assert.equal(f.calls, 1);
        assert.equal(f.reconnects, 0);
    }
});

test('a real error after a transient one propagates — the retry does not hide it', () => {
    const sqlError = new Error('SQLITE_CONSTRAINT: NOT NULL constraint failed');
    const f = failing(REAL_HRANA_CONNECTION_CLOSED, sqlError);
    assert.throws(() => retryOnTransientError(f.attempt, f.reconnect, f.options({ isRead: true })), (e) => e === sqlError);
    assert.equal(f.calls, 2);
});

test('the real sleep blocks for roughly the backoff it was asked for', () => {
    // Not injected this once: proves the default synchronous sleep really
    // waits (libsql is synchronous, so a non-blocking "sleep" would retry
    // instantly and the backoff would be fiction).
    const f = failing(REAL_HRANA_CONNECTION_CLOSED);
    const started = Date.now();
    retryOnTransientError(f.attempt, f.reconnect, { isRead: true, log: () => {} });
    assert.ok(Date.now() - started >= 450, `waited ${Date.now() - started}ms`);
});

// ---------------------------------------------------------------------------
// The local/:memory: path — a local libsql connection has no Hrana stream to
// go stale, so this wrapper must be fully transparent there: normal get/
// all/run behaviour, unaffected by anything above.
// ---------------------------------------------------------------------------

test('db.prepare still works normally against a local/:memory: connection', () => {
    db.prepare('CREATE TABLE IF NOT EXISTS connection_smoke_test (id INTEGER PRIMARY KEY, name TEXT)').run();
    const info = db.prepare('INSERT INTO connection_smoke_test (name) VALUES (?)').run('a');
    assert.equal(info.changes, 1);

    const row = db.prepare('SELECT name FROM connection_smoke_test WHERE id = ?').get(info.lastInsertRowid);
    assert.equal(row.name, 'a');

    db.prepare('INSERT INTO connection_smoke_test (name) VALUES (?)').run('b');
    const rows = db.prepare('SELECT name FROM connection_smoke_test ORDER BY id').all();
    assert.deepEqual(
        rows.map((r) => r.name),
        ['a', 'b']
    );
});
