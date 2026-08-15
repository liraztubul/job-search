// Isolated in-memory DB — must be set before anything in server/data/ is
// required. See tests/jobs.test.js for why this is safe across test files.
process.env.JT_DB_PATH = ':memory:';
process.env.JT_SESSION_SECRET = 'test-secret-not-for-production';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { db } = require('../server/data/connection');
const { addCompany } = require('../server/data/companies');
const { createUser } = require('../server/data/users');
const { setApplication } = require('../server/data/applications');
const { filterOptions } = require('../server/data/jobs');
const { GUEST } = require('../server/data/tenancy');
const { handleApi } = require('../server/web/routes');
const auth = require('../server/web/middleware/auth');

/**
 * The bug this file exists for: `GET /api/meta`'s `statuses` facet used to run
 * `SELECT status, COUNT(*) FROM applications GROUP BY status` with no
 * `WHERE user_id` at all — every visitor, including a logged-out one, saw
 * aggregate application-status counts from every account combined. See
 * docs/ROADMAP.md and the AMENDMENT A writeup for the full incident.
 */

let userA, userB, jobId;

test.before(() => {
    userA = createUser({ email: 'meta-tenancy-a@example.com', passwordHash: 'x' });
    userB = createUser({ email: 'meta-tenancy-b@example.com', passwordHash: 'x' });

    const companyId = addCompany({ name: 'Meta Tenancy Co', careerUrl: '', adapterType: 'manual', config: {} });
    const now = new Date().toISOString();
    const info = db
        .prepare(
            `INSERT INTO job_snapshots (company_id, external_id, title, location, apply_url, first_seen_at, last_seen_at, is_still_open)
             VALUES (?, 'job-1', 'Test Job', 'Tel Aviv', 'https://example.com', ?, ?, 1)`
        )
        .run(companyId, now, now);
    jobId = info.lastInsertRowid;

    // A applies; B interviews. Two different statuses so a mixed-up result is
    // easy to catch — same status for both would hide a leak behind a
    // coincidence.
    setApplication({ userId: userA, jobSnapshotId: jobId, status: 'applied' });
    setApplication({ userId: userB, jobSnapshotId: jobId, status: 'interviewing' });
});

// ---------------------------------------------------------------------------
// data/jobs.js — the unit level
// ---------------------------------------------------------------------------

test('filterOptions(userA) reflects only userA\'s own statuses', () => {
    const options = filterOptions(userA);
    assert.deepEqual(options.statuses, [{ value: 'applied', count: 1 }]);
});

test('filterOptions(userB) reflects only userB\'s own statuses', () => {
    const options = filterOptions(userB);
    assert.deepEqual(options.statuses, [{ value: 'interviewing', count: 1 }]);
});

test('filterOptions(GUEST) has no statuses key at all — absent, not an empty array', () => {
    const options = filterOptions(GUEST);
    assert.equal('statuses' in options, false);
});

test('filterOptions() still throws without a real caller — undefined is not GUEST', () => {
    assert.throws(() => filterOptions(undefined), /requireUser/);
});

// ---------------------------------------------------------------------------
// GET /api/meta — the full HTTP pipeline: session cookie -> userId -> scoping
// ---------------------------------------------------------------------------

function fakeReq(method, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    req.method = method;
    req.headers = { host: '127.0.0.1:3000' };
    req.socket = { remoteAddress: '203.0.113.90' };
    return req;
}

function fakeReqWithCookie(cookie) {
    const req = fakeReq('GET');
    req.headers.cookie = `${auth.COOKIE_NAME}=${cookie}`;
    return req;
}

function fakeRes() {
    const headers = {};
    let rawBody;
    return {
        setHeader: (k, v) => { headers[k] = v; },
        writeHead: (status, hdrs) => Object.assign(headers, hdrs || {}),
        end: (b) => { rawBody = b; },
        get headers() { return headers; },
        get body() { return rawBody ? JSON.parse(rawBody) : undefined; },
    };
}

function sessionCookieFor(userId) {
    const res = fakeRes();
    auth.startSession(res, userId);
    return res.headers['Set-Cookie'].split(';')[0].split('=')[1];
}

async function getMeta(cookie) {
    const res = fakeRes();
    const req = cookie ? fakeReqWithCookie(cookie) : fakeReq('GET');
    await handleApi(req, res, new URL('http://127.0.0.1:3000/api/meta'));
    return res.body;
}

test('GET /api/meta as user A never reflects user B\'s applications', async () => {
    const metaA = await getMeta(sessionCookieFor(userA));
    assert.deepEqual(metaA.statuses, [{ value: 'applied', count: 1 }]);
});

test('GET /api/meta as user B never reflects user A\'s applications', async () => {
    const metaB = await getMeta(sessionCookieFor(userB));
    assert.deepEqual(metaB.statuses, [{ value: 'interviewing', count: 1 }]);
});

test('GET /api/meta logged out does not include the applications facet', async () => {
    const metaGuest = await getMeta(null);
    // The key must be genuinely absent, not present-but-empty — those read
    // identically to "you have zero tracked applications" for a real account
    // and would be easy to confuse with this guard actually working.
    assert.equal('statuses' in metaGuest, false);
    assert.equal(metaGuest.statuses, undefined);
});

test('GET /api/meta stays public — no session required to get a 200', async () => {
    const res = fakeRes();
    await handleApi(fakeReq('GET'), res, new URL('http://127.0.0.1:3000/api/meta'));
    assert.ok(Array.isArray(res.body.companies), 'the shared facets must still answer for a guest');
});
