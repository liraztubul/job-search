/**
 * Sessions and password handling.
 *
 * WHY IT WORKS THIS WAY
 *
 * On your own machine the server listens on 127.0.0.1, so the only thing that
 * can reach it is you. A password there guards a database sitting unencrypted
 * in the same folder — theatre, and permanent complexity.
 *
 * The moment you host it so your phone can reach it, that argument dies: the
 * port is reachable by anyone who finds it. So auth turns itself on when
 * JT_PASSWORD_HASH exists in the environment, and stays out of the way locally.
 *
 * WHAT IT IS NOT
 *
 * Not a full account system yet. Registration and login work; email
 * verification, password reset and login rate limiting do not exist. Do not put
 * this in front of strangers until they do — see ARCHITECTURE.md ADR-007.
 *
 * Uses node:crypto only: scrypt for the password, HMAC for the session cookie.
 * No dependency, nothing to keep patched.
 *
 * SETUP
 *   node tools/set-password.js          prints the two lines for your .env
 *
 * DEPLOYMENT
 *   Put this behind HTTPS — a cookie sent over plain HTTP is readable by anyone
 *   on the same network. Terminate TLS at the host (Fly, Railway, Caddy,
 *   Cloudflare Tunnel); do not try to do TLS inside Node.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'jt_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // a month; it's your own phone

/**
 * Auth needs a signing secret and nothing else — accounts live in the database,
 * not in the environment. Without a secret we cannot sign a cookie, so login is
 * impossible and the server stays open (which is what you want on localhost).
 */
const isEnabled = () => Boolean(process.env.JT_SESSION_SECRET);

/** scrypt with a random salt, stored as "salt:hash". */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${derived}`;
}

/** Constant-time compare, so a wrong guess doesn't leak how wrong it was. */
function verifyPassword(password, stored) {
    const [salt, expected] = String(stored).split(':');
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A cookie the server can verify but a browser cannot forge.
 *
 * The payload carries WHO, not just "logged in" — a session that only says
 * "authenticated" is useless the moment there is more than one account.
 */
function signSession(userId, expiresAtSec) {
    const payload = `${userId}.${expiresAtSec}`;
    const mac = crypto.createHmac('sha256', process.env.JT_SESSION_SECRET).update(payload).digest('hex');
    return `${payload}.${mac}`;
}

/** @returns {number|null} the user id this cookie proves, or null. */
function verifySession(cookieValue) {
    if (!cookieValue || !process.env.JT_SESSION_SECRET) return null;

    const parts = String(cookieValue).split('.');
    if (parts.length !== 3) return null;

    const [userId, expiresAt, mac] = parts;
    const payload = `${userId}.${expiresAt}`;

    const expected = crypto
        .createHmac('sha256', process.env.JT_SESSION_SECRET)
        .update(payload)
        .digest('hex');

    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    if (Number(expiresAt) <= Math.floor(Date.now() / 1000)) return null;

    const id = Number(userId);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return rest.join('=');
    }
    return null;
}

function sessionCookie(value, maxAgeSec) {
    // Secure is set only when we're actually behind HTTPS: a Secure cookie is
    // silently dropped over plain http, which would make local login impossible
    // to debug.
    const secure = process.env.JT_BEHIND_HTTPS === '1' ? '; Secure' : '';
    return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

/**
 * Who is making this request?
 *
 * @returns {number|null} user id, or null when nobody is logged in.
 *
 * With no secret configured (localhost), everything runs as account 1 — the
 * single account the migration adopted your existing data into. That keeps the
 * local experience login-free while every query below still goes through the
 * same user-scoped path as production, instead of a second untested code path.
 */
function currentUserId(req) {
    if (!isEnabled()) return 1;
    return verifySession(readCookie(req, COOKIE_NAME));
}

/** True when this request may proceed. */
function isAuthorized(req) {
    return currentUserId(req) !== null;
}

/** Start a session for an already-authenticated user. */
function startSession(res, userId) {
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
    res.setHeader('Set-Cookie', sessionCookie(signSession(userId, expiresAt), SESSION_MAX_AGE_SEC));
}

function logout(res) {
    res.setHeader('Set-Cookie', sessionCookie('', 0));
}

module.exports = {
    COOKIE_NAME,
    isEnabled,
    isAuthorized,
    currentUserId,
    hashPassword,
    verifyPassword,
    signSession,
    verifySession,
    startSession,
    logout,
};
