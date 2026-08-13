// Isolated in-memory DB — must be set before anything in server/data/ is
// required. See tests/jobs.test.js for why this is safe across test files.
process.env.JT_DB_PATH = ':memory:';
process.env.JT_SESSION_SECRET = 'test-secret-not-for-production';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { handleApi } = require('../server/web/routes');
const users = require('../server/services/userService');

/**
 * End-to-end: real routes, real (in-memory) DB, real password hashing — the
 * only thing faked is the HTTP plumbing node:http would otherwise supply.
 * This is the scenario the hardening prompt's "definition of done" describes
 * directly: five wrong-password attempts against one account trip the limit,
 * and a sixth request against a *different* account from the same IP still
 * goes through — proving the IP and account counters are genuinely
 * independent, not one counter wearing two names.
 */

function fakeReq(body, { remoteAddress = '203.0.113.50' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.headers = {};
    req.socket = { remoteAddress };
    return req;
}

function fakeRes() {
    const headers = {};
    let statusCode;
    let rawBody;
    return {
        setHeader: (k, v) => { headers[k] = v; },
        writeHead: (status, hdrs) => {
            statusCode = status;
            Object.assign(headers, hdrs || {});
        },
        end: (b) => { rawBody = b; },
        get statusCode() { return statusCode; },
        get headers() { return headers; },
        get body() { return rawBody ? JSON.parse(rawBody) : undefined; },
    };
}

async function login({ email, password }, remoteAddress) {
    const res = fakeRes();
    await handleApi(fakeReq({ email, password }, { remoteAddress }), res, new URL('http://localhost/api/login'));
    return res;
}

test('five wrong-password attempts trip the account limit; a different account from the same IP is unaffected', async (t) => {
    const ip = '203.0.113.50';

    const accountA = await users.register({ email: 'account-a@example.com', password: 'correct-password-a' });
    const accountB = await users.register({ email: 'account-b@example.com', password: 'correct-password-b' });
    assert.ok(accountA.ok && accountB.ok);

    await t.test('five wrong attempts against account A each fail normally, not with 429', async () => {
        for (let i = 0; i < 5; i++) {
            const res = await login({ email: 'account-a@example.com', password: 'wrong-password' }, ip);
            assert.equal(res.statusCode, 401, `attempt ${i + 1} should be a normal auth failure`);
            assert.equal(res.body.error, 'wrong email or password');
        }
    });

    await t.test('a further attempt against account A is now rate-limited', async () => {
        const res = await login({ email: 'account-a@example.com', password: 'wrong-password' }, ip);
        assert.equal(res.statusCode, 429);
        assert.equal(res.body.error, 'too many attempts, try again later');
        assert.ok(Number(res.headers['Retry-After']) > 0, 'Retry-After header must be set and positive');
        assert.equal(res.body.retryAfterSec, Number(res.headers['Retry-After']));
    });

    await t.test('the same wording is used whether the account is real or not — no existence leak', async () => {
        // A brand new, never-registered email, blocked purely on a fresh
        // account-counter of its own would look identical in shape; what
        // matters here is that blocked and non-existent accounts never
        // produce distinguishable responses.
        const res = await login({ email: 'nobody-here@example.com', password: 'whatever' }, '198.51.100.77');
        assert.equal(res.statusCode, 401);
        assert.equal(res.body.error, 'wrong email or password');
    });

    await t.test('a request against a different account from the SAME ip still succeeds', async () => {
        // This is the two-counters-not-one proof: account A's counter is
        // tripped, but account B's counter and the shared IP counter (5 of 20
        // used) are both still open.
        const res = await login({ email: 'account-b@example.com', password: 'correct-password-b' }, ip);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.ok, true);
    });
});

test('registration is capped per IP regardless of outcome', async () => {
    const ip = '203.0.113.99';

    // The register policy's IP limit is 3/hour (see rateLimit.js POLICIES).
    for (let i = 0; i < 3; i++) {
        const res = fakeRes();
        await handleApi(
            fakeReq({ email: `reg-${i}@example.com`, password: 'a-fine-password-1' }, { remoteAddress: ip }),
            res,
            new URL('http://localhost/api/register')
        );
        assert.equal(res.statusCode, 201, `registration ${i + 1} should succeed`);
    }

    const res = fakeRes();
    await handleApi(
        fakeReq({ email: 'reg-overflow@example.com', password: 'a-fine-password-1' }, { remoteAddress: ip }),
        res,
        new URL('http://localhost/api/register')
    );
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers['Retry-After']) > 0);
});
