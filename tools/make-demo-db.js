/**
 * make-demo-db.js — build the database that ships inside the public demo.
 *
 *   node tools/make-demo-db.js
 *
 * WHY THIS EXISTS
 *
 * The live demo runs on a host with no persistent disk: the container's
 * filesystem is rebuilt from the image on every deploy and every wake from
 * sleep. That is fatal for accounts and useless for job listings — unless the
 * listings ship *inside* the image, which is exactly what this produces.
 *
 * It is a copy of your real database with every personal table emptied. Jobs
 * and watched companies are public information; applications, saved searches
 * and accounts are not, and this file gets committed to a public repository.
 *
 * The deletion is a whitelist by omission: it names the tables to keep and
 * empties everything else it finds. A table added later that nobody remembers
 * to list here is emptied by default rather than published by default — the
 * safe direction for a mistake.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'demo.db');

/**
 * The project was renamed from "Job Tracker" to JobTrail, and so was the
 * database file. `server/data/connection.js` performs that rename the first
 * time it opens the database — but this tool talks to better-sqlite3 directly
 * and never loads that module, so on a machine where the server has not been
 * started since the rename, the new name does not exist yet. Looking for both
 * is cheaper than an error message telling you to go and start the server.
 */
function findDatabase() {
    if (process.env.JT_DB_PATH) return process.env.JT_DB_PATH;
    for (const name of ['jobtrail.db', 'jobtracker.db']) {
        const candidate = path.join(ROOT, name);
        if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(ROOT, 'jobtrail.db'); // for the error message below
}

const SOURCE = findDatabase();

/** The only tables whose contents are safe to publish. */
const PUBLIC_TABLES = new Set(['job_snapshots', 'watched_companies', 'sqlite_sequence']);

if (!fs.existsSync(SOURCE)) {
    console.error(`No database at ${SOURCE}. Run \`node server/main.js\` first.`);
    process.exit(1);
}

fs.copyFileSync(SOURCE, TARGET);
// A copy taken while the source was mid-write can carry a stale journal.
for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(TARGET + suffix)) fs.unlinkSync(TARGET + suffix);
}

const db = new Database(TARGET);

// `applications.user_id` and `search_profiles.user_id` reference `users(id)`,
// so emptying `users` first fails and emptying it last depends on the order
// sqlite_master happens to return. Rather than encode a deletion order that a
// future foreign key would silently invalidate, switch the constraints off:
// every table being emptied is emptied, so nothing can be left dangling.
db.pragma('foreign_keys = OFF');

const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);

console.log(`\nBuilding demo.db from ${path.basename(SOURCE)}\n`);

let emptied = 0;
for (const table of tables) {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;

    if (PUBLIC_TABLES.has(table)) {
        console.log(`  keep    ${table.padEnd(20)} ${before} row(s)`);
        continue;
    }

    db.prepare(`DELETE FROM "${table}"`).run();
    emptied += before;
    console.log(`  EMPTIED ${table.padEnd(20)} ${before} row(s) removed`);
}

// VACUUM rewrites the file. Without it the deleted rows are merely marked free
// and remain readable in the raw bytes — a "deleted" application status would
// still be recoverable from a file published on GitHub.
db.exec('VACUUM');
db.close();

const size = (fs.statSync(TARGET).size / 1024 / 1024).toFixed(1);
console.log(`\n${emptied} personal row(s) removed, file vacuumed. demo.db is ${size} MB.`);

// Proving it rather than asserting it: reopen and re-count.
const check = new Database(TARGET, { readonly: true });
const leaks = tables
    .filter((t) => !PUBLIC_TABLES.has(t))
    .map((t) => [t, check.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n])
    .filter(([, n]) => n > 0);
check.close();

if (leaks.length) {
    // Delete it. A half-processed demo.db left on disk is a file that still
    // holds personal rows and is named as though it does not — precisely the
    // thing that gets committed by someone who did not read the error.
    fs.unlinkSync(TARGET);
    console.error('\nSTOP — personal rows survived:', leaks.map(([t, n]) => `${t}=${n}`).join(', '));
    console.error('demo.db has been deleted rather than left in that state.\n');
    process.exit(1);
}

console.log('Verified: every personal table is empty.\n');
console.log('Commit it:  git add -f demo.db && git commit -m "update demo data"\n');
