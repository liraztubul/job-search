const test = require('node:test');
const assert = require('node:assert');
const {
    createSlidingWindowLimiter,
    createAuthRateLimiter,
    getClientIp,
    normalizeAccountKey,
} = require('../server/web/middleware/rateLimit');

/** A clock the test controls, so nothing here ever sleeps for real. */
function fakeClock(startMs = 1_000_000) {
    let now = startMs;
    return { now: () => now, advance: (ms) => { now += ms; } };
}

const fakeReq = ({ headers = {}, remoteAddress = '198.51.100.1' } = {}) => ({
    headers,
    socket: { remoteAddress },
});

// ---------------------------------------------------------------------------
// Sliding window: opening and closing on an injected clock
// ---------------------------------------------------------------------------

test('sliding window: allows up to max, blocks the next, reopens once the window passes', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 3, now: clock.now });

    assert.equal(limiter.record('a').blocked, false);
    assert.equal(limiter.record('a').blocked, false);
    assert.equal(limiter.record('a').blocked, false);

    const fourth = limiter.record('a');
    assert.equal(fourth.blocked, true);
    assert.ok(fourth.retryAfterSec >= 1);

    // Not yet expired.
    clock.advance(999);
    assert.equal(limiter.status('a').blocked, true);

    // Now the oldest of the three timestamps has aged out of the window.
    clock.advance(2);
    assert.equal(limiter.status('a').blocked, false);
    assert.equal(limiter.record('a').blocked, false);
});

test('status() is read-only and never creates an entry for an unseen key', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 2, now: clock.now, cap: 5 });

    assert.deepEqual(limiter.status('never-seen'), { blocked: false, retryAfterSec: 0 });
    assert.equal(limiter.size(), 0);
});

test('different keys have independent budgets', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 1, now: clock.now });

    assert.equal(limiter.record('x').blocked, false);
    assert.equal(limiter.record('x').blocked, true);
    // 'y' has never been recorded, so it is unaffected by 'x' being blocked.
    assert.equal(limiter.record('y').blocked, false);
});

// ---------------------------------------------------------------------------
// Bounded memory: the key cap
// ---------------------------------------------------------------------------

test('key cap holds under a flood of distinct identifiers, and fails closed', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 5, cap: 100, now: clock.now });

    for (let i = 0; i < 100; i++) {
        assert.equal(limiter.record(`id-${i}`).blocked, false);
    }
    assert.equal(limiter.size(), 100);

    // The map is full and nothing has expired — a brand new identifier cannot
    // be safely tracked, so the request is refused rather than let through
    // untracked or grown past the cap.
    const overflow = limiter.record('id-overflow');
    assert.equal(overflow.blocked, true);
    assert.ok(limiter.size() <= 100, 'store must never exceed its cap');

    // An already-tracked key is unaffected by the cap — this isn't global
    // lockout, just a refusal to start tracking anything new.
    assert.equal(limiter.status('id-0').blocked, false);
});

test('cap frees up once entries expire, instead of staying full forever', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 5, cap: 2, now: clock.now });

    limiter.record('a');
    limiter.record('b');
    assert.equal(limiter.size(), 2);

    // Both 'a' and 'b' are still full-cap; a third key is refused.
    assert.equal(limiter.record('c').blocked, true);

    // Once the window passes, 'a' and 'b' are stale and can be evicted to
    // make room — memory does not grow forever just because keys keep changing.
    clock.advance(1001);
    assert.equal(limiter.record('c').blocked, false);
    assert.ok(limiter.size() <= 2);
});

// ---------------------------------------------------------------------------
// Two independent counters (the actual auth policy)
// ---------------------------------------------------------------------------

test('login: per-IP and per-account limits trip independently', () => {
    const clock = fakeClock();
    const limiter = createAuthRateLimiter({ now: clock.now });

    // Exhaust the account budget (max 5) for one account from one IP.
    for (let i = 0; i < 5; i++) {
        assert.equal(limiter.isBlocked('login', { ip: '1.2.3.4', account: 'a@x.com' }).blocked, false);
        limiter.recordAttempt('login', { ip: '1.2.3.4', account: 'a@x.com' });
    }
    assert.equal(limiter.isBlocked('login', { ip: '1.2.3.4', account: 'a@x.com' }).blocked, true);

    // A different account from the SAME ip is unaffected — the account
    // counter, not the IP counter, is what tripped.
    assert.equal(limiter.isBlocked('login', { ip: '1.2.3.4', account: 'b@x.com' }).blocked, false);
});

