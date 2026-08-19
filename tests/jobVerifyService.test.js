// Isolated in-memory DB — see tests/jobs.test.js for why this has to be set
// before anything in server/data/ is required.
process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { addCompany } = require('../server/data/companies');
const { upsertJobSnapshot, findJobById } = require('../server/data/jobs');
const { verifyJob } = require('../server/services/jobVerifyService');

function seedJob(externalId = `job-${Math.random()}`) {
    const companyId = addCompany({ name: `Verify Co ${Math.random()}`, careerUrl: '', adapterType: 'greenhouse', config: {} });
    const { id } = upsertJobSnapshot(companyId, {
        externalId, title: 'A Real Job', location: 'Tel Aviv', applyUrl: 'https://example.com/job/' + externalId,
    });
    return { companyId, jobId: id, externalId };
}

/** Installs a fake global.fetch for the duration of one test, restored after. */
function withFetch(t, impl) {
    const original = global.fetch;
    global.fetch = impl;
    t.after(() => { global.fetch = original; });
}

test('verifyJob reports not_found for a job id that does not exist, without fetching anything', async (t) => {
    let fetchCalled = false;
    withFetch(t, async () => { fetchCalled = true; throw new Error('must not be called'); });

    const result = await verifyJob(999999);
    assert.equal(result.status, 'not_found');
    assert.equal(fetchCalled, false);
});

test('an already-closed job reports gone without making a request', async (t) => {
    const { companyId, jobId, externalId } = seedJob();
    // Close it the normal way first.
    const { closeMissingJobs } = require('../server/data/jobs');
    closeMissingJobs(companyId, []);
    assert.equal(findJobById(jobId).isStillOpen, 0);

    let fetchCalled = false;
    withFetch(t, async () => { fetchCalled = true; throw new Error('must not be called'); });

    const result = await verifyJob(jobId);
    assert.equal(result.status, 'gone');
    assert.equal(fetchCalled, false, 'no reason to make a network request for a job already known closed');
});

test('a 200 with no closure phrase is reported open, and the job stays open', async (t) => {
    const { jobId } = seedJob();
    withFetch(t, async (url, opts) => ({ status: 200, text: async () => '<html>a perfectly normal job page</html>' }));

    const result = await verifyJob(jobId);
    assert.equal(result.status, 'open');
    assert.equal(findJobById(jobId).isStillOpen, 1);
});

test('a genuine 404 is reported gone and the job is actually closed in the database', async (t) => {
    const { jobId } = seedJob();
    withFetch(t, async () => ({ status: 404, text: async () => '' }));

    const result = await verifyJob(jobId);
    assert.equal(result.status, 'gone');

    const row = findJobById(jobId);
    assert.equal(row.isStillOpen, 0);
});

test('closing one verified-gone job never closes another open job at the same company', async (t) => {
    const companyId = addCompany({ name: `Multi Job Co ${Math.random()}`, careerUrl: '', adapterType: 'greenhouse', config: {} });
    const gone = upsertJobSnapshot(companyId, { externalId: 'gone-1', title: 'Gone Job', location: 'Tel Aviv', applyUrl: 'https://example.com/gone' });
    const staysOpen = upsertJobSnapshot(companyId, { externalId: 'stays-1', title: 'Stays Open Job', location: 'Tel Aviv', applyUrl: 'https://example.com/stays' });

    withFetch(t, async (url) => (String(url).includes('/gone') ? { status: 404, text: async () => '' } : { status: 200, text: async () => 'fine' }));

    const result = await verifyJob(gone.id);
    assert.equal(result.status, 'gone');
    assert.equal(findJobById(gone.id).isStillOpen, 0, 'the verified job must close');
    assert.equal(findJobById(staysOpen.id).isStillOpen, 1, 'a sibling job at the same company must not be touched');
});

test('a network failure is reported unknown, and never closes the job', async (t) => {
    const { jobId } = seedJob();
    withFetch(t, async () => { throw new Error('ECONNRESET'); });

    const result = await verifyJob(jobId);
    assert.equal(result.status, 'unknown');
    assert.equal(findJobById(jobId).isStillOpen, 1, 'a network failure must never be treated as a closed job');
});

