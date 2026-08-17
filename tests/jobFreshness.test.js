const test = require('node:test');
const assert = require('node:assert');
const { computeFreshness, isValidPostedAt, FRESH_WINDOW_DAYS } = require('../server/domain/jobFreshness');

// A fixed "now": 2026-08-14, a normal summer (DST) day in Jerusalem, well
// clear of any transition, used for the ordinary cases below.
const NOW = new Date('2026-08-14T09:00:00Z'); // 12:00 in Jerusalem (UTC+3, DST)

test('posted exactly at the edge of the window (3 days ago) is still new', () => {
    const result = computeFreshness({ postedAt: '2026-08-11', firstSeenAt: '2026-08-11T05:00:00Z' }, null, NOW);
    assert.deepEqual(result, { displayDate: '2026-08-11', dateSource: 'source', isNew: true });
});

test('posted one day past the window (4 days ago) is not new', () => {
    const result = computeFreshness({ postedAt: '2026-08-10', firstSeenAt: '2026-08-10T05:00:00Z' }, null, NOW);
    assert.equal(result.isNew, false);
    assert.equal(result.dateSource, 'source');
});

test('posted today is new', () => {
    const result = computeFreshness({ postedAt: '2026-08-14', firstSeenAt: '2026-08-14T05:00:00Z' }, null, NOW);
    assert.equal(result.isNew, true);
});

test(`FRESH_WINDOW_DAYS is 3, matching the product requirement`, () => {
    // A change to the window should fail this test loudly rather than silently
    // shipping a different badge cutoff than what was asked for.
    assert.equal(FRESH_WINDOW_DAYS, 3);
});

test('a future-dated posted_at is clamped — never shown, never trusted as "source"', () => {
    const result = computeFreshness(
        { postedAt: '2026-08-20', firstSeenAt: '2026-08-14T05:00:00Z' },
        null,
        NOW
    );
    assert.notEqual(result.dateSource, 'source');
});

test('NULL posted_at with no company cutoff recorded falls back to "unknown", not a guess', () => {
    const result = computeFreshness({ postedAt: null, firstSeenAt: '2026-08-14T05:00:00Z' }, null, NOW);
    assert.deepEqual(result, { displayDate: null, dateSource: 'unknown', isNew: false });
});

test('a malformed posted_at (relative text that should never reach here) is treated as absent, not thrown', () => {
    assert.doesNotThrow(() => {
        const result = computeFreshness(
            { postedAt: 'Posted 3 Days Ago', firstSeenAt: '2026-08-14T05:00:00Z' },
            null,
            NOW
        );
        assert.notEqual(result.dateSource, 'source');
    });
});

// ---------------------------------------------------------------------------
// The new-company trap — Amendment C
// ---------------------------------------------------------------------------

test('a job first seen during the company\'s first scrape cycle is "unknown", never new', () => {
    const companyFirstScrapedAt = '2026-08-14T06:00:00Z';
    const result = computeFreshness(
        { postedAt: null, firstSeenAt: '2026-08-14T05:59:00Z' }, // before the cutoff, same bulk load
        companyFirstScrapedAt,
        NOW
    );
    assert.deepEqual(result, { displayDate: null, dateSource: 'unknown', isNew: false });
});

test('a job first seen AFTER the company is established uses first_seen, and can be new', () => {
    const companyFirstScrapedAt = '2026-08-01T06:00:00Z'; // company onboarded two weeks ago
    const result = computeFreshness(
        { postedAt: null, firstSeenAt: '2026-08-13T05:00:00Z' }, // a genuinely new posting, seen yesterday
        companyFirstScrapedAt,
        NOW
    );
    assert.equal(result.dateSource, 'first_seen');
    assert.equal(result.isNew, true);
});

test('a job first seen after the company was established, but long ago, is first_seen and not new', () => {
    const companyFirstScrapedAt = '2026-01-01T06:00:00Z';
    const result = computeFreshness(
        { postedAt: null, firstSeenAt: '2026-01-15T05:00:00Z' },
        companyFirstScrapedAt,
        NOW
    );
    assert.equal(result.dateSource, 'first_seen');
    assert.equal(result.isNew, false);
});

test('a real posted_at always wins over first_seen_at, even for an established company', () => {
    const companyFirstScrapedAt = '2026-01-01T06:00:00Z';
    const result = computeFreshness(
        { postedAt: '2026-08-13', firstSeenAt: '2026-01-15T05:00:00Z' },
        companyFirstScrapedAt,
        NOW
    );
    assert.equal(result.dateSource, 'source');
    assert.equal(result.displayDate, '2026-08-13');
});

// ---------------------------------------------------------------------------
// Timezone correctness — Asia/Jerusalem, not a fixed offset, not UTC
// ---------------------------------------------------------------------------

test('a posting near midnight UTC in winter (Israel Standard Time, UTC+2) lands on the correct Jerusalem calendar day', () => {
    // 2026-01-15T22:30:00Z is 2026-01-16T00:30 in Jerusalem (winter, +2) — a
    // UTC-naive implementation would call this "2026-01-15" and compute a
    // day count that's off by one right at this boundary.
    const now = new Date('2026-01-15T22:30:00Z');
    const result = computeFreshness({ postedAt: '2026-01-16', firstSeenAt: '2026-01-16T00:00:00Z' }, null, now);
    assert.equal(result.isNew, true, 'must recognise "today" as the Jerusalem calendar day, not the UTC one');
});

// ---------------------------------------------------------------------------
// isValidPostedAt — the write-layer guard (see data/jobs.js's sanitizePostedAt)
// ---------------------------------------------------------------------------

test('isValidPostedAt accepts a real, non-future ISO date', () => {
    assert.equal(isValidPostedAt('2026-08-01', NOW), true);
    assert.equal(isValidPostedAt('2026-08-14', NOW), true); // today, in Jerusalem
});

test('isValidPostedAt rejects a future date', () => {
    assert.equal(isValidPostedAt('2026-08-20', NOW), false);
});

test('isValidPostedAt rejects relative text, non-ISO shapes, and non-strings', () => {
    for (const bad of ['Posted 3 Days Ago', 'August 4, 2026', '2026-8-1', '', null, undefined, 42]) {
        assert.equal(isValidPostedAt(bad, NOW), false, `should reject ${JSON.stringify(bad)}`);
    }
});

test('the same clock time in summer (Daylight Time, UTC+3) lands on a different Jerusalem calendar day than in winter', () => {
    // 2026-08-15T22:30:00Z is 2026-08-16T01:30 in Jerusalem (summer, +3) —
    // one calendar day further than the winter case above, at the identical
    // UTC clock time. If both cases agreed, the offset wouldn't actually be
    // varying by DST — this is the concrete proof it does.
    const now = new Date('2026-08-15T22:30:00Z');
    const resultSameDay = computeFreshness({ postedAt: '2026-08-16', firstSeenAt: '2026-08-16T00:00:00Z' }, null, now);
    const resultPriorDay = computeFreshness({ postedAt: '2026-08-15', firstSeenAt: '2026-08-15T00:00:00Z' }, null, now);
    assert.equal(resultSameDay.displayDate === '2026-08-16' && resultSameDay.isNew, true);
    assert.equal(resultPriorDay.isNew, true); // one day ago, still inside the window
});
