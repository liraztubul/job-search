const test = require('node:test');
const assert = require('node:assert');
const { isStale, STALE_THRESHOLD_HOURS } = require('../server/domain/scrapeFreshness');

/**
 * Pure function, no database — the STALE_THRESHOLD_HOURS line is the one
 * thing the search page relies on to tell "the scrape is just running every
 * few hours like normal" apart from "the scheduler silently stopped."
 */

test('null (never scraped) is always stale', () => {
    assert.equal(isStale(null), true);
    assert.equal(isStale(undefined), true);
    assert.equal(isStale(''), true);
});

test('a garbage timestamp is treated as stale, not thrown on', () => {
    assert.equal(isStale('not-a-date'), true);
});

test('just finished is never stale', () => {
    assert.equal(isStale(new Date().toISOString()), false);
});

test(`exactly at the ${STALE_THRESHOLD_HOURS}-hour boundary is not yet stale`, () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const lastScrapeAt = new Date(now.getTime() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000).toISOString();
    assert.equal(isStale(lastScrapeAt, now), false, `exactly ${STALE_THRESHOLD_HOURS}h old is the last moment still considered fresh`);
});

test(`one second past the ${STALE_THRESHOLD_HOURS}-hour boundary is stale`, () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const lastScrapeAt = new Date(now.getTime() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000 - 1000).toISOString();
    assert.equal(isStale(lastScrapeAt, now), true);
});

test('well within the window (one missed run, not two) is not stale', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
    assert.equal(isStale(twelveHoursAgo, now), false);
});

test('well past the window (many missed runs) is stale', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const aWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isStale(aWeekAgo, now), true);
});
