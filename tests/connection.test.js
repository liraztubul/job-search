process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { db, isStreamNotFoundError, retryOnStaleStream } = require('../server/data/connection');

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
// retryOnStaleStream — the retry orchestration itself, kept free of any
// reference to db/openDatabase specifically so it can be driven with a fake
// failing connection here. Turso's idle-stream timeout can't be forced on
// demand from a test, so this is what's actually verified instead of an
// end-to-end reconnect against a real stale stream.
// ---------------------------------------------------------------------------

test('runs attempt() once and returns its value when nothing fails', () => {
    let calls = 0;
    let reconnected = false;
    const result = retryOnStaleStream(
        () => {
            calls++;
            return 'ok';
        },
        () => {
            reconnected = true;
        }
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
    assert.equal(reconnected, false);
});

test('reconnects once and retries once after a stale-stream failure, then succeeds', () => {
    let calls = 0;
    let reconnectCalls = 0;
    const result = retryOnStaleStream(
        () => {
            calls++;
            if (calls === 1) throw REAL_HRANA_STREAM_ERROR;
            return 'recovered';
        },
        () => {
            reconnectCalls++;
        }
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
    assert.equal(reconnectCalls, 1);
});

test('a different error propagates immediately, without reconnecting', () => {
    let reconnectCalls = 0;
    assert.throws(
        () =>
            retryOnStaleStream(
                () => {
                    throw new Error('SQLITE_BUSY: database is locked');
                },
                () => {
                    reconnectCalls++;
                }
            ),
        /database is locked/
    );
    assert.equal(reconnectCalls, 0);
});

test('only retries once — a second consecutive stale-stream failure propagates for real', () => {
    let calls = 0;
    let reconnectCalls = 0;
    assert.throws(
        () =>
            retryOnStaleStream(
                () => {
                    calls++;
                    throw REAL_HRANA_STREAM_ERROR;
                },
                () => {
                    reconnectCalls++;
                }
            ),
        /stream not found/
    );
    // Exactly one retry attempt: the original call plus one retry, not more.
    assert.equal(calls, 2);
    assert.equal(reconnectCalls, 1);
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
