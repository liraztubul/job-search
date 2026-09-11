const test = require('node:test');
const assert = require('node:assert');
const {
    MAX_ATTEMPTS,
    BACKOFF_BASE_MS,
    shouldRetryStatus,
    parseRetryAfterMs,
    computeRetryDelay,
} = require('../server/domain/retryPolicy');

// ---------------------------------------------------------------------------
// shouldRetryStatus — only 429 and 503. Not 403, not a parse error, not a
// timeout (which never reaches this function as a status at all).
// ---------------------------------------------------------------------------

test('shouldRetryStatus is true for 429 and 503', () => {
    assert.equal(shouldRetryStatus(429), true);
    assert.equal(shouldRetryStatus(503), true);
});

test('shouldRetryStatus is false for 403 — a refusal, not congestion', () => {
    assert.equal(shouldRetryStatus(403), false);
});

test('shouldRetryStatus is false for everything else not-ok too', () => {
    for (const status of [400, 404, 500, 502]) assert.equal(shouldRetryStatus(status), false, String(status));
});

// ---------------------------------------------------------------------------
// parseRetryAfterMs — seconds or an HTTP-date, per RFC 9110 §10.2.3
// ---------------------------------------------------------------------------

test('parseRetryAfterMs reads a plain integer as seconds', () => {
    assert.equal(parseRetryAfterMs('5'), 5000);
    assert.equal(parseRetryAfterMs('0'), 0);
    assert.equal(parseRetryAfterMs('120'), 120000);
});

test('parseRetryAfterMs reads an HTTP-date relative to now', () => {
    const now = new Date('2026-09-11T12:00:00Z');
    const tenSecondsLater = 'Fri, 11 Sep 2026 12:00:10 GMT';
    assert.equal(parseRetryAfterMs(tenSecondsLater, now), 10000);
});

test('parseRetryAfterMs clamps a past HTTP-date to 0, not negative', () => {
    const now = new Date('2026-09-11T12:00:00Z');
    const inThePast = 'Fri, 11 Sep 2026 11:00:00 GMT';
    assert.equal(parseRetryAfterMs(inThePast, now), 0);
});

test('parseRetryAfterMs returns null for absent or unparseable values', () => {
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs(undefined), null);
    assert.equal(parseRetryAfterMs(''), null);
    assert.equal(parseRetryAfterMs('not a date or a number'), null);
});

// ---------------------------------------------------------------------------
// computeRetryDelay — the actual wait-or-give-up decision
// ---------------------------------------------------------------------------

test('honours Retry-After in seconds when under the cap', () => {
    const decision = computeRetryDelay({ attempt: 0, retryAfterHeader: '5' });
    assert.deepEqual(decision, { shouldWait: true, delayMs: 5000 });
});

test('honours Retry-After as an HTTP-date when under the cap', () => {
    const now = new Date('2026-09-11T12:00:00Z');
    const decision = computeRetryDelay({ attempt: 0, retryAfterHeader: 'Fri, 11 Sep 2026 12:00:05 GMT', now });
    assert.deepEqual(decision, { shouldWait: true, delayMs: 5000 });
});

test('a Retry-After beyond the cap is refused, not slept through', () => {
    const decision = computeRetryDelay({ attempt: 0, retryAfterHeader: '3600' });
    assert.equal(decision.shouldWait, false);
    assert.match(decision.reason, /exceeds/);
});

test('falls back to exponential backoff when Retry-After is absent', () => {
    const first = computeRetryDelay({ attempt: 0, retryAfterHeader: null });
    const second = computeRetryDelay({ attempt: 1, retryAfterHeader: null });
    assert.deepEqual(first, { shouldWait: true, delayMs: BACKOFF_BASE_MS });
    assert.deepEqual(second, { shouldWait: true, delayMs: BACKOFF_BASE_MS * 2 });
});

test('falls back to backoff when Retry-After is present but unparseable', () => {
    const decision = computeRetryDelay({ attempt: 0, retryAfterHeader: 'garbage' });
    assert.deepEqual(decision, { shouldWait: true, delayMs: BACKOFF_BASE_MS });
});

test('refuses to wait once MAX_ATTEMPTS would be exceeded, regardless of Retry-After', () => {
    const decision = computeRetryDelay({ attempt: MAX_ATTEMPTS - 1, retryAfterHeader: '1' });
    assert.equal(decision.shouldWait, false);
    assert.match(decision.reason, /attempts/);
});
