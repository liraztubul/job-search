process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { addCompany, setKnownIssue } = require('../server/data/companies');
const { upsertJobSnapshot } = require('../server/data/jobs');

/**
 * runCycle resolves real adapters through server/adapters' self-registering,
 * file-scanned registry — there is no seam to inject a fake one, and hitting
 * the real network from a test is obviously off the table. `buildAdapter` is
 * monkey-patched here, on the actual module object, BEFORE scrapeService is
 * required — scrapeService destructures `{ buildAdapter }` at its own
 * require time, capturing a reference, so this only works in that order.
 * `node --test` gives every file its own process, so this has no effect
 * outside this file.
 */
const adaptersModule = require('../server/adapters');
const behaviors = new Map(); // company name -> () => Promise<RawJob[]> | throws
adaptersModule.buildAdapter = (company) => ({
    getCurrentJobs: () => {
        const behavior = behaviors.get(company.name);
        if (!behavior) throw new Error(`test bug: no behavior registered for "${company.name}"`);
        return behavior();
    },
});

const { runCycle } = require('../server/services/scrapeService');
const { FAILURE_KIND, ScrapeError } = require('../server/domain/scrapeOutcome');

const rawJob = (id) => ({ externalId: id, title: `Job ${id}`, location: 'Tel Aviv', applyUrl: 'https://example.com' });

/** @returns {{id: number, name: string}} the ACTUAL row, name included — every
 * test must key `behaviors` and search summary.failures by this returned
 * `.name`, never by the label passed in, since addCompany needs a unique
 * name and this is what makes it one. */
function seedCompany(label) {
    const name = `${label} ${Math.random()}`;
    const id = addCompany({ name, careerUrl: '', adapterType: 'manual', config: {} });
    return { id, name };
}

/** Seeds `count` already-open jobs for a company, so countOpenJobs() (the
 * sanity gate's "openBefore") reads a real number instead of 0 — a company
 * with nothing open before is always trusted regardless of what comes back,
 * which is exactly NOT what these tests want to exercise. */
function seedOpenJobs(companyId, count) {
    for (let i = 0; i < count; i++) upsertJobSnapshot(companyId, rawJob(`seed-${companyId}-${i}`));
}

async function runFor(companyName) {
    const summary = await runCycle();
    return summary.failures.find((f) => f.company === companyName);
}

// ---------------------------------------------------------------------------
// Each kind assigned correctly
// ---------------------------------------------------------------------------

test('an adapter throwing a plain Error is classified broken', async () => {
    const company = seedCompany('Plain Broken');
    behaviors.set(company.name, () => { throw new Error('the site changed shape'); });

    const failure = await runFor(company.name);
    assert.equal(failure.kind, FAILURE_KIND.BROKEN);
    assert.equal(failure.loud, true);
});

test('an adapter throwing a ScrapeError(kind=blocked) is classified blocked', async () => {
    const company = seedCompany('Blocked Adapter');
    behaviors.set(company.name, () => { throw new ScrapeError('403 Forbidden', FAILURE_KIND.BLOCKED); });

    const failure = await runFor(company.name);
    assert.equal(failure.kind, FAILURE_KIND.BLOCKED);
    assert.equal(failure.loud, true);
});

test('an adapter throwing a ScrapeError(kind=empty) is classified empty and is quiet', async () => {
    const company = seedCompany('Empty Adapter');
    behaviors.set(company.name, () => { throw new ScrapeError('none matched the location filter', FAILURE_KIND.EMPTY); });

    const failure = await runFor(company.name);
    assert.equal(failure.kind, FAILURE_KIND.EMPTY);
    assert.equal(failure.loud, false);
});

test('the sanity gate refusing a first-time drop is classified refused and is quiet', async () => {
    const company = seedCompany('First Refusal');
    seedOpenJobs(company.id, 100);
    behaviors.set(company.name, () => Promise.resolve([rawJob('a'), rawJob('b')])); // 2 of 100 — a steep drop

    const failure = await runFor(company.name);
    assert.equal(failure.kind, FAILURE_KIND.REFUSED);
    assert.equal(failure.loud, false);
    assert.equal(failure.refusalStreak, 1);
});

// ---------------------------------------------------------------------------
// A run of only empty/refused failures must not need attention; a broken one must.
// (main.js's needsAttention() is just `.filter(f => f.loud)` — proven directly here.)
// ---------------------------------------------------------------------------

test('a run with only empty and (first-time) refused failures has nothing loud', async () => {
    const emptyCo = seedCompany('Quiet Empty');
    const refusedCo = seedCompany('Quiet Refused');
    seedOpenJobs(refusedCo.id, 50);
    behaviors.set(emptyCo.name, () => { throw new ScrapeError('nothing matched', FAILURE_KIND.EMPTY); });
    behaviors.set(refusedCo.name, () => Promise.resolve([rawJob('x')]));

    const summary = await runCycle();
    const mine = summary.failures.filter((f) => f.company === emptyCo.name || f.company === refusedCo.name);
    assert.equal(mine.length, 2);
    assert.ok(mine.every((f) => f.loud === false));
});

test('a broken failure makes needsAttention non-empty', async () => {
    const company = seedCompany('Loud Broken');
    behaviors.set(company.name, () => { throw new Error('boom'); });

    const failure = await runFor(company.name);
    assert.equal(failure.loud, true);
});

