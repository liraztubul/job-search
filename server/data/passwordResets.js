/**
 * Password reset tokens. Thin SQL only — deciding what a valid reset looks
 * like lives in services/verificationService.js.
 *
 * NOT SCOPED BY requireUser, ON PURPOSE
 *
 * Every other table with a `user_id` column in this codebase is queried
 * through `data/tenancy.js`'s `requireUser`, because the caller is always
 * "the account currently signed in, reading its own rows." A password reset
 * is the opposite shape: by definition the requester is NOT signed in (that's
 * why they need this), and the row they're allowed to act on is identified by
 * possession of a token, not by a session. Forcing this through
 * `requireUser` would be modeling the wrong boundary; the token itself,
 * compared in constant time in the service layer, is the actual guard.
 */

const { db } = require('./connection');

function createPasswordReset({ userId, tokenHash, expiresAt }) {
    const info = db
        .prepare('INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(userId, tokenHash, expiresAt, new Date().toISOString());
    return info.lastInsertRowid;
}

/**
 * Candidates for a submitted token to be compared against — deliberately not
 * a `WHERE token_hash = ?` lookup, so the actual comparison can happen in
 * constant time (see `verificationService.js`) rather than leaking timing
 * information through SQL's own equality check.
 *
 * Bounded to rows created after `sinceIso` rather than the whole table's
 * history, but deliberately INCLUDES already-consumed and already-expired
 * rows within that window — the caller uses `consumed_at`/`expires_at` on
 * the match to tell "this token never existed" apart from "this exact link
 * was already used", which a query that pre-filters those out could never
 * distinguish. Even a week's worth of these is a small scan.
 */
function listRecentPasswordResets(sinceIso) {
    return db.prepare('SELECT * FROM password_resets WHERE created_at > ?').all(sinceIso);
}

/**
 * Consumes the token and changes the password in one transaction, so two
 * near-simultaneous confirmations of the same link cannot both succeed: the
 * `UPDATE ... WHERE consumed_at IS NULL` only ever affects a row once, and
 * the loser of that race sees zero rows changed and the whole transaction —
 * including the password change — is rolled back.
 *
 * Also bumps `session_epoch`, in the same transaction: resetting a password
 * is exactly the moment someone other than the account owner might currently
 * hold a valid session for it, and that session needs to stop working the
 * instant the new password takes effect, not on its own schedule.
 *
 * @throws when the token was already consumed (by a concurrent request, or a
 *   stale double-click) — the caller treats that as "link already used".
 */
function confirmPasswordReset({ resetId, userId, newPasswordHash }) {
    const run = db.transaction(() => {
        const nowIso = new Date().toISOString();
        const result = db
            .prepare('UPDATE password_resets SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
            .run(nowIso, resetId);
        if (result.changes === 0) throw new Error('reset token already used');

        db.prepare('UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?').run(
            newPasswordHash,
            userId
        );
    });
    run();
}

module.exports = { createPasswordReset, listRecentPasswordResets, confirmPasswordReset };
