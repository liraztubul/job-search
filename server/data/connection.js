/**
 * The SQLite connection, and the migrations that keep an existing file usable.
 *
 * Every other file in server/data/ imports `db` from here so there is exactly
 * one connection and one place where the schema is applied.
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Tests that need real rows (pagination, ordering) set JT_DB_PATH=':memory:'
// before requiring anything in server/data/ — the app itself never sets this,
// so `node server/main.js` and the web server always use the real file.
const dbPath = process.env.JT_DB_PATH || path.join(__dirname, '..', '..', 'jobtracker.db');
const db = new Database(dbPath);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * new columns never reach a database created before they were added. This adds
 * only what's missing, which makes running it repeatedly harmless.
 *
 * A real migration framework would be overkill for one developer and one file;
 * this is the smallest thing that stops `node server/main.js` from crashing on a
 * database you seeded last week.
 */
function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

for (const [column, definition] of [
    ['employment_type', 'TEXT'],
    ['experience_level', 'TEXT'],
    ['department', 'TEXT'],
    ['posted_at', 'TEXT'],
    ['location_search', 'TEXT'],
    ['job_code', 'TEXT'],
]) {
    ensureColumn('job_snapshots', column, definition);
}

/**
 * Going multi-account on a database that already has one person's data in it.
 *
 * SQLite cannot ADD COLUMN ... NOT NULL without a default, so the column goes on
 * nullable and every existing row is adopted by the first account. On a fresh
 * database there is nothing to adopt and this does nothing.
 *
 * There used to be a gap here: with no account to adopt orphans into, this
 * just left them — silently invisible forever, since `web/middleware/auth.js`
 * has every request run as account *id* 1 while auth is off, without that
 * row necessarily existing, and registration itself is blocked while auth is
 * off (there is no signup flow to create it through). A database with
 * pre-existing data and zero registered users could never self-heal. Now it
 * creates that local account itself, so "every request runs as account 1"
 * is true of a real row, not just a number nothing backs.
 */
function backfillOwnership() {
    ensureColumn('applications', 'user_id', 'INTEGER REFERENCES users(id)');
    ensureColumn('search_profiles', 'user_id', 'INTEGER REFERENCES users(id)');

    const orphans =
        db.prepare('SELECT COUNT(*) AS n FROM applications WHERE user_id IS NULL').get().n +
        db.prepare('SELECT COUNT(*) AS n FROM search_profiles WHERE user_id IS NULL').get().n;
    if (orphans === 0) return;

    let owner = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
    if (!owner) {
        // A random, never-revealed value in the password_hash column, not the
        // "salt:hash" shape verifyPassword expects — this account can never
        // log in by password, on purpose. If auth is switched on later,
        // `tools/set-password.js` gives it (or a newly registered account)
        // a real one.
        const info = db
            .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
            .run('local@localhost', crypto.randomBytes(32).toString('hex'), new Date().toISOString());
        owner = { id: info.lastInsertRowid };
        console.log(`No account existed to own ${orphans} pre-existing row(s) — created local account ${owner.id}.`);
    }

    db.prepare('UPDATE applications SET user_id = ? WHERE user_id IS NULL').run(owner.id);
    db.prepare('UPDATE search_profiles SET user_id = ? WHERE user_id IS NULL').run(owner.id);
    console.log(`Adopted ${orphans} pre-existing row(s) into account ${owner.id}.`);
}

backfillOwnership();

module.exports = { db, ensureColumn, backfillOwnership };
