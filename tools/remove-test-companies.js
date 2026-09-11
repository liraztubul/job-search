/**
 * remove-test-companies.js — clean test fixtures out of a real database.
 *
 *   node tools/remove-test-companies.js            list what would go (dry run)
 *   node tools/remove-test-companies.js --confirm  actually delete
 *
 * WHY THIS EXISTS
 *
 * `npm test` once wrote its fixtures into the live database. Every test file
 * sets `JT_DB_PATH=':memory:'` on its first line, exactly as documented — but
 * `connection.js` used to check `TURSO_DATABASE_URL` *first*, so in a shell
 * that still had the deploy credentials exported, that setting was ignored and
 * the tests connected to production. Rows named
 * "Acknowledged Blocked 0.3533337459858453" turned up in the live company
 * picker. The precedence is fixed (see openDatabase), but the rows it created
 * are still there and have to be removed.
 *
 * WHAT IT MATCHES, AND WHY NARROWLY
 *
 * Test fixtures give themselves away with a `Math.random()` suffix — a long
 * decimal inside a company name — or with names no real employer would have
 * ("Test …", "Pacing …"). Both patterns are listed below.
 *
 * This deliberately does NOT try to be clever about "companies that look
 * unused". A real company with zero jobs right now is normal (Snyk, Broadcom,
 * Amdocs all are, and all are documented). **Deleting a real company row
 * destroys its job history and any application someone tracked against it**,
 * so the matcher stays narrow and the default stays a dry run.
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../server/data/connection');
const { MANUAL_DIR } = require('../server/adapters/manualAdapter');

/** A `Math.random()` suffix, or a name only a fixture would carry. */
const FIXTURE_PATTERNS = [
    /\b0\.\d{6,}\b/, // "Acknowledged Blocked 0.3533337459858453"
    /^Test\b/i,
    /^Pacing\b/i,
    /^Retry\b/i,
    /^Link Only\b/i,
    /^Acknowledged\b/i,
    /^Fixture\b/i,
    /^Example Co\b/i,
];

const looksLikeFixture = (name) => FIXTURE_PATTERNS.some((re) => re.test(name));

/**
 * A `manual` company whose job file does not exist.
 *
 * Name matching keeps failing on these. The first pass missed
 * `bob-delete@example.com` because it had no random suffix; the second missed
 * three rows named literally **`Rafael`** — the same name as the real company —
 * created by test files pointing at `data/manual/somefile.json`. Deleting by
 * name would have taken the real Rafael with them.
 *
 * The reliable discriminator is not what a row is called but **whether it can
 * ever work**. A manual company is nothing but a pointer to a JSON file; if
 * that file does not exist, the row produces no jobs and fails every single
 * scrape, forever. That is true whether it is a leftover fixture or a genuine
 * typo, and in both cases it does not belong in a live database.
 *
 * The real Rafael is exempt for free: it is link-only, so it is never fetched
 * and its file is never consulted. Belt and braces, the check skips link-only
 * rows explicitly.
 */
function manualFileMissing(company) {
    if (company.adapter_type !== 'manual') return false;
    if (company.link_only_reason) return false;

    let file;
    try {
        file = JSON.parse(company.adapter_config || '{}').file;
    } catch {
        return true; // unparseable config can never resolve to a file
    }
    if (!file) return true; // no `file` option at all — "Meta Tenancy Co"

    return !fs.existsSync(path.join(MANUAL_DIR, `${path.basename(file)}.json`));
}

/**
 * The guard below exists to protect a *real person's* tracked applications. A
 * fixture account's application is not that.
 *
 * `tests/accountDeletion.test.js` necessarily creates a user, a company and an
 * application — that is the thing it tests. All three carry the same
 * `Math.random()` fingerprint. Refusing to clean up because a fixture owns a
 * fixture would leave the database dirty forever.
 *
 * So the question is not "are there applications" but "does a real account own
 * one". An email is treated as a fixture only on the same narrow evidence used
 * for companies; anything else is assumed to be a person, and one such owner
 * stops the whole run.
 */
const FIXTURE_EMAIL_PATTERNS = [
    /\b0\.\d{6,}\b/,

    /**
     * The reserved test domains — RFC 2606 and RFC 6761 set these aside so
     * documentation and test suites have addresses that can never belong to a
     * real person. **Nobody's actual mailbox is here**, which makes this a far
     * stronger signal than guessing at name prefixes.
     *
     * Added after the prefix list alone missed `bob-delete@example.com`: no
     * random suffix, no matching prefix, and unmistakably a fixture to any
     * human reading it. The domain was the part that gave it away.
     */
    /@(example|test|invalid|localhost)\.(com|org|net|test|invalid|localhost)$/i,
    /@(example|test|invalid|localhost)$/i,

    /^(test|fixture|seed|deletion|verify)[-_.]/i,
];
const looksLikeFixtureEmail = (email) => FIXTURE_EMAIL_PATTERNS.some((re) => re.test(email || ''));

const confirm = process.argv.includes('--confirm');

const companies = db
    .prepare('SELECT id, name, adapter_type, adapter_config, link_only_reason FROM watched_companies ORDER BY id')
    .all();