test('login: the IP counter trips on its own even when spread across many accounts', () => {
    const clock = fakeClock();
    const limiter = createAuthRateLimiter({ now: clock.now });

    // 20 failed attempts against 20 different accounts, all from one IP —
    // the credential-spraying shape an account-only limit would miss.
    for (let i = 0; i < 20; i++) {
        const keys = { ip: '9.9.9.9', account: `user${i}@x.com` };
        assert.equal(limiter.isBlocked('login', keys).blocked, false);
        limiter.recordAttempt('login', keys);
    }
    assert.equal(limiter.isBlocked('login', { ip: '9.9.9.9', account: 'user999@x.com' }).blocked, true);
});

test('successful logins never call recordAttempt, so they cannot exhaust the account budget', () => {
    // This is enforced by the caller (routes/index.js only records on a
    // failed authenticate()), not by the limiter itself — this test documents
    // that recordAttempt is exactly and only what spends the budget.
    const clock = fakeClock();
    const limiter = createAuthRateLimiter({ now: clock.now });
    const keys = { ip: '1.1.1.1', account: 'frequent@x.com' };

    for (let i = 0; i < 50; i++) {
        assert.equal(limiter.isBlocked('login', keys).blocked, false);
        // no recordAttempt() call: simulates 50 successful logins
    }
});

// ---------------------------------------------------------------------------
// getClientIp — the bug the prompt warned would happen
// ---------------------------------------------------------------------------

test('JT_TRUST_PROXY unset: proxy headers are ignored, socket address wins', () => {
    const saved = process.env.JT_TRUST_PROXY;
    delete process.env.JT_TRUST_PROXY;
    try {
        const req = fakeReq({
            headers: { 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.10' },
            remoteAddress: '172.19.0.2', // Fly's internal proxy, same for every request
        });
        assert.equal(getClientIp(req), '172.19.0.2');
    } finally {
        if (saved === undefined) delete process.env.JT_TRUST_PROXY;
        else process.env.JT_TRUST_PROXY = saved;
    }
});

test('JT_TRUST_PROXY=1: Fly-Client-IP is trusted', () => {
    const saved = process.env.JT_TRUST_PROXY;
    process.env.JT_TRUST_PROXY = '1';
    try {
        const req = fakeReq({
            headers: { 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.10' },
            remoteAddress: '172.19.0.2',
        });
        assert.equal(getClientIp(req), '203.0.113.9');
    } finally {
        if (saved === undefined) delete process.env.JT_TRUST_PROXY;
        else process.env.JT_TRUST_PROXY = saved;
    }
});

test('JT_TRUST_PROXY=1: falls back to the leftmost X-Forwarded-For entry when Fly-Client-IP is absent', () => {
    const saved = process.env.JT_TRUST_PROXY;
    process.env.JT_TRUST_PROXY = '1';
    try {
        const req = fakeReq({
            headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1, 10.0.0.2' },
            remoteAddress: '172.19.0.2',
        });
        assert.equal(getClientIp(req), '203.0.113.10');
    } finally {
        if (saved === undefined) delete process.env.JT_TRUST_PROXY;
        else process.env.JT_TRUST_PROXY = saved;
    }
});

test('JT_TRUST_PROXY=1: with neither header present, still falls back to the socket', () => {
    const saved = process.env.JT_TRUST_PROXY;
    process.env.JT_TRUST_PROXY = '1';
    try {
        const req = fakeReq({ headers: {}, remoteAddress: '172.19.0.2' });
        assert.equal(getClientIp(req), '172.19.0.2');
    } finally {
        if (saved === undefined) delete process.env.JT_TRUST_PROXY;
        else process.env.JT_TRUST_PROXY = saved;
    }
});

test('normalizeAccountKey: case- and whitespace-insensitive, matching normalizeEmail', () => {
    assert.equal(normalizeAccountKey('  Liraz@Example.com '), 'liraz@example.com');
    assert.equal(normalizeAccountKey(undefined), '');
});
