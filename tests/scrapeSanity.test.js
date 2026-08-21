const test = require('node:test');
const assert = require('node:assert');
const { evaluateSanityGate, SANITY_DROP_RATIO, closelyMatches } = require('../server/domain/scrapeSanity');

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

// ---------------------------------------------------------------------------
// Memory: a drop that reproduces closely on the very next cycle is accepted
// as a real, lasting reduction rather than refused forever. See the comment
// on evaluateSanityGate and on watched_companies.refusal_streak in schema.sql
// for why — this is what stops Palo Alto Networks-shaped situations (a
// genuine 318 -> 147 drop) from freezing a company's listings on a stale,
// unconfirmed number indefinitely.
// ---------------------------------------------------------------------------

test('with no previous refusal (null), a drop is refused exactly as before — no behaviour change for a first refusal', () => {
    assert.equal(evaluateSanityGate(318, 147, null).trusted, false);
});

test('a drop that closely matches the previously-refused count is accepted', () => {
    // 147 then 150 the next cycle — within 10% of each other.
    assert.deepEqual(evaluateSanityGate(318, 150, 147), { trusted: true });
});

test('an exact repeat of the previously-refused count is accepted', () => {
    assert.deepEqual(evaluateSanityGate(318, 147, 147), { trusted: true });
});

test('a drop that does NOT match the previous refusal is refused again, not accepted just because SOME previous refusal exists', () => {
    // Previous cycle refused at 147; this cycle returns 60 — a different,
    // unrelated drop, not a reproduction of the same one.
    const verdict = evaluateSanityGate(318, 60, 147);
    assert.equal(verdict.trusted, false);
    assert.match(verdict.reason, /returned 60 job\(s\)/);
});

test('memory only ever widens trust, never narrows it: a healthy result is trusted regardless of previousRefusedCount', () => {
    assert.deepEqual(evaluateSanityGate(100, 98, 5), { trusted: true });
});

test('a returned-0 drop can also be confirmed by memory — two closely-matching zeros in a row', () => {
    assert.deepEqual(evaluateSanityGate(50, 0, 0), { trusted: true });
});

test('closelyMatches is exported and matches the tolerance evaluateSanityGate actually uses', () => {
    assert.equal(closelyMatches(100, 100), true);
    assert.equal(closelyMatches(100, 109), true); // within 10% of the larger value
    assert.equal(closelyMatches(100, 120), false); // 20 apart, only 12 (10% of 120) tolerated
});
