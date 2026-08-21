const test = require('node:test');
const assert = require('node:assert');
// main.js only fires a real scrape cycle when run directly (require.main ===
// module) — see the guard there — so requiring it here for its two exported
// pure helpers is safe and does not touch the network or a database.
const { summarizeFailures, needsAttention } = require('../server/main');
const { FAILURE_KIND } = require('../server/domain/scrapeOutcome');

const failure = (company, kind, extra = {}) => ({ company, kind, loud: false, acknowledged: false, error: 'x', ...extra });

test('needsAttention keeps only loud failures', () => {
    const failures = [
        failure('A', FAILURE_KIND.EMPTY, { loud: false }),
        failure('B', FAILURE_KIND.BROKEN, { loud: true }),
        failure('C', FAILURE_KIND.REFUSED, { loud: false }),
    ];
    assert.deepEqual(needsAttention(failures).map((f) => f.company), ['B']);
});

test('a clean run (no failures) summarizes to just "0 broken"', () => {
    assert.deepEqual(summarizeFailures([]), ['  0 broken']);
});

test('empty-kind failures list the companies and pluralize correctly', () => {
    assert.deepEqual(summarizeFailures([failure('Snyk Israel', FAILURE_KIND.EMPTY)]), [
        '  1 company with no matching jobs (expected): Snyk Israel',
        '  0 broken',
    ]);
    const two = summarizeFailures([failure('Snyk Israel', FAILURE_KIND.EMPTY), failure('Broadcom Israel', FAILURE_KIND.EMPTY)]);
    assert.equal(two[0], '  2 companies with no matching jobs (expected): Snyk Israel, Broadcom Israel');
});

test('refused failures show their ordinal refusal count', () => {
    const lines = summarizeFailures([failure('Palo Alto Networks Israel', FAILURE_KIND.REFUSED, { refusalStreak: 1 })]);
    assert.deepEqual(lines, ['  1 held back by the sanity gate: Palo Alto Networks Israel (1st refusal)', '  0 broken']);
});

test('blocked failures split into acknowledged and not-yet-acknowledged lines', () => {
    const lines = summarizeFailures([failure('Check Point Israel', FAILURE_KIND.BLOCKED, { acknowledged: true })]);
    assert.deepEqual(lines, ['  1 blocked, already acknowledged: Check Point Israel', '  0 broken']);

    const unacked = summarizeFailures([failure('New Blocked Co', FAILURE_KIND.BLOCKED, { acknowledged: false })]);
    assert.deepEqual(unacked, ['  1 blocked, NOT acknowledged (see tools/acknowledge-issue.js): New Blocked Co', '  0 broken']);
});

test('broken failures are named on the "0 broken" line, which always prints even at zero', () => {
    const lines = summarizeFailures([failure('NVIDIA Israel', FAILURE_KIND.BROKEN)]);
    assert.deepEqual(lines, ['  1 broken: NVIDIA Israel']);
});

test('the exact four-kind example from the task spec renders as specified', () => {
    const lines = summarizeFailures([
        failure('Snyk Israel', FAILURE_KIND.EMPTY),
        failure('Broadcom Israel', FAILURE_KIND.EMPTY),
        failure('Palo Alto Networks Israel', FAILURE_KIND.REFUSED, { refusalStreak: 1 }),
        failure('Check Point Israel', FAILURE_KIND.BLOCKED, { acknowledged: true }),
    ]);
    assert.deepEqual(lines, [
        '  2 companies with no matching jobs (expected): Snyk Israel, Broadcom Israel',
        '  1 held back by the sanity gate: Palo Alto Networks Israel (1st refusal)',
        '  1 blocked, already acknowledged: Check Point Israel',
        '  0 broken',
    ]);
});
