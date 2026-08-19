/**
 * set-company-active.js — stop (or resume) tracking a watched company
 * without deleting its history.
 *
 *   node tools/set-company-active.js --name "IBM Israel" --active false
 *   node tools/set-company-active.js --name "IBM Israel" --active true
 *
 * Deactivating stops future scrape cycles from touching the company AND
 * removes it from the search page's company filter (see filterOptions() in
 * server/data/jobs.js) — a company the site has stopped tracking must not
 * still be offered as something to browse, which is exactly the gap this
 * script closes for a company whose adapter genuinely, confirmedly returns
 * zero results rather than being broken (see CLAUDE.md's note on IBM Israel).
 *
 * Existing job_snapshots rows are never touched — this only changes whether
 * the company is scraped and offered going forward.
 *
 * Works against whichever database the environment points at — the local
 * file by default, or Turso when TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are set
 * (server/data/connection.js resolves this already).
 */

const db = require('../server/data');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        args[argv[i].slice(2)] = argv[i + 1];
        i++;
    }
    return args;
}

function main() {
    const { name, active } = parseArgs(process.argv.slice(2));

    if (!name || active === undefined) {
        console.log('\nUsage: node tools/set-company-active.js --name "Company Name" --active true|false\n');
        process.exit(1);
    }

    const company = db.findCompanyByName(name);
    if (!company) {
        console.error(`\nNo watched company named "${name}". See \`node tools/add-company.js\` for the current list.\n`);
        process.exit(1);
    }

    const isActive = active === 'true';
    db.setCompanyActive(company.id, isActive);
    console.log(`\n"${name}" is now ${isActive ? 'active' : 'inactive'}.`);
    if (!isActive) console.log('It will no longer be scraped or offered as a filter option.\n');
    else console.log('\n');
}

main();
