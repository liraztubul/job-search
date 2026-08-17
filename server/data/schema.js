/**
 * The complete schema, applicable to any database handle.
 *
 * WHY THIS IS NOT JUST schema.sql
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a column added after the fact never reaches a database created earlier. The
 * project handles that by adding missing columns one at a time — which works,
 * and quietly means **`schema.sql` alone no longer describes the schema**.
 * Eight columns exist only in the migration lists below.
 *
 * That was invisible while there was one database, created once, on one
 * machine. It stopped being invisible the moment a second database had to be
 * created from scratch: `tools/push-to-turso.js` ran `schema.sql` against a new
 * Turso database, and every job insert failed with "no column named
 * location_search". The password reset would have failed the same way on
 * `session_epoch`, later and less obviously.
 *
 * WHY A SEPARATE MODULE
 *
 * `connection.js` opens a database as a side effect of being required — and
 * when TURSO_DATABASE_URL is set, the database it opens is the remote one. A
 * tool that wants only the migration list must not have to open a connection to
 * get it. Nothing here touches a file, a network or a global: it takes a handle
 * and returns nothing.
 *
 * ADDING A COLUMN
 *
 * Add it to `schema.sql` (so new databases get it directly) *and* to the
 * matching list below (so existing ones catch up). Both, always — one without
 * the other is the bug described above.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS = {
    job_snapshots: [
        ['employment_type', 'TEXT'],
        ['experience_level', 'TEXT'],
        ['department', 'TEXT'],
        ['posted_at', 'TEXT'],
        ['location_search', 'TEXT'],
        ['job_code', 'TEXT'],
        // Closure detection: NULL means "believed open". See schema.sql.
        ['closed_at', 'TEXT'],
    ],
    // Password reset (session_epoch) and registration email confirmation
    // (email_verified_at) landed after accounts were already live. SQLite
    // cannot add a NOT NULL column without a default, which is why
    // session_epoch has one and email_verified_at — where no default could
    // honestly stand for "has this address been proven" — stays nullable.
    users: [
        ['session_epoch', 'INTEGER NOT NULL DEFAULT 0'],
        ['email_verified_at', 'TEXT'],
    ],
    // The "new company" trap: see server/domain/jobFreshness.js.
    watched_companies: [['first_scraped_at', 'TEXT']],
};

/** Adds a column only when it is absent, so running it repeatedly is harmless. */
function ensureColumn(handle, table, column, definition) {
    const columns = handle.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) {
        handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

/**
 * Bring a database to the current shape: tables, then every column added since.
 * Safe to run against a brand-new database or one that is already up to date.
 */
function applySchema(handle) {
    handle.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

    for (const [table, columns] of Object.entries(MIGRATIONS)) {
        for (const [column, definition] of columns) {
            ensureColumn(handle, table, column, definition);
        }
    }
}

module.exports = { applySchema, ensureColumn, MIGRATIONS };
