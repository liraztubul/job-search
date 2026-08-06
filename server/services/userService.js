/**
 * Registration and sign-in rules.
 *
 * The web layer turns a request into arguments; the data layer runs the
 * statement; deciding what a valid account looks like is neither, and it is the
 * part that has to stay correct when a second way in appears (a CLI, a test).
 *
 * NOT HERE YET, and required before real strangers use this:
 * email verification, password reset, and rate limiting on sign-in. See
 * ARCHITECTURE.md ADR-007.
 */

const data = require('../data');
const { hashPassword, verifyPassword } = require('../web/middleware/auth');

// Deliberately loose: an address either reaches its owner or it doesn't, and no
// regex settles that. Verification is what proves an address, and that's the
// piece still missing — this only rejects obvious typos.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIN_PASSWORD_LENGTH = 10;

/**
 * @returns {{ok: true, userId: number} | {ok: false, error: string}}
 */
function register({ email, password } = {}) {
    const address = data.normalizeEmail(email);

    if (!EMAIL_RE.test(address)) return { ok: false, error: 'that does not look like an email address' };
    if (String(password || '').length < MIN_PASSWORD_LENGTH) {
        return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }

    try {
        return { ok: true, userId: data.createUser({ email: address, passwordHash: hashPassword(password) }) };
    } catch (err) {
        // The UNIQUE index is the check, not a prior SELECT — a pre-check races
        // with a second signup submitted at the same moment.
        if (/UNIQUE/i.test(err.message)) return { ok: false, error: 'that email is already registered' };
        throw err;
    }
}

/**
 * @returns {{ok: true, userId: number} | {ok: false, error: string}}
 */
function authenticate({ email, password } = {}) {
    const user = data.findUserByEmail(email);

    // One message for both "no such account" and "wrong password". Telling them
    // apart hands an attacker a way to discover which addresses are registered.
    const rejection = { ok: false, error: 'wrong email or password' };

    if (!user) {
        // Hash anyway, so a missing account doesn't answer measurably faster
        // than a wrong password does.
        hashPassword(String(password || ''));
        return rejection;
    }

    return verifyPassword(String(password || ''), user.password_hash)
        ? { ok: true, userId: user.id }
        : rejection;
}

module.exports = { register, authenticate, MIN_PASSWORD_LENGTH };
