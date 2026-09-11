const test = require('node:test');
const assert = require('node:assert');
const { fetchWithRetry } = require('../server/adapters/httpRetry');

/** Every mocked response in this file uses Retry-After: 0 (or omits it and
 * relies on backoff for the "no header" case) so a real retry in these tests
 * costs milliseconds, not the real 2s/4s backoff a live 429 would get —
 * that schedule itself is proven separately, without a network or a timer,
 * in tests/retryPolicy.test.js. */

function fakeResponse(status, { retryAfter } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
    };
}

function withFetch(t, impl) {
    const original = global.fetch;
    global.fetch = impl;
    t.after(() => { global.fetch = original; });
}

test('a 200 on the first try is returned immediately, no retry', async (t) => {
    let calls = 0;
    withFetch(t, async () => { calls++; return fakeResponse(200); });

    const res = await fetchWithRetry('https://example.com', undefined, { label: 'x' });
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
});

test('a 429 with Retry-After is retried and eventually succeeds', async (t) => {
    let calls = 0;
    withFetch(t, async () => {
        calls++;
        if (calls === 1) return fakeResponse(429, { retryAfter: '0' });
        return fakeResponse(200);
    });

    const res = await fetchWithRetry('https://example.com', undefined, { label: 'x' });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
});

test('a 503 is retried the same as a 429', async (t) => {
    let calls = 0;
    withFetch(t, async () => {
        calls++;
        if (calls === 1) return fakeResponse(503, { retryAfter: '0' });
        return fakeResponse(200);
    });

    const res = await fetchWithRetry('https://example.com', undefined, { label: 'x' });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
});

test('a 403 is never retried — one call, the 403 comes straight back', async (t) => {
    let calls = 0;
    withFetch(t, async () => { calls++; return fakeResponse(403); });

    const res = await fetchWithRetry('https://example.com', undefined, { label: 'x' });
    assert.equal(res.status, 403);
    assert.equal(calls, 1);
});

test('a 429 that never recovers is returned after the attempt cap, not retried forever', async (t) => {
    let calls = 0;
    withFetch(t, async () => { calls++; return fakeResponse(429, { retryAfter: '0' }); });

    const res = await fetchWithRetry('https://example.com', undefined, { label: 'x' });
    assert.equal(res.status, 429);
    assert.ok(calls >= 2 && calls <= 3, `expected 2-3 attempts, got ${calls}`);
});

test('a Retry-After beyond the cap gives up immediately rather than sleeping through it', async (t) => {
    let calls = 0;
    withFetch(t, async () => { calls++; return fakeResponse(429, { retryAfter: '3600' }); });

    const start = Date.now();
    const res = await fetchWithRetry('https://example.com', undefined, { label: 'x' });
    const elapsed = Date.now() - start;

    assert.equal(res.status, 429);
    assert.equal(calls, 1, 'must not have retried at all');
    assert.ok(elapsed < 1000, `must not have actually waited anywhere near the 3600s header (took ${elapsed}ms)`);
});
