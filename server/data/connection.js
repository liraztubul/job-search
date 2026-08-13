/**
 * The SQLite connection, and the migrations that keep an existing file usable.
 *
 * Every other file in server/data/ imports `db` from here so there is exactly
 * one connection and one place where the schema is applied.
 */

// libsql, not better-sqlite3.
//
// Same synchronous API, same SQL, same file format — it opens a database
// better-sqlite3 wrote — but it can also talk to a hosted libSQL database over
// the network. That is the whole reason for the swap: the free host runs a
// container with no disk that survives a restart, so the file has to live
// somewhere the container is not.
//
// It replaces better-sqlite3 rather than joining it, so the project still has
// exactly one runtime dependency (ADR-002).
const Database = require('libsql');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Tests that need real rows (pagination, ordering) set JT_DB_PATH=':memory:'
// before requiring anything in server/data/ — the app itself never sets this,
// so `node server/main.js` and the web server always use the real file.
const dbPath = process.env.JT_DB_PATH || path.join(__dirname, '..', '..', 'jobtrail.db');

/**
 * The project was called "Job Tracker" before it was called JobTrail, and the
 * database file was named after it.
 *
 * Renaming the constant above without this would not throw, would not warn, and
 * would not lose the old file — it would quietly create an empty one beside it.
 * The app would start perfectly, report zero jobs, and every saved application
 * would appear to have been deleted. Silent success on the wrong file is the
 * worst possible failure here, and it is indistinguishable from a first run.
 *
 * So: adopt the old file once, if and only if there is no new one to conflict
 * with. Skipped entirely when JT_DB_PATH is set — an explicit path is an
 * instruction, not a default to second-guess, and tests use ':memory:'.
 */
function adoptLegacyDatabaseFile() {
    if (process.env.JT_DB_PATH) return;
    if (fs.existsSync(dbPath)) return;

    const legacyPath = path.join(__dirname, '..', '..', 'jobtracker.db');
    if (!fs.existsSync(legacyPath)) return;

    fs.renameSync(legacyPath, dbPath);
    // SQLite's write-ahead log and shared-memory files, if the database was not
    // cleanly closed. Leaving them behind the old name would strand committed
    // transactions that have not yet been folded into the main file.
    for (const suffix of ['-wal', '-shm', '-journal']) {
        if (fs.existsSync(legacyPath + suffix)) fs.renameSync(legacyPath + suffix, dbPath + suffix);
    }
    console.log(`Renamed jobtracker.db -> ${path.basename(dbPath)} (project renamed to JobTrail).`);
}

/**
 * Local file, or a hosted libSQL database when one is configured.
 *
 * The remote form is used only when TURSO_DATABASE_URL is present, so nothing
 * about running this on your own machine changes: no account, no network, same
 * file on the same disk. Production sets the two variables and the same code
 * reaches a database that outlives the container.
 */
function openDatabase() {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) {
        adoptLegacyDatabaseFile();
        return new Database(dbPath);
    }

    // A URL with no token is a misconfiguration that fails later, at the first
    // query, as an opaque auth error. Better to say so at startup.
    if (!process.env.TURSO_AUTH_TOKEN) {
        throw new Error('TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is not — the connection would be rejected.');
    }

    console.log(`Using hosted database at ${url.replace(/\/\/.*@/, '//')}`);
    return new Database(url, { authToken: process.env.TURSO_AUTH_TOKEN });
}

const db = openDatabase();

/**
 * libsql's `.get()` attaches a `_metadata` key (query duration) that
 * better-sqlite3 never returned. `.all()` does not. That inconsistency is
 * invisible until a single row is passed straight to `sendJson` — which
 * `POST /api/application` does — and then a timing field appears in the API
 * response for no reason anyone can trace.
 *
 * Stripping it here, once, keeps the swap genuinely transparent: no repository
 * function, service or route has to know which driver is underneath. Fixing it
 * at each call site instead would mean the next `.get()` anyone writes
 * reintroduces it.
 */
const nativePrepare = db.prepare.bind(db);
db.prepare = (sql) => {
    const statement = nativePrepare(sql);
    const nativeGet = statement.get.bind(statement);
    statement.get = (...args) => {
        const row = nativeGet(...args);
        if (row && typeof row === 'object' && '_metadata' in row) delete row._metadata;
        return row;
    };
    return statement;
};
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

// Password reset (session_epoch) and registration email confirmation
// (email_verified_at) landed after accounts were already live in production —
// a NOT NULL column needs a default to be added to a table with existing
// rows, which is why session_epoch gets one and email_verified_at (no sane
// non-null default for "has this address been proven") stays nullable.
for (const [column, definition] of [
    ['session_epoch', 'INTEGER NOT NULL DEFAULT 0'],
    ['email_verified_at', 'TEXT'],
]) {
    ensureColumn('users', column, definition);
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