// ---------------------------------------------------------------------------
// known_issue acknowledgment mutes exactly the acknowledged kind
// ---------------------------------------------------------------------------

test('an acknowledged blocked company does not go red on a blocked failure', async () => {
    const company = seedCompany('Acknowledged Blocked');
    setKnownIssue(company.id, FAILURE_KIND.BLOCKED, 'known, blocks our IP');
    behaviors.set(company.name, () => { throw new ScrapeError('403', FAILURE_KIND.BLOCKED); });

    const failure = await runFor(company.name);
    assert.equal(failure.kind, FAILURE_KIND.BLOCKED);
    assert.equal(failure.acknowledged, true);
    assert.equal(failure.loud, false);
});

test('acknowledging blocked does NOT mute a different (broken) failure from the same company', async () => {
    const company = seedCompany('Acknowledged But Now Broken');
    setKnownIssue(company.id, FAILURE_KIND.BLOCKED, 'known, blocks our IP');
    behaviors.set(company.name, () => { throw new Error('totally unrelated parse error'); });

    const failure = await runFor(company.name);
    assert.equal(failure.kind, FAILURE_KIND.BROKEN);
    assert.equal(failure.acknowledged, false);
    assert.equal(failure.loud, true, 'a DIFFERENT kind of failure from an acknowledged company must still go red');
});

// ---------------------------------------------------------------------------
// Three consecutive refusals escalate to broken
// ---------------------------------------------------------------------------

test('three consecutive, non-matching refusals escalate to a broken (loud) failure', async () => {
    const company = seedCompany('Escalating');
    seedOpenJobs(company.id, 100);

    // Each count is deliberately far from the last refused one, so memory
    // never kicks in and accepts it — this is testing escalation, not memory.
    behaviors.set(company.name, () => Promise.resolve(Array.from({ length: 10 }, (_, i) => rawJob(`r1-${i}`))));
    const first = await runFor(company.name);
    assert.equal(first.kind, FAILURE_KIND.REFUSED);
    assert.equal(first.refusalStreak, 1);

    behaviors.set(company.name, () => Promise.resolve(Array.from({ length: 30 }, (_, i) => rawJob(`r2-${i}`))));
    const second = await runFor(company.name);
    assert.equal(second.kind, FAILURE_KIND.REFUSED);
    assert.equal(second.refusalStreak, 2);
    assert.equal(second.loud, false);

    // 45, not 50 — openBefore is 100 and the gate's threshold is a strict
    // "<", so exactly 50 is still trusted (see scrapeSanity.test.js's own
    // boundary test); this needs to stay a drop.
    behaviors.set(company.name, () => Promise.resolve(Array.from({ length: 45 }, (_, i) => rawJob(`r3-${i}`))));
    const third = await runFor(company.name);
    assert.equal(third.refusalStreak, 3);
    assert.equal(third.kind, FAILURE_KIND.BROKEN, 'the 3rd consecutive refusal must be reported as broken, not refused');
    assert.equal(third.loud, true, 'and therefore must turn the run red');
});

// ---------------------------------------------------------------------------
// Two consecutive matching low counts are accepted (sanity gate memory),
// wired end-to-end through runCycle + the companies.js columns.
// ---------------------------------------------------------------------------

test('a drop that reproduces closely on the next cycle is accepted, and the streak resets', async () => {
    const company = seedCompany('Confirmed Drop');
    seedOpenJobs(company.id, 318);

    behaviors.set(company.name, () => Promise.resolve(Array.from({ length: 147 }, (_, i) => rawJob(`d1-${i}`))));
    const first = await runFor(company.name);
    assert.equal(first.kind, FAILURE_KIND.REFUSED);
    assert.equal(first.refusalStreak, 1);

    // Next cycle: closely matches 147 (within 10%) — accepted as real.
    behaviors.set(company.name, () => Promise.resolve(Array.from({ length: 150 }, (_, i) => rawJob(`d2-${i}`))));
    const summary = await runCycle();
    const secondFailure = summary.failures.find((f) => f.company === company.name);
    assert.equal(secondFailure, undefined, 'a confirmed drop must not appear in failures at all — it is trusted');

    // A THIRD cycle refusing again must start counting from 1, not 4 — proof
    // the streak actually reset rather than just being ignored for one cycle.
    behaviors.set(company.name, () => Promise.resolve(Array.from({ length: 5 }, (_, i) => rawJob(`d3-${i}`))));
    const third = await runFor(company.name);
    assert.equal(third.refusalStreak, 1, 'the streak must have reset after the confirmed-trusted cycle');
});

// ---------------------------------------------------------------------------
// A trusted cycle still does real work — sanity check that the mocked
// adapter path exercises the normal upsert/close logic, not just failures.
// ---------------------------------------------------------------------------

test('a normal trusted cycle still creates new jobs through the mocked adapter', async () => {
    const company = seedCompany('Healthy');
    behaviors.set(company.name, () => Promise.resolve([rawJob('h1'), rawJob('h2')]));

    const summary = await runCycle();
    assert.ok(summary.newJobs >= 2);
    assert.equal(summary.failures.find((f) => f.company === company.name), undefined);
});
