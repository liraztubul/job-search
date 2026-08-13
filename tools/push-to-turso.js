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

// The schema first: `CREATE TABLE IF NOT EXISTS` makes this safe to re-run.
remote.exec(fs.readFileSync(path.join(ROOT, 'server', 'data', 'schema.sql'), 'utf8'));
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
    const placeholders = columns.map((c) => `@${c}`).join(', ');
    // INSERT OR REPLACE, so re-running updates changed rows instead of failing
    // on the primary key — this is a refresh, not a one-time import.
    const insert = remote.prepare(
        `INSERT OR REPLACE INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`
    );

    const pushAll = remote.transaction((batch) => {
        for (const row of batch) insert.run(row);
    });
    pushAll(rows);

    console.log(`  ${table}: ${rows.length} row(s) pushed`);
}

// Read it back from the remote rather than trusting the writes returned OK.
const jobs = remote.prepare('SELECT COUNT(*) AS n FROM job_snapshots').get().n;
const companies = remote.prepare('SELECT COUNT(*) AS n FROM watched_companies').get().n;
const users = remote.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const applications = remote.prepare('SELECT COUNT(*) AS n FROM applications').get().n;

console.log(`\nRemote now holds: ${jobs} job(s), ${companies} company(ies).`);
console.log(`Untouched by this tool: ${users} account(s), ${applications} application(s).\n`);
