// Isolated in-memory DB — see tests/jobs.test.js for why this has to be set
// before anything in server/data/ is required.
process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { addCompany } = require('../server/data/companies');
const { upsertJobSnapshot, findJobById } = require('../server/data/jobs');
const { handleApi } = require('../server/web/routes');

function fakeReq(method, body, { remoteAddress = '203.0.113.200' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    req.method = method;
    req.headers = { host: '127.0.0.1:3000' };
    req.socket = { remoteAddress };
    return req;
}

function fakeRes() {
    const headers = {};
    let statusCode;
    let rawBody;
    return {
        setHeader: (k, v) => { headers[k] = v; },
        writeHead: (status, hdrs) => { statusCode = status; Object.assign(headers, hdrs || {}); },
        end: (b) => { rawBody = b; },
        get statusCode() { return statusCode; },
        get headers() { return headers; },
        get body() { return rawBody ? JSON.parse(rawBody) : undefined; },
    };
}

async function call(method, path, opts) {
    const res = fakeRes();
    await handleApi(fakeReq(method, null, opts), res, new URL(`http://127.0.0.1:3000${path}`));
    return res;
}

function seedJob() {
    const companyId = addCompany({ name: `Route Verify Co ${Math.random()}`, careerUrl: '', adapterType: 'greenhouse', config: {} });
    const { id } = upsertJobSnapshot(companyId, {
        externalId: `job-${Math.random()}`, title: 'Job', location: 'Tel Aviv', applyUrl: 'https://example.com/job',
    });
    return id;
}

function withFetch(t, impl) {
    const original = global.fetch;
    global.fetch = impl;
    t.after(() => { global.fetch = original; });
}

test('POST /api/jobs/:id/verify is reachable while logged out — it touches no personal data', async (t) => {
    withFetch(t, async () => ({ status: 200, text: async () => 'a live job page' }));
    const jobId = seedJob();

    const res = await call('POST', `/api/jobs/${jobId}/verify`, { remoteAddress: '203.0.113.201' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'open');
});

test('a nonexistent job id gives a 404, not a 500', async (t) => {
    const res = await call('POST', '/api/jobs/999999999/verify', { remoteAddress: '203.0.113.202' });
    assert.equal(res.statusCode, 404);
});

test('a non-numeric id does not match the route at all', async () => {
    const res = await call('POST', '/api/jobs/not-a-number/verify', { remoteAddress: '203.0.113.203' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'no such endpoint');
});

test('GET on the same path is not the verify route — only POST is wired up', async () => {
    const jobId = seedJob();
    const res = await call('GET', `/api/jobs/${jobId}/verify`, { remoteAddress: '203.0.113.204' });
    assert.equal(res.statusCode, 404);
});

test('a confirmed-gone job closes it, and searching for it afterward excludes it', async (t) => {
    withFetch(t, async () => ({ status: 404, text: async () => '' }));
    const jobId = seedJob();

    const res = await call('POST', `/api/jobs/${jobId}/verify`, { remoteAddress: '203.0.113.205' });
    assert.equal(res.body.status, 'gone');
    assert.equal(findJobById(jobId).isStillOpen, 0);
});

test('a Rafael-style (manual-adapter) job survives the real HTTP route end to end — the exemption is not just a unit-test claim', async (t) => {
    let fetchCalled = false;
    withFetch(t, async () => { fetchCalled = true; throw new Error('must not be called'); });

    const companyId = addCompany({ name: 'Rafael', careerUrl: '', adapterType: 'manual', config: { file: 'rafael' } });
    const { id: jobId } = upsertJobSnapshot(companyId, {
        externalId: 'rafael-job-1', title: 'מהנדס.ת תוכנה', location: 'Haifa', applyUrl: 'https://career.rafael.co.il/',
    });

    const res = await call('POST', `/api/jobs/${jobId}/verify`, { remoteAddress: '203.0.113.220' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'unknown');
    assert.equal(fetchCalled, false, 'the real API route must never fetch a manual-adapter company\'s URL');
    assert.equal(findJobById(jobId).isStillOpen, 1, 'the job must remain open after being clicked through the real route');
});

test('the endpoint is rate limited per IP (20/5min)', async (t) => {
    withFetch(t, async () => ({ status: 200, text: async () => 'fine' }));
    const jobId = seedJob();
    const ip = '203.0.113.210';

    for (let i = 0; i < 20; i++) {
        const res = await call('POST', `/api/jobs/${jobId}/verify`, { remoteAddress: ip });
        assert.equal(res.statusCode, 200, `attempt ${i + 1} should be allowed`);
    }

    const overflow = await call('POST', `/api/jobs/${jobId}/verify`, { remoteAddress: ip });
    assert.equal(overflow.statusCode, 429);
    assert.ok(Number(overflow.headers['Retry-After']) > 0);

    // A different IP is unaffected — this is a per-IP counter, not global.
    const otherIp = await call('POST', `/api/jobs/${jobId}/verify`, { remoteAddress: '203.0.113.211' });
    assert.equal(otherIp.statusCode, 200);
});
