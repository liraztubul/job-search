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
 * JT_SESSION_SECRET exists in the environment, and stays out of the way
 * locally. Accounts themselves live in the `users` table (ADR-007), not in the
 * environment — the secret only signs sessions.
 *
 * WHAT'S HERE
 *
 * Registration, login, rate limiting (server/web/middleware/rateLimit.js),
 * password reset and registration email confirmation
 * (server/services/verificationService.js) are all built. Sending the reset/
 * confirmation mail is a separate, optional switch — see
 * server/services/emailService.js and client/login.html.
 *
 * Uses node:crypto only: scrypt for the password, HMAC for the session cookie.
 * No dependency, nothing to keep patched.
 *
 * SETUP
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   Put the output in .env as JT_SESSION_SECRET, restart, then register an
 *   account through the UI like anyone else would. See docs/DEPLOY.md.
 *
 * Already locked out and need in without email? node tools/reset-password.js
 *
 * DEPLOYMENT
 *   Put this behind HTTPS — a cookie sent over plain HTTP is readable by anyone
 *   on the same network. Terminate TLS at the host (Fly, Railway, Caddy,
 *   Cloudflare Tunnel); do not try to do TLS inside Node.
 */

const crypto = require('crypto');
const { promisify } = require('util');
const data = require('../../data');

const scryptAsync = promisify(crypto.scrypt);

const COOKIE_NAME = 'jt_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // a month; it's your own phone

/**
 * Auth needs a signing secret and nothing else — accounts live in the database,
 * not in the environment. Without a secret we cannot sign a cookie, so login is
 * impossible and the server stays open (which is what you want on localhost).
 */
const isEnabled = () => Boolean(process.env.JT_SESSION_SECRET);

/**
 * PASSWORD HASHING — async, and why the cost is what it is
 *
 * `crypto.scryptSync` runs on the main thread. Node is single-threaded, so
 * while it runs — about 100ms at the old N=2^14 — the whole server is frozen:
 * no job search, no static files, nothing. Ten concurrent login attempts (the
 * exact shape of the credential-stuffing attack Task 1's rate limiter exists
 * for) froze the server for about a second. `crypto.scrypt` (the async form)
 * runs on libuv's threadpool instead, so it costs CPU without blocking the
 * event loop.
 *
 * OWASP suggests N=2^17, but scrypt's memory cost is roughly 128 * N * r
 * bytes — at N=2^17, r=8 that's ~134MB *per concurrent hash*, on a 512MB Fly
 * machine. N=2^16 keeps that to ~64MB (still over Node's 32MB default
 * `maxmem`, so it must be set explicitly) while roughly doubling the cost an
 * attacker pays over the old default.
 *
 * MEASURED (`node tools/bench-auth.js`, 2026-08-13, developer machine —
 * Windows, 13th Gen Intel Core i7-1355U, 12 logical CPUs, 16GB RAM — NOT the
 * 512MB/shared-cpu-1x Fly VM this actually deploys to; re-run there before
 * trusting these numbers in production):
 *
 *   single hash:  ~30ms  at the old N=2^14  vs  ~110ms  at the new N=2^16
 *   10 concurrent logins, max event-loop delay: ~290ms (old, sync, blocking)
 *                                            vs   ~19ms  (new, async, threadpool)
 *
 * ~110ms is comfortably under the ~250ms budget even on a machine slower than
 * this one, and Task 1's login rate limit caps how many of these can run
 * concurrently before Node's threadpool (default size 4) queues the rest
 * anyway. The ~15x drop in max event-loop delay is the actual point: the old
 * code made the whole server unresponsive for the better part of a second
 * under ten concurrent attempts; the new code barely moves it.
 */
const CURRENT_PARAMS = Object.freeze({ N: 2 ** 16, r: 8, p: 1 });

/** Hashes made by the original `scryptSync(password, salt, 64)` call, which
 * used Node's implicit defaults: N=2^14, r=8, p=1. */
const LEGACY_PARAMS = Object.freeze({ N: 2 ** 14, r: 8, p: 1 });

const KEY_LENGTH = 64;

// scrypt refuses to run once N * r * 128 exceeds `maxmem` (32MB by default).
// 1.5x headroom over the theoretical minimum so a slightly heavier N doesn't
// throw "memory limit exceeded" instead of failing loudly in a benchmark.
const maxmemFor = ({ N, r }) => Math.ceil(128 * N * r * 1.5);