// Two independent signals: the name looks like a fixture, or the row is a
// manual company pointing at a file that isn't there. Either is enough — the
// second exists because three rows named literally "Rafael" got past the first.
const doomed = companies.filter((c) => looksLikeFixture(c.name) || manualFileMissing(c));

console.log(`\n${companies.length} companies in this database.`);

if (doomed.length === 0) {
    console.log('None look like test fixtures. Nothing to do.\n');
    process.exit(0);
}

// Count what goes with each one, so the number is visible BEFORE deleting
// rather than reported afterwards.
const jobCount = db.prepare('SELECT COUNT(*) AS n FROM job_snapshots WHERE company_id = ?');
const appCount = db.prepare(
    'SELECT COUNT(*) AS n FROM applications WHERE job_snapshot_id IN (SELECT id FROM job_snapshots WHERE company_id = ?)'
);

console.log(`\n${doomed.length} look like test fixtures:\n`);

let totalJobs = 0;
let totalApps = 0;
for (const c of doomed) {
    const jobs = jobCount.get(c.id).n;
    const apps = appCount.get(c.id).n;
    totalJobs += jobs;
    totalApps += apps;
    // Say WHICH signal caught it — with three rows sharing the real Rafael's
    // name, "trust me, it's a fixture" is not good enough to delete on.
    const why = looksLikeFixture(c.name) ? 'name' : `manual file missing (${c.adapter_config || 'no config'})`;
    console.log(
        `  #${String(c.id).padEnd(4)} ${c.name.slice(0, 40).padEnd(42)} ${String(jobs).padStart(3)} job(s)` +
            `${apps ? `, ${apps} app(s)` : '       '}  [${why}]`
    );
}

if (totalApps > 0) {
    const ids = doomed.map((c) => c.id);
    const owners = db
        .prepare(
            `SELECT DISTINCT u.id, u.email
               FROM applications a
               JOIN job_snapshots j ON j.id = a.job_snapshot_id
               JOIN users u ON u.id = a.user_id
              WHERE j.company_id IN (${ids.map(() => '?').join(',')})`
        )
        .all(...ids);

    const real = owners.filter((o) => !looksLikeFixtureEmail(o.email));

    if (real.length) {
        console.error(`\nSTOP: ${totalApps} tracked application(s) here belong to accounts that look real:`);
        for (const o of real) console.error(`  ${o.email}`);
        console.error(
            '\nA test fixture should have none. Either the matcher caught a real company, or a real person ' +
                'tracked an application against a fixture row. Nothing deleted — resolve it by hand.\n'
        );
        process.exit(1);
    }

    console.log(`\n${totalApps} tracked application(s) here, all owned by fixture accounts:`);
    for (const o of owners) console.log(`  ${o.email}`);
    console.log('  (these go too — they are test data, not anyone\'s real tracking)');
}

if (!confirm) {
    console.log(`\nDry run — nothing deleted. ${totalJobs} job row(s) would go with them.`);
    console.log('Re-run with --confirm to delete.\n');
    process.exit(0);
}

// Children first: no db.transaction() — it throws against a remote libSQL
// connection (BEGIN and COMMIT are separate stateless requests). Deleting jobs
// before companies means an interruption leaves no row pointing at a company
// that no longer exists.
const deleteApps = db.prepare(
    'DELETE FROM applications WHERE job_snapshot_id IN (SELECT id FROM job_snapshots WHERE company_id = ?)'
);
const deleteNotifications = db.prepare(
    'DELETE FROM notifications_sent WHERE job_snapshot_id IN (SELECT id FROM job_snapshots WHERE company_id = ?)'
);
const deleteJobs = db.prepare('DELETE FROM job_snapshots WHERE company_id = ?');
const deleteCompany = db.prepare('DELETE FROM watched_companies WHERE id = ?');

for (const c of doomed) {
    // Strictly children before parents. Anything referencing a job must go
    // before the job, and the jobs before the company — an interruption then
    // leaves no row pointing at something that is gone.
    deleteApps.run(c.id);
    deleteNotifications.run(c.id);
    deleteJobs.run(c.id);
    deleteCompany.run(c.id);
    console.log(`  removed ${c.name.slice(0, 60)}`);
}

/**
 * Fixture accounts the same test files created. Left behind they are harmless
 * but confusing — and one of them holds a password hash nobody will ever use,
 * in a table that otherwise contains only real people.
 */
const fixtureUsers = db
    .prepare('SELECT id, email FROM users')
    .all()
    .filter((u) => looksLikeFixtureEmail(u.email));

for (const u of fixtureUsers) {
    db.prepare('DELETE FROM applications WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM search_profiles WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    console.log(`  removed account ${u.email}`);
}

const left = db.prepare('SELECT COUNT(*) AS n FROM watched_companies').get().n;
const usersLeft = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
console.log(
    `\nDone. ${doomed.length} companies removed, ${totalJobs} job row(s) with them` +
        `${fixtureUsers.length ? `, ${fixtureUsers.length} fixture account(s)` : ''}.`
);
console.log(`${left} companies and ${usersLeft} account(s) remain.\n`);
