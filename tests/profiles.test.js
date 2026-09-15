// Isolated in-memory DB — must be set before anything in server/data/ is
// required. See tests/jobs.test.js for why this is safe across test files.
process.env.JT_DB_PATH = ':memory:';
process.env.JT_SESSION_SECRET = 'test-secret-not-for-production';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { createUser } = require('../server/data/users');
const profilesData = require('../server/data/profiles');
const profileService = require('../server/services/profileService');
const { handleApi } = require('../server/web/routes');
const auth = require('../server/web/middleware/auth');

/**
 * Phase 1 of docs/ROADMAP.md's "Managing everything from the browser":
 * search_profiles CRUD, reachable from the browser, scoped so one account can
 * never see or touch another's profiles — the exact leak class ADR-007 exists
 * to prevent (see tests/tenancy.test.js).
 */

let userA, userB;

test.before(() => {
    userA = createUser({ email: 'profiles-a@example.com', passwordHash: 'x' });
    userB = createUser({ email: 'profiles-b@example.com', passwordHash: 'x' });
});

// ---------------------------------------------------------------------------
// data/profiles.js — the unit level
// ---------------------------------------------------------------------------

test('addSearchProfile + listProfiles round-trips for the owning account', () => {
    const id = profilesData.addSearchProfile({
        userId: userA,
        name: 'Backend roles',
        keywords: 'backend,node',
        locationFilter: 'Haifa',
        experienceFilter: 'entry',
    });

    const list = profilesData.listProfiles(userA);
    assert.ok(list.some((p) => p.id === id && p.name === 'Backend roles'));
});

test('listProfiles(userB) never includes userA\'s profiles', () => {
    const listB = profilesData.listProfiles(userB);
    assert.equal(listB.length, 0);
});

test('getProfile refuses to return another account\'s profile', () => {
    const id = profilesData.addSearchProfile({ userId: userA, name: 'A-only', keywords: 'x' });
    assert.ok(profilesData.getProfile(userA, id));
    assert.equal(profilesData.getProfile(userB, id), null);
});

test('updateProfile refuses to modify another account\'s profile', () => {
    const id = profilesData.addSearchProfile({ userId: userA, name: 'Original', keywords: 'x' });
    const result = profilesData.updateProfile(userB, id, { name: 'Hijacked' });
    assert.equal(result, null);
    assert.equal(profilesData.getProfile(userA, id).name, 'Original');
});

test('updateProfile leaves omitted fields untouched', () => {
    const id = profilesData.addSearchProfile({
        userId: userA,
        name: 'Partial update',
        keywords: 'backend',
        locationFilter: 'Haifa',
    });
    const updated = profilesData.updateProfile(userA, id, { name: 'Renamed' });
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.keywords, 'backend');
    assert.equal(updated.location_filter, 'Haifa');
});

test('deleteProfile refuses to delete another account\'s profile, and reports honestly', () => {
    const id = profilesData.addSearchProfile({ userId: userA, name: 'Keep me', keywords: 'x' });
    assert.equal(profilesData.deleteProfile(userB, id), false);
    assert.ok(profilesData.getProfile(userA, id), 'must still exist — the delete from B must not have run');

    assert.equal(profilesData.deleteProfile(userA, id), true);
    assert.equal(profilesData.getProfile(userA, id), null);
});

// ---------------------------------------------------------------------------
// services/profileService.js — validation against the closed vocabularies
// ---------------------------------------------------------------------------

test('createProfile rejects a missing name', () => {
    const result = profileService.createProfile(userA, { keywords: 'backend' });
    assert.equal(result.ok, false);
});

test('createProfile rejects empty keywords', () => {
    const result = profileService.createProfile(userA, { name: 'x', keywords: '' });
    assert.equal(result.ok, false);
});

test('createProfile rejects a location outside the canonical list', () => {
    const result = profileService.createProfile(userA, { name: 'x', keywords: 'backend', locations: ['Atlantis'] });
    assert.equal(result.ok, false);
});

test('createProfile rejects an experience level outside the vocabulary', () => {
    const result = profileService.createProfile(userA, { name: 'x', keywords: 'backend', experienceLevel: 'wizard' });
    assert.equal(result.ok, false);
});

test('createProfile rejects an employment type outside the vocabulary', () => {
    const result = profileService.createProfile(userA, { name: 'x', keywords: 'backend', employmentType: 'gig' });
    assert.equal(result.ok, false);
});

