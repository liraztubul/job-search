/**
 * Registration and sign-in rules.
 *
 * The web layer turns a request into arguments; the data layer runs the
 * statement; deciding what a valid account looks like is neither, and it is the
 * part that has to stay correct when a second way in appears (a CLI, a test).
 *
 * Password reset and registration email confirmation live in
 * services/verificationService.js, not here — they're a different question
 * ("prove you hold this token") from "is this email/password combination
 * valid," even though both end up changing a row in `users`. See
 * docs/ARCHITECTURE.md ADR-007.
 */

const data = require('../data');
const { hashPassword, verifyPassword, needsRehash } = require('../web/middleware/auth');

// Deliberately loose: an address either reaches its owner or it doesn't, and no
// regex settles that. Verification is what proves an address, and that's the
// piece still missing — this only rejects obvious typos.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIN_PASSWORD_LENGTH = 10;

/**
 * @returns {Promise<{ok: true, userId: number} | {ok: false, error: string}>}
 */
async function register({ email, password } = {}) {
    const address = data.normalizeEmail(email);

    if (!EMAIL_RE.test(address)) return { ok: false, error: 'that does not look like an email address' };
    if (String(password || '').length < MIN_PASSWORD_LENGTH) {
        return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }

    try {
        const passwordHash = await hashPassword(password);
        const userId = data.createUser({ email: address, passwordHash });
        return { ok: true, userId, email: address };
    } catch (err) {
        // The UNIQUE index is the check, not a prior SELECT — a pre-check races
        // with a second signup submitted at the same moment.
        if (/UNIQUE/i.test(err.message)) return { ok: false, error: 'that email is already registered' };
        throw err;
    }
}

/**
 * @returns {Promise<{ok: true, userId: number} | {ok: false, error: string}>}
 */
async function authenticate({ email, password } = {}) {
    const user = data.findUserByEmail(email);

    // One message for both "no such account" and "wrong password". Telling them
    // apart hands an attacker a way to discover which addresses are registered.
    const rejection = { ok: false, error: 'wrong email or password' };

    if (!user) {
        // Hash anyway, so a missing account doesn't answer measurably faster
        // than a wrong password does.
        await hashPassword(String(password || ''));
        return rejection;
    }

    const valid = await verifyPassword(String(password || ''), user.password_hash);
    if (!valid) return rejection;

    // The one moment the plaintext is available — silently move a legacy or
    // under-cost hash up to the current parameters instead of waiting for a
    // password reset flow that doesn't exist yet.
    if (needsRehash(user.password_hash)) {
        data.updateUserPasswordHash(user.id, await hashPassword(password));
    }

    return { ok: true, userId: user.id };
}

/**
 * @param {number|null} userId
 * @returns {{emailVerified: boolean}|null} null when nobody is signed in
 */
function currentUserInfo(userId) {
    if (!userId) return null;
    const user = data.findUserById(userId);
    return user ? { emailVerified: Boolean(user.email_verified_at) } : null;
}

module.exports = { register, authenticate, currentUserInfo, MIN_PASSWORD_LENGTH };
