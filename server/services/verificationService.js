/**
 * Password reset and registration email-confirmation — the "prove you hold
 * this token" rules shared by both. Same shape, different intent:
 *
 *   - a reset token, once confirmed, changes a password
 *   - a confirmation token, once confirmed, sets email_verified_at
 *
 * TOKEN HANDLING
 *
 * A reset token is a temporary password: whoever holds it can get into the
 * account. `crypto.randomBytes(32)` (256 bits — not guessable), and only its
 * SHA-256 hash is ever written to the database, the same reasoning as never
 * storing a plaintext password — a database leak must not also hand over
 * every outstanding reset link.
 *
 * Verifying a submitted token never does `WHERE token_hash = ?` in SQL —
 * `findMatch` below pulls the small set of still-active tokens and compares
 * each one with `crypto.timingSafeEqual`, so the comparison itself can't leak
 * timing information the way a database index lookup might.
 */

const crypto = require('crypto');
const data = require('../data');
const { hashPassword } = require('../web/middleware/auth');
const { MIN_PASSWORD_LENGTH } = require('./userService');
const email = require('./emailService');

const TOKEN_BYTES = 32;
const RESET_WINDOW_MS = 60 * 60 * 1000; // one hour
const CONFIRM_WINDOW_MS = 24 * 60 * 60 * 1000; // a day — inboxes aren't always open right away
// How far back to look for a token to compare against — generous next to the
// one-hour expiry so a stale link still gets an honest "expired" message
// rather than a vague "invalid" one, while keeping the scan bounded.
const MATCH_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Finds the row (if any) whose hash matches `token`, checking every
 * candidate in constant time rather than stopping at the first mismatch. */
function findMatch(rows, token) {
    const candidate = Buffer.from(hashToken(String(token || '')), 'hex');
    let match = null;
    for (const row of rows) {
        const stored = Buffer.from(row.token_hash, 'hex');
        // Every hash here is a fixed-length SHA-256 hex string, so a length
        // mismatch never happens in practice — checked anyway because
        // timingSafeEqual throws on unequal lengths instead of returning false.
        if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) match = row;
    }
    return match;
}

/**
 * Always resolves the same way, and in roughly the same time, whether or not
 * `rawEmail` belongs to a real account — the login handler already takes
 * this care (see userService.authenticate), and a form that answers
 * differently for a real vs. fake address turns "forgot password" into a way
 * to discover who is registered.
 *
 * The actual send is fire-and-forget on purpose: awaiting a mail provider's
 * API here would make the response time for a real account measurably
 * longer than for a fake one (the provider round-trip vs. nothing), which is
 * exactly the timing side-channel the rest of this function is trying to
 * close. The database write that happens either way (or doesn't) is the one
 * remaining, much smaller timing signal — closing that fully would mean
 * inserting a throwaway row for addresses that don't exist, which needs a
 * real user id to satisfy the foreign key and isn't worth the complexity at
 * this app's scale.
 *
 * @param {string} rawEmail
 * @param {(token: string) => string} buildResetUrl
 */
async function requestPasswordReset(rawEmail, buildResetUrl) {
    const user = data.findUserByEmail(rawEmail);
    if (!user) return;

    const token = newToken();
    data.createPasswordReset({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_WINDOW_MS).toISOString(),
    });

    email.sendPasswordReset(user.email, buildResetUrl(token)).catch((err) => {
        console.error('password reset email failed to send:', err);
    });
}

/**
 * @param {string} token
 * @param {string} password
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function confirmPasswordReset(token, password) {
    if (String(password || '').length < MIN_PASSWORD_LENGTH) {
        return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }

    const since = new Date(Date.now() - MATCH_LOOKBACK_MS).toISOString();
    const match = findMatch(data.listRecentPasswordResets(since), token);
    if (!match) return { ok: false, error: 'that reset link is invalid or has expired' };
    // Consumed and expired are checked on the matched row itself (not
    // filtered out of the query, see listRecentPasswordResets) so a stale or
    // reused link gets its own honest message instead of both collapsing
    // into "invalid".
    if (match.consumed_at) return { ok: false, error: 'that reset link has already been used' };
    if (new Date(match.expires_at).getTime() <= Date.now()) {
        return { ok: false, error: 'that reset link is invalid or has expired' };
    }

    const newPasswordHash = await hashPassword(password);
    try {
        data.confirmPasswordReset({ resetId: match.id, userId: match.user_id, newPasswordHash });
    } catch {
        // Lost a race with another confirm of the same link, right between
        // the check above and this write — see the transaction in
        // data/passwordResets.js.
        return { ok: false, error: 'that reset link has already been used' };
    }

    return { ok: true };
}

/**
 * Fired after a successful registration. Deliberately not awaited by the
 * caller (see routes/index.js) — see "Confirming an address" in
 * docs/ROADMAP.md for why a failed or slow send must never block using the
 * account it's confirming.
 *
 * @param {number} userId
 * @param {string} userEmail
 * @param {(token: string) => string} buildConfirmUrl
 */
async function sendEmailConfirmation(userId, userEmail, buildConfirmUrl) {
    const token = newToken();
    data.createEmailConfirmation({
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + CONFIRM_WINDOW_MS).toISOString(),
    });
    await email.sendEmailConfirmation(userEmail, buildConfirmUrl(token));
}

/** @returns {boolean} true when a real, unused, unexpired token was consumed */
function confirmEmail(token) {
    const match = findMatch(data.listActiveEmailConfirmations(new Date().toISOString()), token);
    if (!match) return false;

    try {
        data.confirmEmail({ confirmationId: match.id, userId: match.user_id });
        return true;
    } catch {
        return false; // already confirmed by an earlier click — not an error
    }
}

module.exports = { requestPasswordReset, confirmPasswordReset, sendEmailConfirmation, confirmEmail };
