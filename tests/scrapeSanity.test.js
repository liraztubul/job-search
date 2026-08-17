const test = require('node:test');
const assert = require('node:assert');
const { evaluateSanityGate, SANITY_DROP_RATIO } = require('../server/domain/scrapeSanity');

/**
 * The bug this gate exists to prevent: a career site changes its markup, an
 * adapter's parser silently returns [], and the diff concludes "every job
 * closed" — the exact failure mode Elbit's 66 already-vanished postings
 * showed was a real risk in the opposite direction (jobs staying open
 * forever with nothing ever closing them). This is the other half: closing
 * too eagerly, on a broken scraper's word.
 */

test('a company with no prior open jobs is always trusted, however few jobs come back', () => {
    assert.deepEqual(evaluateSanityGate(0, 0), { trusted: true });
    assert.deepEqual(evaluateSanityGate(0, 5), { trusted: true });
});

test('returning zero jobs for a company that had some is refused', () => {
    const verdict = evaluateSanityGate(425, 0);
    assert.equal(verdict.trusted, false);
    assert.match(verdict.reason, /returned 0 jobs, had 425 open before/);
});

test('a steep drop (under 50%) is refused even when some jobs came back', () => {
    const verdict = evaluateSanityGate(100, 40);
    assert.equal(verdict.trusted, false);
    assert.match(verdict.reason, /returned 40 job\(s\), had 100 open before/);
});

test('exactly at the 50% threshold is trusted; one below it is refused', () => {
    assert.equal(SANITY_DROP_RATIO, 0.5);
    // 50 is exactly openBefore * SANITY_DROP_RATIO for openBefore=100 — the
    // gate is a strict "<", so the boundary itself is still on the trusted side.
    assert.deepEqual(evaluateSanityGate(100, 50), { trusted: true });
    assert.equal(evaluateSanityGate(100, 49).trusted, false);
});

test('a normal, healthy result (roughly the same count) is trusted', () => {
    assert.deepEqual(evaluateSanityGate(100, 98), { trusted: true });
    assert.deepEqual(evaluateSanityGate(100, 110), { trusted: true });
});
