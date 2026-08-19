// Isolated in-memory DB — see tests/jobs.test.js for why this has to be set
// before anything in server/data/ is required.
process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { recordScrapeRun, getLastScrapeRun } = require('../server/data/scrapeRuns');

test('getLastScrapeRun returns null when no cycle has ever completed', () => {
    assert.equal(getLastScrapeRun(), null);
});

test('recordScrapeRun stores the summary a real cycle produces', () => {
    recordScrapeRun({
        startedAt: '2026-08-19T06:00:00.000Z',
        finishedAt: '2026-08-19T06:04:12.000Z',
        companies: 20,
        newJobs: 7,
        closedJobs: 2,
        failures: [],
    });

    const run = getLastScrapeRun();
    assert.equal(run.started_at, '2026-08-19T06:00:00.000Z');
    assert.equal(run.finished_at, '2026-08-19T06:04:12.000Z');
    assert.equal(run.companies, 20);
    assert.equal(run.new_jobs, 7);
    assert.equal(run.closed_jobs, 2);
    assert.equal(run.failures, 0);
    assert.equal(run.failure_details, null, 'no failures means no JSON blob, not an empty-array string');
});

test('getLastScrapeRun returns the most recently recorded run, not the first', () => {
    recordScrapeRun({
        startedAt: '2026-08-19T15:00:00.000Z',
        finishedAt: '2026-08-19T15:03:00.000Z',
        companies: 20,
        newJobs: 1,
        closedJobs: 0,
        failures: [{ company: 'IBM Israel', error: 'timeout' }],
    });

    const run = getLastScrapeRun();
    assert.equal(run.finished_at, '2026-08-19T15:03:00.000Z');
    assert.equal(run.failures, 1);
    assert.deepEqual(JSON.parse(run.failure_details), [{ company: 'IBM Israel', error: 'timeout' }]);
});

test('a run with some company failures is still recorded — a partial success still refreshed the rest', () => {
    const before = getLastScrapeRun();
    recordScrapeRun({
        startedAt: '2026-08-19T18:00:00.000Z',
        finishedAt: '2026-08-19T18:05:00.000Z',
        companies: 20,
        newJobs: 3,
        closedJobs: 1,
        failures: [{ company: 'A', error: 'x' }, { company: 'B', error: 'y' }],
    });

    const after = getLastScrapeRun();
    assert.notEqual(after.id, before.id, 'a new row must have been written');
    assert.equal(after.failures, 2);
});
