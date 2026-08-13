/**
 * push-to-turso.js — copy the local database up to the hosted one.
 *
 *   set TURSO_DATABASE_URL=libsql://...
 *   set TURSO_AUTH_TOKEN=...
 *   node tools/push-to-turso.js
 *
 * WHY THIS EXISTS
 *
 * A newly created Turso database is empty — no schema, no companies, no jobs.
 * Deploying against it would produce a site that works perfectly and shows
 * nothing, which reads as a bug rather than as an empty database.
 *
 * This applies the schema and copies the shared tables up. It is a one-way
 * push, run by hand, and it is the same operation as re-running the scrape:
 * job listings are public data that can always be regenerated.
 *
 * WHAT IT WILL NOT DO
 *
 * It never copies accounts, applications or saved searches, in either
 * direction. Those belong to whoever created them on whichever database they
 * used — pushing your local ones up would plant your rows in other people's
 * database, and pulling theirs down would put strangers' data on your laptop.
 * Jobs are shared; personal data is not, and a sync tool is exactly where that
 * distinction gets forgotten.
 */

const fs = require('fs');
const path = require('path');
const Database = require('libsql');

const ROOT = path.join(__dirname, '..');
const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token } = process.env;

if (!url || !token) {
    console.error('\nSet both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN first.\n');
    console.error('PowerShell:');
    console.error('  $env:TURSO_DATABASE_URL="libsql://your-db.turso.io"');
    console.error('  $env:TURSO_AUTH_TOKEN="..."');
    console.error('  node tools/push-to-turso.js\n');
    process.exit(1);
}

function findLocalDatabase() {
    for (const name of ['jobtrail.db', 'jobtracker.db']) {
        const candidate = path.join(ROOT, name);
        if (fs.existsSync(candidate)) return candidate;
    }
    console.error('\nNo local database found. Run `node server/main.js` first.\n');
    process.exit(1);
}

const localPath = findLocalDatabase();
const local = new Database(localPath);
const remote = new Database(url, { authToken: token });

console.log(`\nPushing ${path.basename(localPath)} -> ${url}\n`);

// The schema first — and via the same function the app itself uses, not by
// reading schema.sql directly. Six of `job_snapshots`' columns were added after
// the table existed and live only in connection.js's migration list, so a
// database built from schema.sql alone rejects every job insert with "no column
// named location_search". Sharing the function is what stops the two from
// drifting the next time a column is added.
//
// Safe to re-run: CREATE TABLE IF NOT EXISTS does nothing to an existing table,
// and each column is added only when absent.
// From data/schema.js, not data/connection.js: requiring connection.js opens a
// database as a side effect, and with TURSO_DATABASE_URL set — which it is,
// here — that would be a second connection to the very database being written.
const { applySchema } = require('../server/data/schema');
applySchema(remote);
console.log('  schema applied');

/** Companies before jobs — job_snapshots.company_id references them. */
const SHARED_TABLES = ['watched_companies', 'job_snapshots'];

for (const table of SHARED_TABLES) {
    const rows = local.prepare(`SELECT * FROM "${table}"`).all();
    if (rows.length === 0) {
        console.log(`  ${table}: nothing to push`);
        continue;
    }

    const columns = Object.keys(rows[0]);
    const columnList = columns.map((c) => `"${c}"`).join(', ');

    /**
     * No `remote.transaction()` here, deliberately.
     *
     * A remote libSQL connection is stateless HTTP: `BEGIN` and `COMMIT` travel
     * as separate requests and the server has nothing tying them together, so
     * the wrapper's `ROLLBACK` arrives at a connection that never opened a
     * transaction — "cannot rollback - no transaction is active". It works
     * perfectly against a local file, which is exactly why it is easy to miss.
     *
     * Atomicity is not needed: every statement is `INSERT OR REPLACE`, so a run
     * that dies halfway can simply be run again. What *is* needed is fewer
     * round trips — 2,500 single-row inserts over the network is thousands of
     * requests. Multi-row VALUES batches turn that into a few dozen.
     *
     * Batch size is derived from the column count because SQLite caps bound
     * parameters per statement (999 on older builds); a hardcoded 100 would
     * work for one table and fail on the next one to gain a column.
     */
    const batchSize = Math.max(1, Math.floor(900 / columns.length));

    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const tuple = `(${columns.map(() => '?').join(', ')})`;
        const sql = `INSERT OR REPLACE INTO "${table}" (${columnList}) VALUES ${batch.map(() => tuple).join(', ')}`;
        remote.prepare(sql).run(batch.flatMap((row) => columns.map((c) => row[c])));
    }

    console.log(`  ${table}: ${rows.length} row(s) pushed`);
}

// Read it back from the remote rather than trusting the writes returned OK.
const jobs = remote.prepare('SELECT COUNT(*) AS n FROM job_snapshots').get().n;
const companies = remote.prepare('SELECT COUNT(*) AS n FROM watched_companies').get().n;
const users = remote.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const applications = remote.prepare('SELECT COUNT(*) AS n FROM applications').get().n;

console.log(`\nRemote now holds: ${jobs} job(s), ${companies} company(ies).`);
console.log(`Untouched by this tool: ${users} account(s), ${applications} application(s).\n`);
