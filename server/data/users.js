/**
 * Accounts. Thin SQL only — password hashing lives in web/middleware/auth.js,
 * because it is a security concern, not a storage one.
 *
 * Email is stored lowercased and UNIQUE, so "Liraz@x.com" and "liraz@x.com"
 * cannot become two accounts holding two halves of one person's history.
 */

const { db } = require('./connection');

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

module.exports = { findUserByEmail, findUserById, createUser, countUsers, normalizeEmail };
