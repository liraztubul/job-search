process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { addCompany, setCompanyActive } = require('../server/data/companies');

/**
 * What a cycle leaves behind when the DATABASE fails part-way — not an
 * adapter (those are per-company failures, see scrapeService.test.js), but
 * an exception escaping runCycle itself, the way the dropped Turso
 * connection in TURSO-DROP-PROMPT.md did. Its own file so each test controls
 * exactly which companies are active, and so the patches below can't leak
 * into scrapeService.test.js.
 *
 * Same seam as scrapeService.test.js: buildAdapter is patched on the module
 * object before scrapeService is required. The database failure is simulated
 * by patching `data.countOpenJobs` — scrapeService calls it as `data.x`, not
 * a destructured reference, and it is the first DB call after a successful
 * fetch, so throwing there is exactly "the database died mid-cycle".
 */
const adaptersModule = require('../server/adapters');
adaptersModule.buildAdapter = (company) => ({
    getCurrentJobs: async () => [{ externalId: `${company.id}-1`, title: 'Job', location: 'Tel Aviv', applyUrl: 'https://example.com' }],
});

const data = require('../server/data');
const { runCycle } = require('../server/services/scrapeService');
const { getLastScrapeRun } = require('../server/data/scrapeRuns');

const DROPPED = 'Hrana(Http("connection closed before message completed"))';
const realCountOpenJobs = data.countOpenJobs;
const realRecordScrapeRun = data.recordScrapeRun;

/** Deactivates everything earlier tests left active, then seeds `n` fresh companies. */
function freshCompanies(n) {
    for (const c of data.getActiveCompanies()) setCompanyActive(c.id, false);
    return Array.from({ length: n }, (_, i) => {
        const name = `Crash ${i} ${Math.random()}`;
        addCompany({ name, careerUrl: '', adapterType: 'manual', config: {} });
        return name;
    });
}

/** Makes the `failOnCall`-th countOpenJobs call (1-based) throw the dropped-connection error. */
function databaseDiesOnCall(failOnCall) {
    let calls = 0;
    data.countOpenJobs = (...args) => {
        calls++;
        if (calls === failOnCall) throw new Error(DROPPED);
        return realCountOpenJobs(...args);
    };
}

test.afterEach(() => {
    data.countOpenJobs = realCountOpenJobs;
    data.recordScrapeRun = realRecordScrapeRun;
});

test('a crash after some companies were refreshed still records the run, naming what was missed — and still throws', async () => {
    const names = freshCompanies(3);
    databaseDiesOnCall(2);
    const order = [];
    const before = getLastScrapeRun();

    await assert.rejects(
        runCycle((e) => e.type === 'company:start' && order.push(e.company)),
        (err) => err.message === DROPPED && err.crashedAt === order[1]
    );

    const run = getLastScrapeRun();
    assert.notEqual(run?.id, before?.id, 'a new scrape_runs row was written');
    assert.equal(run.companies, 3);
    // Never started, so not in `order` — it's whichever seeded company is left.
    const notReached = names.find((n) => !order.includes(n));
    assert.equal(order.length, 2, 'the third company was never even started');
    const details = JSON.parse(run.failure_details);
    assert.deepEqual(details.map((f) => [f.company, f.kind]), [
        [order[1], 'broken'],
        [notReached, 'not-reached'],
    ]);
    assert.match(details[0].error, /cycle crashed here: Hrana\(Http\("connection closed/);
    assert.ok(details.every((f) => f.loud));
    // The first company's data really was written before the crash.
    assert.equal(data.countOpenJobs(data.getActiveCompanies().find((c) => c.name === order[0]).id), 1);
});

test('a crash before any company was refreshed writes no row — "last updated" must not move', async () => {
    freshCompanies(2);
    databaseDiesOnCall(1);
    const before = getLastScrapeRun();

    await assert.rejects(runCycle(), (err) => err.message === DROPPED);

    assert.equal(getLastScrapeRun()?.id, before?.id);
});

test('if recording the crashed run fails too, the ORIGINAL error is what propagates', async () => {
    freshCompanies(3);
    databaseDiesOnCall(2);
    data.recordScrapeRun = () => {
        throw new Error('Hrana(Http("connection closed before message completed")) — second time');
    };
    const logged = [];
    const realError = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
        await assert.rejects(runCycle(), (err) => err.message === DROPPED);
    } finally {
        console.error = realError;
    }
    assert.ok(logged.some((l) => /Could not record the crashed cycle either/.test(l)));
});

test('a cycle with no crash is unchanged: one row, no crash entries', async () => {
    freshCompanies(2);
    const summary = await runCycle();
    assert.equal(summary.failures.length, 0);
    const run = getLastScrapeRun();
    assert.equal(run.failures, 0);
    assert.equal(run.failure_details, null);
});