test('a 200 whose body reads a real closure phrase is reported gone', async (t) => {
    const { jobId } = seedJob();
    withFetch(t, async () => ({ status: 200, text: async () => '<p>Sorry, this job may have been taken down.</p>' }));

    const result = await verifyJob(jobId);
    assert.equal(result.status, 'gone');
    assert.equal(findJobById(jobId).isStillOpen, 0);
});

test('HEAD is tried first; a host that rejects it falls back to GET for the real answer', async (t) => {
    const calls = [];
    withFetch(t, async (url, opts) => {
        calls.push(opts.method);
        if (opts.method === 'HEAD') return { status: 405, text: async () => '' };
        return { status: 200, text: async () => 'a normal open job page' };
    });

    const { jobId } = seedJob();
    const result = await verifyJob(jobId);
    assert.deepEqual(calls, ['HEAD', 'GET']);
    assert.equal(result.status, 'open');
});

test('a confident 404 from HEAD alone needs no GET fallback', async (t) => {
    const calls = [];
    withFetch(t, async (url, opts) => {
        calls.push(opts.method);
        return { status: 404, text: async () => '' };
    });

    const { jobId } = seedJob();
    const result = await verifyJob(jobId);
    assert.deepEqual(calls, ['HEAD']);
    assert.equal(result.status, 'gone');
});

// ---------------------------------------------------------------------------
// manual-adapter companies (Rafael) — never fetched, never closed
//
// Rafael is tracked by hand specifically because career.rafael.co.il sits
// behind Reblaze bot protection and refuses automated requests outright — a
// server-side fetch of its URL would ALWAYS come back blocked. If that block
// were ever read as "gone," the first visitor to click a Rafael job would
// close it permanently, and the same would happen to every future company
// added to the manual adapter for the same reason. This is the one place
// this whole feature can destroy data, so it's tested directly rather than
// trusted to jobAvailability.js's general bot-protection detection alone.
// ---------------------------------------------------------------------------

function seedManualJob(companyName = `Manual Co ${Math.random()}`) {
    const companyId = addCompany({ name: companyName, careerUrl: '', adapterType: 'manual', config: { file: 'somefile' } });
    const { id } = upsertJobSnapshot(companyId, {
        externalId: `manual-job-${Math.random()}`, title: 'Manually Tracked Job', location: 'Haifa',
        applyUrl: 'https://career.rafael.co.il/',
    });
    return { companyId, jobId: id };
}

test('a manual-adapter company\'s job is never fetched at all', async (t) => {
    let fetchCalled = false;
    withFetch(t, async () => { fetchCalled = true; throw new Error('must not be called — manual-adapter jobs are exempt'); });

    const { jobId } = seedManualJob('Rafael');
    const result = await verifyJob(jobId);

    assert.equal(fetchCalled, false, 'verifying a manual-adapter job must never make a network request');
    assert.equal(result.status, 'unknown');
});

test('a manual-adapter job is never closed by verification, even repeatedly', async (t) => {
    withFetch(t, async () => { throw new Error('must not be called'); });
    const { jobId } = seedManualJob('Rafael');

    for (let i = 0; i < 5; i++) {
        const result = await verifyJob(jobId);
        assert.equal(result.status, 'unknown');
        assert.equal(findJobById(jobId).isStillOpen, 1, `job must still be open after verify attempt ${i + 1}`);
    }
});

test('even if a manual-adapter job\'s applyUrl would 404 if fetched, it is still never closed — the exemption is unconditional', async (t) => {
    // Proves the guard runs BEFORE any fetch, not as a special case of the
    // response — even a response that would obviously mean "gone" for any
    // other company must never be allowed to reach the manual adapter.
    withFetch(t, async () => ({ status: 404, text: async () => 'this job may have been taken down' }));
    const { jobId } = seedManualJob('Rafael');

    const result = await verifyJob(jobId);
    assert.equal(result.status, 'unknown');
    assert.equal(findJobById(jobId).isStillOpen, 1);
});
