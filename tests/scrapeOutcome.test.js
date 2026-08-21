const test = require('node:test');
const assert = require('node:assert');
const {
    FAILURE_KIND,
    LOUD_KINDS,
    ScrapeError,
    classifyHttpStatus,
    classifyFailure,
    shouldGoRed,
} = require('../server/domain/scrapeOutcome');

test('classifyHttpStatus: 403 and 429 are blocked, everything else not-ok is broken', () => {
    assert.equal(classifyHttpStatus(403), FAILURE_KIND.BLOCKED);
    assert.equal(classifyHttpStatus(429), FAILURE_KIND.BLOCKED);
    assert.equal(classifyHttpStatus(500), FAILURE_KIND.BROKEN);
    assert.equal(classifyHttpStatus(404), FAILURE_KIND.BROKEN);
    assert.equal(classifyHttpStatus(400), FAILURE_KIND.BROKEN);
});

test('a ScrapeError carries the kind it was given', () => {
    const err = new ScrapeError('site says no', FAILURE_KIND.BLOCKED);
    assert.equal(err.kind, FAILURE_KIND.BLOCKED);
    assert.equal(err.message, 'site says no');
    assert.ok(err instanceof Error, 'must still be a real Error — instanceof checks elsewhere must not break');
});

test('a ScrapeError with no kind given defaults to broken', () => {
    assert.equal(new ScrapeError('something happened').kind, FAILURE_KIND.BROKEN);
});

test('classifyFailure trusts a valid kind already on the error', () => {
    assert.equal(classifyFailure(new ScrapeError('x', FAILURE_KIND.EMPTY)), FAILURE_KIND.EMPTY);
    assert.equal(classifyFailure(new ScrapeError('x', FAILURE_KIND.BLOCKED)), FAILURE_KIND.BLOCKED);
});

test('classifyFailure defaults a plain, unclassified Error to broken — this is the point, not a gap', () => {
    assert.equal(classifyFailure(new Error('the site changed shape')), FAILURE_KIND.BROKEN);
});

test('classifyFailure defaults an error with a garbage/forged kind to broken too', () => {
    const err = new Error('x');
    err.kind = 'not-a-real-kind';
    assert.equal(classifyFailure(err), FAILURE_KIND.BROKEN);
});

test('LOUD_KINDS is exactly broken and blocked — empty and refused are quiet by design', () => {
    assert.deepEqual([...LOUD_KINDS].sort(), [FAILURE_KIND.BLOCKED, FAILURE_KIND.BROKEN].sort());
});

test('shouldGoRed: broken and blocked go red with no acknowledgment', () => {
    assert.equal(shouldGoRed(FAILURE_KIND.BROKEN), true);
    assert.equal(shouldGoRed(FAILURE_KIND.BLOCKED), true);
});

test('shouldGoRed: empty and refused never go red, acknowledged or not', () => {
    assert.equal(shouldGoRed(FAILURE_KIND.EMPTY), false);
    assert.equal(shouldGoRed(FAILURE_KIND.REFUSED), false);
    assert.equal(shouldGoRed(FAILURE_KIND.EMPTY, FAILURE_KIND.BROKEN), false);
});

test('shouldGoRed: acknowledging a kind mutes exactly that kind for that company', () => {
    assert.equal(shouldGoRed(FAILURE_KIND.BLOCKED, FAILURE_KIND.BLOCKED), false);
});

test('shouldGoRed: acknowledging one kind does not mute a different kind from the same company', () => {
    assert.equal(shouldGoRed(FAILURE_KIND.BROKEN, FAILURE_KIND.BLOCKED), true);
});
