const test = require('node:test');
const assert = require('node:assert');
const { interleaveByPlatform } = require('../server/domain/scrapeOrder');

const co = (name, adapter_type) => ({ name, adapter_type });

test('same-platform tenants are never adjacent when another platform is available', () => {
    const companies = [
        co('GH-1', 'greenhouse'), co('GH-2', 'greenhouse'), co('GH-3', 'greenhouse'),
        co('WD-1', 'workday'), co('WD-2', 'workday'),
        co('EF-1', 'eightfold'),
    ];

    const ordered = interleaveByPlatform(companies);
    for (let i = 1; i < ordered.length; i++) {
        assert.notEqual(
            ordered[i].adapter_type,
            ordered[i - 1].adapter_type,
            `${ordered[i - 1].name} (${ordered[i - 1].adapter_type}) immediately followed by ${ordered[i].name} (${ordered[i].adapter_type})`
        );
    }
});

test('no company is lost or duplicated by reordering', () => {
    const companies = [co('A', 'x'), co('B', 'x'), co('C', 'y'), co('D', 'z'), co('E', 'x')];
    const ordered = interleaveByPlatform(companies);
    assert.deepEqual(ordered.map((c) => c.name).sort(), ['A', 'B', 'C', 'D', 'E']);
});

test('a single company (or a single platform) passes through unchanged in relative order', () => {
    const companies = [co('Only', 'manual')];
    assert.deepEqual(interleaveByPlatform(companies), companies);

    const onePlatform = [co('A', 'greenhouse'), co('B', 'greenhouse'), co('C', 'greenhouse')];
    assert.deepEqual(interleaveByPlatform(onePlatform).map((c) => c.name), ['A', 'B', 'C']);
});

test('each platform keeps its own companies in their original relative order', () => {
    const companies = [
        co('GH-1', 'greenhouse'), co('WD-1', 'workday'), co('GH-2', 'greenhouse'), co('WD-2', 'workday'), co('GH-3', 'greenhouse'),
    ];
    const ordered = interleaveByPlatform(companies);
    const greenhouseOrder = ordered.filter((c) => c.adapter_type === 'greenhouse').map((c) => c.name);
    const workdayOrder = ordered.filter((c) => c.adapter_type === 'workday').map((c) => c.name);
    assert.deepEqual(greenhouseOrder, ['GH-1', 'GH-2', 'GH-3']);
    assert.deepEqual(workdayOrder, ['WD-1', 'WD-2']);
});

test('an empty list stays empty', () => {
    assert.deepEqual(interleaveByPlatform([]), []);
});

test('a platform with far more tenants than any other still spreads out, not clumping at the end', () => {
    const companies = [
        ...Array.from({ length: 6 }, (_, i) => co(`GH-${i}`, 'greenhouse')),
        co('Solo', 'manual'),
    ];
    const ordered = interleaveByPlatform(companies);

    // This used to assert `soloIndex === 1` — the exact position the old
    // greedy round-robin happened to produce. That pinned the test to an
    // implementation detail rather than to the thing the function is for,
    // and it failed when the ordering got *better*: dealing one company per
    // platform per round puts Solo second and then leaves five Greenhouse
    // tenants in an unbroken row, which is precisely the hammering this
    // module exists to prevent.
    //
    // What actually matters is the longest unbroken run of one platform, so
    // that is what is asserted now. Centring Solo splits six tenants into
    // 3 + 3; putting it second splits them 1 + 5.
    const soloIndex = ordered.findIndex((c) => c.name === 'Solo');
    assert.ok(soloIndex > 0 && soloIndex < ordered.length - 1, `Solo was pushed to an end (index ${soloIndex})`);
    assert.equal(longestRun(ordered), 3);
});

/** The most consecutive companies sharing one adapter_type. */
function longestRun(ordered) {
    let run = 0;
    let worst = 0;
    for (let i = 0; i < ordered.length; i++) {
        run = i > 0 && ordered[i].adapter_type === ordered[i - 1].adapter_type ? run + 1 : 1;
        worst = Math.max(worst, run);
    }
    return worst;
}

/**
 * The bug this module was rewritten for, as a test rather than a story.
 *
 * A greedy round-robin deals from every platform in early rounds and from
 * only the biggest ones at the end, so spacing *decays* as the run goes on.
 * On the real company list Eightfold's four tenants came out at positions
 * 5, 15, 20, 23 — gaps of 10, 5, 3 — and the tenant sitting in that last
 * narrow gap (Qualcomm) was the one that came back `429 TOO MANY REQUESTS`
 * from the 2026-09-12 scheduled run, while the two in the wide gaps
 * succeeded.
 *
 * The property that prevents it: a platform's *last* gap must not be
 * dramatically tighter than its first. Shaped like the real list — two large
 * platforms that outlive everyone else, one small platform to protect.
 */
test('a platform keeps even spacing instead of bunching up as smaller platforms run out', () => {
    const companies = [
        ...Array.from({ length: 10 }, (_, i) => co(`WD-${i}`, 'workday')),
        ...Array.from({ length: 11 }, (_, i) => co(`GH-${i}`, 'greenhouse')),
        ...Array.from({ length: 4 }, (_, i) => co(`EF-${i}`, 'eightfold')),
        co('A', 'ashby'), co('C', 'comeet'), co('S', 'smartrecruiters'), co('W', 'wp-careers'),
    ];

    const ordered = interleaveByPlatform(companies);
    const positions = ordered
        .map((c, i) => ({ type: c.adapter_type, i }))
        .filter((e) => e.type === 'eightfold')
        .map((e) => e.i);

    const gaps = positions.slice(1).map((p, i) => p - positions[i]);

    // Every gap comparable to every other — no collapse at the tail. The old
    // implementation produced [10, 5, 3] here, failing on the last one.
    const smallest = Math.min(...gaps);
    const largest = Math.max(...gaps);
    assert.ok(smallest >= 5, `Eightfold tenants bunched to a gap of ${smallest}: ${JSON.stringify(gaps)}`);
    assert.ok(largest - smallest <= 8, `spacing decayed across the run: ${JSON.stringify(gaps)}`);
});

test('a two-tenant platform puts its pair as far apart as the run allows', () => {
    const companies = [
        ...Array.from({ length: 18 }, (_, i) => co(`GH-${i}`, 'greenhouse')),
        co('EF-0', 'eightfold'), co('EF-1', 'eightfold'),
    ];

    const ordered = interleaveByPlatform(companies);
    const [first, second] = ordered
        .map((c, i) => ({ type: c.adapter_type, i }))
        .filter((e) => e.type === 'eightfold')
        .map((e) => e.i);

    // Two tenants in a 20-company run belong near the quarter and
    // three-quarter marks, roughly half the run apart — not six apart
    // because a round-robin spent every other platform in the first rounds.
    assert.ok(second - first >= 8, `pair only ${second - first} apart in a ${ordered.length}-company run`);
});
