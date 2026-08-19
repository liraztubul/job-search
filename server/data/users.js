/**
 * Accounts. Thin SQL only — password hashing lives in web/middleware/auth.js,
 * because it is a security concern, not a storage one.
 *
 * Email is stored lowercased and UNIQUE, so "Liraz@x.com" and "liraz@x.com"
 * cannot become two accounts holding two halves of one person's history.
 */

const { db } = require('./connection');
const { requireUser } = require('./tenancy');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function findUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
}

function findUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * @param {{email: string, passwordHash: string}} user
 * @returns {number} the new user's id
 * @throws when the email is already registered — the UNIQUE constraint, not a
 *   pre-check, because a pre-check races with a second signup.
 */
function createUser({ email, passwordHash }) {
    const info = db
        .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
        .run(normalizeEmail(email), passwordHash, new Date().toISOString());
    return info.lastInsertRowid;
}

function countUsers() {
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/** Used to silently upgrade a legacy or under-cost hash on successful login —
 * see `needsRehash` in web/middleware/auth.js. */
function updateUserPasswordHash(id, passwordHash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

/**
 * @returns {number|null} the account's current session_epoch, or null if the
 *   account no longer exists (a cookie signed for a since-deleted account).
 *
 * Called on every authenticated request (see `auth.js`'s `verifySession`), so
 * this is deliberately a single-column lookup rather than `findUserById` —
 * the smallest query that answers the one question a session check needs.
 */
function getSessionEpoch(id) {
    const row = db.prepare('SELECT session_epoch FROM users WHERE id = ?').get(id);
    return row ? row.session_epoch : null;
}

/**
 * Sets a new password directly and bumps `session_epoch` in the same
 * statement — the escape-hatch counterpart to `data/passwordResets.js`'s
 * `confirmPasswordReset`, used by `tools/reset-password.js` when there is no
 * token flow to go through (the owner already has database access). Any
 * session held by anyone else for this account stops verifying the instant
 * this runs, for the identical reason a mailed reset link does the same.
 */
function setPasswordAndBumpEpoch(userId, passwordHash) {
    db.prepare('UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?').run(
        passwordHash,
        userId
    );
}

/**
 * Removes this account and every row it owns, children first, so a process
 * that dies partway through never leaves a row pointing at a user that no
 * longer exists. No `db.transaction()` — see the identical reasoning in
 * `data/passwordResets.js`; a remote libSQL connection is stateless HTTP.
 *
 * `notifications_sent` has no `user_id` of its own — it's owned indirectly
 * through `search_profiles.profile_id`, so it has to go before
 * `search_profiles` does, via a subquery rather than a join (deletes can't
 * join the table they're deleting from and the table naming its own rows).
 *
 * Shared tables (`job_snapshots`, `watched_companies`) are untouched on
 * purpose — a scrape's own data belongs to everyone, not to whoever happened
 * to be signed in when it ran.
 */
function deleteUserAccount(userId) {
    const owner = requireUser(userId);

    db.prepare('DELETE FROM applications WHERE user_id = ?').run(owner);
    db.prepare(
        'DELETE FROM notifications_sent WHERE profile_id IN (SELECT id FROM search_profiles WHERE user_id = ?)'
    ).run(owner);
    db.prepare('DELETE FROM search_profiles WHERE user_id = ?').run(owner);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(owner);
    db.prepare('DELETE FROM email_confirmations WHERE user_id = ?').run(owner);
    db.prepare('DELETE FROM users WHERE id = ?').run(owner);
}

module.exports = {
    findUserByEmail,
    findUserById,
    createUser,
    countUsers,
    updateUserPasswordHash,
    setPasswordAndBumpEpoch,
    deleteUserAccount,
    getSessionEpoch,
    normalizeEmail,
};