async function deriveKey(password, salt, { N, r, p }) {
    const buf = await scryptAsync(password, salt, KEY_LENGTH, { N, r, p, maxmem: maxmemFor({ N, r }) });
    return buf.toString('hex');
}

/**
 * @param {string} stored
 * @returns {{params: {N:number,r:number,p:number}, salt: string, hash: string}|null}
 */
function parseStoredHash(stored) {
    const value = String(stored);

    if (!value.includes('$')) {
        // Legacy "salt:hash" shape — no parameters recorded, so assume the
        // only ones this codebase ever produced with scryptSync.
        const [salt, hash] = value.split(':');
        return salt && hash ? { params: LEGACY_PARAMS, salt, hash } : null;
    }

    const parts = value.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
    const [, n, r, p, salt, hash] = parts;
    const N = Number(n);
    const R = Number(r);
    const P = Number(p);
    if (![N, R, P].every(Number.isInteger) || !salt || !hash) return null;
    return { params: { N, r: R, p: P }, salt, hash };
}

/** scrypt with a random salt, stored self-describing: "scrypt$N$r$p$salt$hash" —
 * so raising the cost later never locks out a password hashed at the old one. */
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = await deriveKey(password, salt, CURRENT_PARAMS);
    const { N, r, p } = CURRENT_PARAMS;
    return `scrypt$${N}$${r}$${p}$${salt}$${derived}`;
}

/** True when a stored hash was made with weaker-than-current parameters (or
 * the legacy no-parameters shape) and is worth silently upgrading. */
function needsRehash(stored) {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    const { N, r, p } = parsed.params;
    return N !== CURRENT_PARAMS.N || r !== CURRENT_PARAMS.r || p !== CURRENT_PARAMS.p;
}

/** Constant-time compare, so a wrong guess doesn't leak how wrong it was. */
async function verifyPassword(password, stored) {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;

    const actual = await deriveKey(password, parsed.salt, parsed.params);
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(parsed.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A cookie the server can verify but a browser cannot forge.
 *
 * The payload carries WHO, not just "logged in" — a session that only says
 * "authenticated" is useless the moment there is more than one account.
 *
 * It also carries the account's `session_epoch` at the moment this cookie
 * was signed. There is no server-side revocation list — sessions are
 * self-contained — so this is what lets one specific event (a password
 * reset) invalidate every cookie signed before it: `verifySession` rejects
 * any cookie whose embedded epoch is behind the account's current one.
 */
function signSession(userId, expiresAtSec, sessionEpoch) {
    const payload = `${userId}.${expiresAtSec}.${sessionEpoch}`;
    const mac = crypto.createHmac('sha256', process.env.JT_SESSION_SECRET).update(payload).digest('hex');
    return `${payload}.${mac}`;
}

/**
 * @returns {number|null} the user id this cookie proves, or null.
 *
 * The epoch check is a database read on every authenticated request — the
 * one real cost of this design, since sessions were previously verifiable
 * from the cookie alone with no query at all. Accepted here because a
 * password reset that leaves old sessions alive is a worse failure than one
 * extra indexed lookup per request. If this ever shows up in latency
 * numbers, the fix is a short-lived in-memory cache of epochs (a stale
 * cache just delays revocation by its TTL, it doesn't reopen it) — not
 * dropping the check.
 */
function verifySession(cookieValue) {
    if (!cookieValue || !process.env.JT_SESSION_SECRET) return null;

    const parts = String(cookieValue).split('.');
    if (parts.length !== 4) return null;

    const [userId, expiresAt, epoch, mac] = parts;
    const payload = `${userId}.${expiresAt}.${epoch}`;

    const expected = crypto
        .createHmac('sha256', process.env.JT_SESSION_SECRET)
        .update(payload)
        .digest('hex');

    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    if (Number(expiresAt) <= Math.floor(Date.now() / 1000)) return null;

    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return null;

    const currentEpoch = data.getSessionEpoch(id);
    if (currentEpoch === null) return null; // account no longer exists
    if (!Number.isInteger(Number(epoch)) || Number(epoch) < currentEpoch) return null;

    return id;
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
    const epoch = data.getSessionEpoch(userId) || 0;
    res.setHeader('Set-Cookie', sessionCookie(signSession(userId, expiresAt, epoch), SESSION_MAX_AGE_SEC));
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
    needsRehash,
    signSession,
    verifySession,
    startSession,
    logout,
};
