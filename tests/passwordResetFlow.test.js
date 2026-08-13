// Isolated in-memory DB — must be set before anything in server/data/ is
// required. See tests/jobs.test.js for why this is safe across test files.
process.env.JT_DB_PATH = ':memory:';
process.env.JT_SESSION_SECRET = 'test-secret-not-for-production';
// BREVO_API_KEY deliberately left unset: every send() call in this file goes
// through the console-log fallback, never a real network request — see the
// dedicated assertion for that below.

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { db } = require('../server/data/connection');
const { handleApi } = require('../server/web/routes');
const users = require('../server/services/userService');
const verification = require('../server/services/verificationService');
const emailService = require('../server/services/emailService');
const data = require('../server/data');

function fakeReq(method, body, { remoteAddress = '203.0.113.60' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    req.method = method;
    req.headers = { host: '127.0.0.1:3000' };
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

// ---------------------------------------------------------------------------
// emailService — the console fallback, so the whole flow is testable with no
// account at any provider
// ---------------------------------------------------------------------------

test('emailService logs instead of sending when BREVO_API_KEY is unset', async () => {
    assert.equal(emailService.isConfigured(), false, 'this test file must not have a real key set');

    const originalFetch = global.fetch;
    let fetchWasCalled = false;
    global.fetch = () => { fetchWasCalled = true; throw new Error('must not be called'); };

    try {
        await assert.doesNotReject(() => emailService.sendPasswordReset('nobody@example.com', 'http://x/reset'));
        assert.equal(fetchWasCalled, false, 'no key configured must mean no network call, ever');
    } finally {
        global.fetch = originalFetch;
    }
});

// ---------------------------------------------------------------------------
// Full flow, through the real routes
// ---------------------------------------------------------------------------

test('request -> confirm changes the password and signs out every other session', async () => {
    const register = await call('POST', '/api/register', {
        email: 'flow@example.com',
        password: 'original-password-1',
    });
    assert.equal(register.statusCode, 201);
    const oldSessionCookie = register.headers['Set-Cookie'].split(';')[0].split('=')[1];

    // Capture the token the way the emailed link would have carried it — the
    // URL-builder callback is exactly what routes/index.js hands
    // verificationService in production, just intercepted here instead of
    // going through emailService's console-log fallback.
    let resetUrl;
    await verification.requestPasswordReset('flow@example.com', (token) => {
        resetUrl = `http://127.0.0.1:3000/reset.html?token=${token}`;
        return resetUrl;
    });
    const capturedToken = new URL(resetUrl).searchParams.get('token');

    const oldPasswordStillWorks = await call('POST', '/api/login', {
        email: 'flow@example.com',
        password: 'original-password-1',
    });
    assert.equal(oldPasswordStillWorks.statusCode, 200, 'old password must still work before the reset completes');

    const confirm = await call('POST', '/api/password-reset/confirm', {
        token: capturedToken,
        password: 'brand-new-password-2',
    });
    assert.equal(confirm.statusCode, 200);
    assert.equal(confirm.body.ok, true);

    const oldPasswordNowFails = await call('POST', '/api/login', {
        email: 'flow@example.com',
        password: 'original-password-1',
    });
    assert.equal(oldPasswordNowFails.statusCode, 401);

    const newPasswordWorks = await call('POST', '/api/login', {
        email: 'flow@example.com',
        password: 'brand-new-password-2',
    });
    assert.equal(newPasswordWorks.statusCode, 200);

    // The session cookie issued at registration must be dead now — this is
    // the actual point of session_epoch, exercised through the real routes
    // rather than by calling auth.js directly (see tests/sessionEpoch.test.js
    // for the unit-level version of this).
    const auth = require('../server/web/middleware/auth');
    assert.equal(auth.verifySession(oldSessionCookie), null);
});

test('confirming the same token twice fails the second time, with a distinct message', async () => {
    await users.register({ email: 'reuse@example.com', password: 'first-password-11' });

    let resetUrl;
    await verification.requestPasswordReset('reuse@example.com', (token) => {
        resetUrl = `http://x/reset.html?token=${token}`;
        return resetUrl;
    });
    const token = new URL(resetUrl).searchParams.get('token');

    const first = await call('POST', '/api/password-reset/confirm', { token, password: 'second-password-22' });
    assert.equal(first.statusCode, 200);

    const second = await call('POST', '/api/password-reset/confirm', { token, password: 'third-password-33' });
    assert.equal(second.statusCode, 400);
    assert.match(second.body.error, /already been used/);
});

test('an expired token is refused, distinctly from an unknown one', async () => {
    const result = await users.register({ email: 'expired@example.com', password: 'a-fine-password-1' });

    // Mint a token the same way the service does, but with an expiry already
    // in the past — the direct way to test this path without an injectable
    // clock, since the one-hour window isn't itself configurable.
    const crypto = require('crypto');
    const rawToken = crypto.randomBytes(32).toString('hex');
    data.createPasswordReset({
        userId: result.userId,
        tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() - 1000).toISOString(), // one second in the past
    });

    const res = await call('POST', '/api/password-reset/confirm', { token: rawToken, password: 'whatever-1234' });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /invalid or has expired/);
});

