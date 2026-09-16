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
const { applySchema, ensureColumn: ensureColumnOn } = require('./schema');
const { isValidPostedAt } = require('../domain/jobFreshness');

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
/**
 * These values are pasted into dashboard fields by hand — Render's, GitHub's —
 * and both store exactly what was pasted, including a trailing newline picked
 * up by a copy that caught the end of a line, or quotes copied along with the
 * value.
 *
 * The failure that produces is `Hrana(Http("InvalidUri(InvalidUriChar)"))`,
 * which names neither the variable nor the character and sends you looking at
 * the network. Trimming costs nothing and removes the entire failure mode;
 * stripping matching quotes covers the other common paste.
 */
function readSecret(name) {
    const raw = process.env[name];
    if (raw == null) return undefined;
    return raw.trim().replace(/^["']|["']$/g, '');
}

function openDatabase() {
    const url = readSecret('TURSO_DATABASE_URL');

    /**
     * JT_DB_PATH WINS. This order is not cosmetic — it is the fix for a real
     * incident.
     *
     * Turso's credentials are ambient: they get exported into a shell to run
     * one tool and then stay there for the rest of the session. `JT_DB_PATH`
     * is the opposite — a test file sets it deliberately, for that one
     * process, on its very first line.
     *
     * When this function checked Turso first, every test file's careful
     * `JT_DB_PATH=':memory:'` was silently ignored in any shell that still had
     * the deploy variables exported, and `npm test` wrote its fixtures
     * straight into the production database. That happened: rows named
     * "Acknowledged Blocked 0.3533337459858453" appeared in the live company
     * picker, and the tests were blameless — they had done exactly what the
     * documentation told them to.
     *
     * The general rule the incident teaches: **the more specific, more
     * deliberate setting must beat the ambient one.** An explicit per-process
     * path is a statement about this run; an exported credential is leftover
     * context.
     */
    if (process.env.JT_DB_PATH) {
        if (url) {
            console.log(
                `JT_DB_PATH is set (${process.env.JT_DB_PATH}) — using it and ignoring TURSO_DATABASE_URL. ` +
                    'An explicitly chosen database always beats credentials left over in the environment.'
            );
        }
        return new Database(dbPath);
    }

    if (!url) {
        adoptLegacyDatabaseFile();
        return new Database(dbPath);
    }

    // A URL with no token is a misconfiguration that fails later, at the first
    // query, as an opaque auth error. Better to say so at startup.
    const authToken = readSecret('TURSO_AUTH_TOKEN');
    if (!authToken) {
        throw new Error('TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is not — the connection would be rejected.');
    }

    // Checked here rather than left to the driver, because the driver's own
    // complaint about a malformed URL does not say which value was malformed,
    // and the value is masked in CI logs — so there is nothing to eyeball.
    if (!/^libsql:\/\/[\w.-]+$/.test(url)) {
        throw new Error(
            `TURSO_DATABASE_URL is not a valid libSQL URL (got ${url.length} characters). ` +
                'It should look exactly like libsql://your-db-name.region.turso.io — no https://, ' +
                'no quotes, no trailing slash, and no whitespace or newline at either end.'
        );
    }

    console.log(`Using hosted database at ${url}`);
    return new Database(url, { authToken });
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

// Tables and every column added since. The lists live in schema.js so a tool
// can bring a brand-new remote database to the same shape without opening a
// connection of its own — see the note at the top of that file.
applySchema(db);

/** Kept for callers that migrate a single column against this connection. */
const ensureColumn = (table, column, definition) => ensureColumnOn(db, table, column, definition);

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
        // `tools/reset-password.js` gives it (or a newly registered account)
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

/**
 * posted_at became a strict invariant (real ISO date or NULL — see
 * data/jobs.js's sanitizePostedAt and domain/jobFreshness.js) after rows
 * already existed with Workday's relative text ("Posted N Days Ago") and
 * Comeet's last-modified timestamp sitting in that column. New writes are
 * guarded at the source; this is the one-time (but safe to re-run — it's a
 * no-op once clean) sweep for what was already there before the guard
 * existed.
 *
 * Matches defensively — anything that fails validation, not just the two
 * known patterns — so a different adapter's past mistake gets caught the
 * same way. No db.transaction(): see the identical reasoning in
 * data/passwordResets.js — a remote libSQL connection is stateless HTTP and
 * a wrapped transaction throws against it. Each row's clear is independent
 * and idempotent, so there is nothing a transaction would buy here anyway.
 */
function cleanupInvalidPostedAt() {
    const rows = db.prepare('SELECT id, posted_at FROM job_snapshots WHERE posted_at IS NOT NULL').all();
    const bad = rows.filter((r) => !isValidPostedAt(r.posted_at));
    if (bad.length === 0) return;

    const clear = db.prepare('UPDATE job_snapshots SET posted_at = NULL WHERE id = ?');
    for (const row of bad) clear.run(row.id);
    console.log(
        `Cleared ${bad.length} invalid posted_at value(s) (relative text, a last-modified ` +
            'timestamp, or a future date) written before it became a strict invariant.'
    );
}

cleanupInvalidPostedAt();

/**
 * Comeet's stored posted_at is syntactically fine (a real YYYY-MM-DD) — it's
 * semantically wrong: it came from a last-modified timestamp, not a
 * first-published one, so cleanupInvalidPostedAt() above (which only catches
 * values that fail ISO-date validation) can never find it. Existing Comeet
 * rows need their own explicit sweep; new ones already write NULL directly
 * (see adapters/comeetAdapter.js).
 */
function cleanupComeetPostedAt() {
    const result = db
        .prepare(
            `UPDATE job_snapshots SET posted_at = NULL
              WHERE posted_at IS NOT NULL
                AND company_id IN (SELECT id FROM watched_companies WHERE adapter_type = 'comeet')`
        )
        .run();
    if (result.changes > 0) {
        console.log(`Cleared posted_at on ${result.changes} Comeet job(s) — it was a last-modified date, not a posting date.`);
    }
}

cleanupComeetPostedAt();

/**
 * `search_profiles.experience_filter` sat unread by `matcher.js` until the
 * browser CRUD work (docs/ROADMAP.md) made it live and validated against
 * `domain/vocabulary.js`'s EXPERIENCE_LEVELS — see ARCHITECTURE.md §4.4. A
 * profile written before that validation existed (this project's own seed
 * data included one: "student,junior", neither a real level) would now
 * silently match nothing by experience, which looks identical to "no jobs
 * fit you" and is a worse failure than the dead column ever was.
 *
 * Same shape as cleanupInvalidPostedAt above: keep only the comma-separated
 * values that are still valid, drop the rest, clear the column entirely if
 * nothing survives. Safe to re-run — a no-op once every row is clean.
 */
function cleanupInvalidExperienceFilters() {
    const { EXPERIENCE_LEVELS } = require('../domain/vocabulary');
    const validLevels = new Set(EXPERIENCE_LEVELS);

    const rows = db.prepare('SELECT id, experience_filter FROM search_profiles WHERE experience_filter IS NOT NULL').all();
    const update = db.prepare('UPDATE search_profiles SET experience_filter = ? WHERE id = ?');
    let cleaned = 0;

    for (const row of rows) {
        const kept = row.experience_filter
            .split(',')
            .map((v) => v.trim())
            .filter((v) => validLevels.has(v));
        const next = kept.length ? kept.join(',') : null;
        if (next !== row.experience_filter) {
            update.run(next, row.id);
            cleaned += 1;
        }
    }

    if (cleaned > 0) {
        console.log(
            `Cleared an invalid experience_filter value on ${cleaned} search profile(s) — ` +
                'matcher.js now enforces the closed vocabulary in domain/vocabulary.js.'
        );
    }
}

cleanupInvalidExperienceFilters();

/**
 * `job_snapshots.is_tech` defaults to 1 (tech) on ADD COLUMN — SQLite can't
 * default a new NOT NULL column to a computed value — so every row written
 * before this column existed needs classifying once. Self-contained here
 * rather than calling into data/jobs.js's own (equivalent, reusable-by-tools)
 * backfillIsTech(): jobs.js requires `db` from this file, so requiring jobs.js
 * from here would be circular — this file's `module.exports` hasn't run yet
 * at this point in its own execution, so jobs.js would receive `db`
 * undefined. Both use the same domain/techFilter.js rule, so they can never
 * disagree on the answer, only on when they run: this sweep fires once, automatically,
 * the moment the column appears; jobs.js's version is what a tool calls
 * later if the classification RULE itself changes.
 */
function backfillIsTech() {
    const { isTechJob } = require('../domain/techFilter');

    const rows = db.prepare('SELECT id, title, department, is_tech FROM job_snapshots').all();
    const toUpdate = rows
        .map((row) => ({ id: row.id, next: isTechJob(row) ? 1 : 0, current: row.is_tech }))
        .filter((row) => row.next !== row.current);

    if (toUpdate.length === 0) return;

    const BATCH_SIZE = 300;
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
        const batch = toUpdate.slice(i, i + BATCH_SIZE);
        const whenClauses = batch.map(() => 'WHEN ? THEN ?').join(' ');
        const inPlaceholders = batch.map(() => '?').join(', ');
        db.prepare(`UPDATE job_snapshots SET is_tech = CASE id ${whenClauses} END WHERE id IN (${inPlaceholders})`).run(
            ...batch.flatMap((r) => [r.id, r.next]),
            ...batch.map((r) => r.id)
        );
    }

    console.log(`Classified is_tech on ${toUpdate.length} job(s) — see server/domain/techFilter.js.`);
}

backfillIsTech();

module.exports = {
    db,
    ensureColumn,
    backfillOwnership,
    cleanupInvalidPostedAt,
    cleanupComeetPostedAt,
    cleanupInvalidExperienceFilters,
    backfillIsTech,
};
