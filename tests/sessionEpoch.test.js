// Isolated in-memory DB — must be set before anything in server/data/ is
// required. See tests/jobs.test.js for why this is safe across test files.
process.env.JT_DB_PATH = ':memory:';
process.env.JT_SESSION_SECRET = 'test-secret-not-for-production';

const test = require('node:test');
const assert = require('node:assert');
const { createUser } = require('../server/data/users');
const { db } = require('../server/data/connection');
const auth = require('../server/web/middleware/auth');

/**
 * There's no server-side revocation list for these self-contained cookies —
 * session_epoch is the entire mechanism a password reset has for making
 * every other session stop working. If this silently broke, a reset would
 * look successful while leaving every other device still signed in.
 */

function fakeRes() {
    const headers = {};
    return { setHeader: (k, v) => { headers[k] = v; }, headers };
}

function cookieValueFrom(res) {
    // "jt_session=<value>; HttpOnly; ..." — same split login.html's own
    // cookie jar would do, just done by hand here.
    return res.headers['Set-Cookie'].split(';')[0].split('=')[1];
}

test('a session verifies normally before any reset', () => {
    const userId = createUser({ email: 'epoch-a@example.com', passwordHash: 'x' });
    const res = fakeRes();
    auth.startSession(res, userId);

    assert.equal(auth.verifySession(cookieValueFrom(res)), userId);
});

test('bumping session_epoch invalidates a cookie signed before the bump', () => {
    const userId = createUser({ email: 'epoch-b@example.com', passwordHash: 'x' });
    const res = fakeRes();
    auth.startSession(res, userId);
    const cookie = cookieValueFrom(res);

    assert.equal(auth.verifySession(cookie), userId, 'sanity check: valid before the bump');

    // Exactly what data/passwordResets.js's confirmPasswordReset does as part
    // of its transaction.
    db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').run(userId);

    assert.equal(auth.verifySession(cookie), null, 'must stop verifying once the epoch moves');
});

test('a session started AFTER the bump verifies fine — only the old cookie is dead', () => {
    const userId = createUser({ email: 'epoch-c@example.com', passwordHash: 'x' });
    db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').run(userId);

    const res = fakeRes();
    auth.startSession(res, userId);
    assert.equal(auth.verifySession(cookieValueFrom(res)), userId);
});

test('a cookie for an account that no longer exists is rejected, not crashed on', () => {
    const userId = createUser({ email: 'epoch-d@example.com', passwordHash: 'x' });
    const res = fakeRes();
    auth.startSession(res, userId);
    const cookie = cookieValueFrom(res);

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    assert.equal(auth.verifySession(cookie), null);
});

test('a tampered epoch segment fails the signature check, not a type coercion', () => {
    const userId = createUser({ email: 'epoch-e@example.com', passwordHash: 'x' });
    const res = fakeRes();
    auth.startSession(res, userId);
    const cookie = cookieValueFrom(res);

    const [uid, expiresAt, epoch] = cookie.split('.');
    const forged = [uid, expiresAt, String(Number(epoch) + 1000), 'forgedmac'].join('.');

    assert.equal(auth.verifySession(forged), null);
});