test('a token that never existed gets the same "invalid or expired" wording', async () => {
    const res = await call('POST', '/api/password-reset/confirm', {
        token: 'this-token-was-never-issued-by-anything',
        password: 'whatever-1234',
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /invalid or has expired/);
});

// ---------------------------------------------------------------------------
// No account-existence leak
// ---------------------------------------------------------------------------

test('requesting a reset for a known vs. unknown address is indistinguishable to the caller', async () => {
    await users.register({ email: 'known@example.com', password: 'a-fine-password-1' });

    const forKnown = await call('POST', '/api/password-reset/request', { email: 'known@example.com' });
    const forUnknown = await call('POST', '/api/password-reset/request', { email: 'never-registered@example.com' });

    assert.equal(forKnown.statusCode, forUnknown.statusCode);
    assert.deepEqual(forKnown.body, forUnknown.body);
});

test('only the known address actually creates a reset row', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n;

    await verification.requestPasswordReset('never-registered-2@example.com', (t) => `http://x/${t}`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n, before, 'no row for an unknown address');

    const result = await users.register({ email: 'row-check@example.com', password: 'a-fine-password-1' });
    await verification.requestPasswordReset('row-check@example.com', (t) => `http://x/${t}`);
    const after = db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?').get(result.userId).n;
    assert.equal(after, 1);
});

// ---------------------------------------------------------------------------
// The raw token is never stored
// ---------------------------------------------------------------------------

test('the stored value is a SHA-256 hash, never the raw token', async () => {
    let rawToken;
    await users.register({ email: 'hash-check@example.com', password: 'a-fine-password-1' });
    await verification.requestPasswordReset('hash-check@example.com', (token) => {
        rawToken = token;
        return `http://x/${token}`;
    });

    const row = db.prepare('SELECT token_hash FROM password_resets ORDER BY id DESC LIMIT 1').get();

    assert.notEqual(row.token_hash, rawToken);
    assert.equal(row.token_hash.length, 64, 'a SHA-256 hex digest is 64 characters');
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);

    // Belt and suspenders: the raw token string must not appear anywhere in
    // the table's data at all, hash column or otherwise.
    const allRows = db.prepare('SELECT * FROM password_resets').all();
    for (const stored of allRows) {
        assert.ok(!Object.values(stored).some((v) => v === rawToken), 'raw token leaked into a column');
    }
});

// ---------------------------------------------------------------------------
// Rate limiting — reuses server/web/middleware/rateLimit.js, not a new limiter
// ---------------------------------------------------------------------------

test('password-reset request is capped per IP (limit is 10/hour)', async () => {
    const ip = '198.51.100.40';
    for (let i = 0; i < 10; i++) {
        const res = await call('POST', '/api/password-reset/request', { email: `cap-${i}@example.com` }, { remoteAddress: ip });
        assert.equal(res.statusCode, 200, `request ${i + 1} should be allowed`);
    }
    const res = await call('POST', '/api/password-reset/request', { email: 'cap-overflow@example.com' }, { remoteAddress: ip });
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers['Retry-After']) > 0);
});

test('password-reset confirm is capped per token, independently of IP', async () => {
    // Five wrong confirms against the SAME (never-issued) token trip its own
    // counter; a confirm attempt against a DIFFERENT token from the same IP
    // is unaffected — same two-counter shape as login, keyed by token instead
    // of account.
    const ip = '198.51.100.41';
    for (let i = 0; i < 5; i++) {
        const res = await call(
            'POST',
            '/api/password-reset/confirm',
            { token: 'always-the-same-bad-token', password: 'whatever-1234' },
            { remoteAddress: ip }
        );
        assert.equal(res.statusCode, 400, `attempt ${i + 1} should be a normal rejection, not a rate limit`);
    }
    const sixthSameToken = await call(
        'POST',
        '/api/password-reset/confirm',
        { token: 'always-the-same-bad-token', password: 'whatever-1234' },
        { remoteAddress: ip }
    );
    assert.equal(sixthSameToken.statusCode, 429);

    const differentToken = await call(
        'POST',
        '/api/password-reset/confirm',
        { token: 'a-completely-different-bad-token', password: 'whatever-1234' },
        { remoteAddress: ip }
    );
    assert.equal(differentToken.statusCode, 400, 'a different token from the same IP must not be blocked yet');
});
