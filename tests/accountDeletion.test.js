// Isolated in-memory DB — must be set before anything in server/data/ is
// required. See tests/jobs.test.js for why this is safe across test files.
process.env.JT_DB_PATH = ':memory:';
process.env.JT_SESSION_SECRET = 'test-secret-not-for-production';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { db } = require('../server/data/connection');
const { handleApi } = require('../server/web/routes');
const data = require('../server/data');

/**
 * The privacy policy promises deletion; these tests are what makes that
 * promise real — and, since this is the exact bug class ADR-007 exists to
 * prevent, that deleting one account never touches a second account's rows.
 */

function fakeReq(method, body, { cookie, remoteAddress = '203.0.113.90' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    req.method = method;
    req.headers = { host: '127.0.0.1:3000' };
    if (cookie) req.headers.cookie = `jt_session=${cookie}`;
    req.socket = { remoteAddress };
    return req;
}

function fakeRes() {
    const headers = {};
    let statusCode;
    let rawBody;
    return {
        setHeader: (k, v) => { headers[k] = v; },
        writeHead: (status, hdrs) => { statusCode = status; Object.assign(headers, hdrs || {}); },
        end: (b) => { rawBody = b; },
        get statusCode() { return statusCode; },
        get headers() { return headers; },
        get body() { return rawBody ? JSON.parse(rawBody) : undefined; },
    };
}

async function call(method, path, body, opts) {
    const res = fakeRes();
    await handleApi(fakeReq(method, body, opts), res, new URL(`http://127.0.0.1:3000${path}`));
    return res;
}

function cookieFrom(res) {
    return res.headers['Set-Cookie'].split(';')[0].split('=')[1];
}

// The registration rate limiter (3/IP/hour) would otherwise trip across a
// file that registers several accounts — each call gets its own address, the
// same way passwordResetFlow.test.js varies IPs per test.
let nextIp = 1;
function freshIp() {
    nextIp += 1;
    return `198.51.100.${nextIp}`;
}

/** Registers an account and returns its userId and session cookie. */
async function registerAccount(email, password) {
    const res = await call('POST', '/api/register', { email, password }, { remoteAddress: freshIp() });
    assert.equal(res.statusCode, 201);
    const cookie = cookieFrom(res);
    const session = await call('GET', '/api/session', null, { cookie });
    return { userId: session.body.userId, cookie };
}

test('DELETE /api/account requires a session — a logged-out caller gets 401', async () => {
    const res = await call('DELETE', '/api/account', { password: 'whatever' });
    assert.equal(res.statusCode, 401);
});

test('the wrong password is refused, and the account is untouched', async () => {
    const { userId, cookie } = await registerAccount('wrong-pw@example.com', 'the-real-password-1');

    const res = await call('DELETE', '/api/account', { password: 'not-the-password' }, { cookie });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /wrong password/);

    assert.ok(data.findUserById(userId), 'account must still exist');
});

test('deletion removes exactly this account\'s rows, and nothing of a second account\'s', async () => {
    const alice = await registerAccount('alice-delete@example.com', 'alice-password-1');
    const bob = await registerAccount('bob-delete@example.com', 'bob-password-1');

    const companyId = data.addCompany({ name: `Deletion Co ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
    const { id: jobId } = data.upsertJobSnapshot(companyId, {
        externalId: 'job-1', title: 'Job', location: 'Tel Aviv', applyUrl: 'https://example.com',
    });

    // Both accounts track the same job — this is exactly the shape ADR-007
    // exists to keep isolated.
    data.setApplication({ userId: alice.userId, jobSnapshotId: jobId, status: 'applied' });
    data.setApplication({ userId: bob.userId, jobSnapshotId: jobId, status: 'saved' });

    // A search profile (and a notification against it) for Alice only —
    // inserted directly since profiles.js's addSearchProfile has no caller
    // and no userId parameter yet (see its own header comment).
    const profileInfo = db
        .prepare('INSERT INTO search_profiles (user_id, name, keywords) VALUES (?, ?, ?)')
        .run(alice.userId, 'Alice Profile', 'backend');
    data.recordNotification(jobId, profileInfo.lastInsertRowid);

    data.createPasswordReset({ userId: alice.userId, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 1000).toISOString() });
    data.createEmailConfirmation({ userId: alice.userId, tokenHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + 1000).toISOString() });

    const res = await call('DELETE', '/api/account', { password: 'alice-password-1' }, { cookie: alice.cookie });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);

    // Alice is gone, entirely.
    assert.equal(data.findUserById(alice.userId), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM applications WHERE user_id = ?').get(alice.userId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_profiles WHERE user_id = ?').get(alice.userId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?').get(alice.userId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_confirmations WHERE user_id = ?').get(alice.userId).n, 0);
    assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM notifications_sent WHERE profile_id = ?').get(profileInfo.lastInsertRowid).n,
        0,
        'notifications_sent tied to Alice\'s profile must go too, even with no user_id column of its own'
    );

    // Bob is completely untouched.
    assert.ok(data.findUserById(bob.userId), 'a second account must survive the first one\'s deletion');
    const bobApplication = db.prepare('SELECT status FROM applications WHERE user_id = ? AND job_snapshot_id = ?').get(bob.userId, jobId);
    assert.equal(bobApplication.status, 'saved');

    // Shared data — the job and the company — is never touched by deleting a
    // personal account.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_snapshots WHERE id = ?').get(jobId).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM watched_companies WHERE id = ?').get(companyId).n, 1);
});

test('after deletion, the old credentials can no longer log in', async () => {
    const { cookie } = await registerAccount('gone-login@example.com', 'a-fine-password-1');
    await call('DELETE', '/api/account', { password: 'a-fine-password-1' }, { cookie });

    const login = await call('POST', '/api/login', { email: 'gone-login@example.com', password: 'a-fine-password-1' });
    assert.equal(login.statusCode, 401);
});

test('the session cookie stops verifying immediately after deletion', async () => {
    const { cookie } = await registerAccount('gone-session@example.com', 'a-fine-password-1');
    await call('DELETE', '/api/account', { password: 'a-fine-password-1' }, { cookie });

    const session = await call('GET', '/api/session', null, { cookie });
    assert.equal(session.body.authenticated, false);
});

// ---------------------------------------------------------------------------
// Rate limiting — reuses rateLimit.js's accountDelete policy, not a new limiter
// ---------------------------------------------------------------------------

test('repeated wrong-password attempts against the same account are capped (5/15min)', async () => {
    const { cookie } = await registerAccount('capped-delete@example.com', 'the-real-password-2');

    for (let i = 0; i < 5; i++) {
        const res = await call('DELETE', '/api/account', { password: 'nope' }, { cookie });
        assert.equal(res.statusCode, 400, `attempt ${i + 1} should be a normal rejection, not a rate limit`);
    }

    const sixth = await call('DELETE', '/api/account', { password: 'nope' }, { cookie });
    assert.equal(sixth.statusCode, 429);
    assert.ok(Number(sixth.headers['Retry-After']) > 0);

    // The account survives being hammered — rate limiting refuses the
    // request before it ever reaches the password check.
    const session = await call('GET', '/api/session', null, { cookie });
    assert.equal(session.body.authenticated, true);
});
