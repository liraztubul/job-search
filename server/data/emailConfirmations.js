/**
 * Registration email-confirmation tokens. Same shape and the same reasoning
 * as `data/passwordResets.js` — including staying outside `requireUser`,
 * for the same reason: the requester proves themselves with a token, not a
 * session. Kept as a separate table rather than folded into password_resets
 * with a "purpose" column so a token minted for one use can never be replayed
 * against the other.
 */

const { db } = require('./connection');

function createEmailConfirmation({ userId, tokenHash, expiresAt }) {
    const info = db
        .prepare('INSERT INTO email_confirmations (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(userId, tokenHash, expiresAt, new Date().toISOString());
    return info.lastInsertRowid;
}

/** See the identical comment on `listActivePasswordResets` — same reasoning. */
function listActiveEmailConfirmations(nowIso) {
    return db.prepare('SELECT * FROM email_confirmations WHERE consumed_at IS NULL AND expires_at > ?').all(nowIso);
}

/**
 * @throws when the token was already consumed — the caller treats that as a
 *   no-op rather than an error, since clicking an old confirmation link
 *   twice isn't a security event worth alarming anyone about.
 */
function confirmEmail({ confirmationId, userId }) {
    const run = db.transaction(() => {
        const nowIso = new Date().toISOString();
        const result = db
            .prepare('UPDATE email_confirmations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
            .run(nowIso, confirmationId);
        if (result.changes === 0) throw new Error('confirmation token already used');

        db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL').run(
            nowIso,
            userId
        );
    });
    run();
}

module.exports = { createEmailConfirmation, listActiveEmailConfirmations, confirmEmail };