test('createProfile accepts valid values and they read back exactly', () => {
    const result = profileService.createProfile(userA, {
        name: 'Valid profile',
        keywords: 'backend, node ,python',
        locations: ['Haifa', 'Tel Aviv'],
        experienceLevel: 'entry',
        employmentType: 'full-time',
    });
    assert.equal(result.ok, true);
    assert.equal(result.profile.keywords, 'backend,node,python');
    assert.equal(result.profile.location_filter, 'Haifa,Tel Aviv');
    assert.equal(result.profile.experience_filter, 'entry');
    assert.equal(result.profile.employment_filter, 'full-time');
});

test('updateProfile via the service refuses another account\'s profile id', () => {
    const created = profileService.createProfile(userA, { name: 'x', keywords: 'backend' });
    const result = profileService.updateProfile(userB, created.profile.id, { name: 'Hijacked' });
    assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// The full HTTP pipeline — session cookie -> userId -> scoping. This is the
// "second account proves isolation" check the work order asks for.
// ---------------------------------------------------------------------------

function fakeReq(method, body, cookie) {
    const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
    req.method = method;
    req.headers = { host: '127.0.0.1:3000' };
    if (cookie) req.headers.cookie = `${auth.COOKIE_NAME}=${cookie}`;
    req.socket = { remoteAddress: '203.0.113.90' };
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

function sessionCookieFor(userId) {
    const res = fakeRes();
    auth.startSession(res, userId);
    return res.headers['Set-Cookie'].split(';')[0].split('=')[1];
}

async function call(method, path, body, cookie) {
    const res = fakeRes();
    await handleApi(fakeReq(method, body, cookie), res, new URL(`http://127.0.0.1:3000${path}`));
    return res;
}

test('GET /api/profiles requires a session', async () => {
    const res = await call('GET', '/api/profiles');
    assert.equal(res.statusCode, 401);
});

test('POST /api/profiles creates a profile owned by the caller', async () => {
    const cookieA = sessionCookieFor(userA);
    const res = await call('POST', '/api/profiles', { name: 'HTTP profile', keywords: 'backend' }, cookieA);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.profile.user_id, userA);
});

test('GET /api/profiles as B never lists A\'s profiles, and vice versa', async () => {
    const cookieA = sessionCookieFor(userA);
    const cookieB = sessionCookieFor(userB);

    await call('POST', '/api/profiles', { name: 'A only', keywords: 'a' }, cookieA);
    await call('POST', '/api/profiles', { name: 'B only', keywords: 'b' }, cookieB);

    const listA = await call('GET', '/api/profiles', null, cookieA);
    const listB = await call('GET', '/api/profiles', null, cookieB);

    assert.ok(listA.body.profiles.every((p) => p.name !== 'B only'));
    assert.ok(listB.body.profiles.every((p) => p.name !== 'A only'));
});

test('PUT /api/profiles/:id as B against A\'s profile fails, and A\'s data is untouched', async () => {
    const cookieA = sessionCookieFor(userA);
    const cookieB = sessionCookieFor(userB);

    const created = await call('POST', '/api/profiles', { name: 'Original name', keywords: 'x' }, cookieA);
    const id = created.body.profile.id;

    const hijack = await call('PUT', `/api/profiles/${id}`, { name: 'Hijacked' }, cookieB);
    assert.equal(hijack.statusCode, 400);

    const stillA = await call('GET', '/api/profiles', null, cookieA);
    assert.ok(stillA.body.profiles.some((p) => p.id === id && p.name === 'Original name'));
});

test('DELETE /api/profiles/:id as B against A\'s profile fails, and A\'s profile survives', async () => {
    const cookieA = sessionCookieFor(userA);
    const cookieB = sessionCookieFor(userB);

    const created = await call('POST', '/api/profiles', { name: 'Survives', keywords: 'x' }, cookieA);
    const id = created.body.profile.id;

    const hijack = await call('DELETE', `/api/profiles/${id}`, null, cookieB);
    assert.equal(hijack.statusCode, 400);

    const stillA = await call('GET', '/api/profiles', null, cookieA);
    assert.ok(stillA.body.profiles.some((p) => p.id === id));
});

test('DELETE /api/profiles/:id as the owner actually removes it', async () => {
    const cookieA = sessionCookieFor(userA);
    const created = await call('POST', '/api/profiles', { name: 'Delete me', keywords: 'x' }, cookieA);
    const id = created.body.profile.id;

    const del = await call('DELETE', `/api/profiles/${id}`, null, cookieA);
    assert.equal(del.statusCode, 200);

    const list = await call('GET', '/api/profiles', null, cookieA);
    assert.ok(list.body.profiles.every((p) => p.id !== id));
});
