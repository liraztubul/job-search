/**
 * set-link-only.js — mark a watched company as "listed, but not collected":
 * its own site blocks automated collection outright, and rather than pretend
 * otherwise (or engineer around the block — this project has consistently
 * declined to, see CLAUDE.md's Rafael/Reblaze notes), the site says so
 * plainly and links out to the company's own careers page instead.
 *
 *   node tools/set-link-only.js --name "Rafael" --reason "Reblaze bot protection blocks automated collection, confirmed 2026-08-06"
 *   node tools/set-link-only.js --name "Rafael" --clear
 *
 * What this actually changes:
 *   - the company is skipped by the scheduled scrape entirely (not attempted,
 *     not counted as a failure)
 *   - its existing job_snapshots rows are hidden from search results
 *   - it still appears in the company picker, marked, and still counts
 *     toward filterOptions() — a company someone can knowingly choose to see
 *     the "look on their own site" notice for, not one that silently vanishes
 *
 * Existing job rows are NEVER deleted by this or by clearing it — see
 * server/data/companies.js's setLinkOnly/clearLinkOnly. A presentation
 * decision must stay reversible.
 *
 * `--reason` is required with the flag set, same rationale as
 * tools/acknowledge-issue.js: a deliberate act with a paper trail, not a
 * config edit nobody remembers making or why.
 *
 * This is NOT the same thing as tools/acknowledge-issue.js's known_issue_kind
 * — that says "this failure is expected right now"; this says "we
 * deliberately do not collect from here at all". A company can need either,
 * and conflating them would make an acknowledgment ambiguous about which one
 * it actually records.
 *
 * Works against whichever database the environment points at — the local
 * file by default, or Turso when TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are
 * set (server/data/connection.js resolves this already).
 */

const db = require('../server/data');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        if (key === 'clear') {
            args[key] = true;
            continue;
        }
        args[key] = argv[i + 1];
        i++;
    }
    return args;
}

function usage() {
    console.log(
        '\nUsage:\n' +
            '  node tools/set-link-only.js --name "Company Name" --reason "why their site blocks collection"\n' +
            '  node tools/set-link-only.js --name "Company Name" --clear\n'
    );
}

function main() {
    const { name, reason, clear } = parseArgs(process.argv.slice(2));

    if (!name || (!clear && !reason)) {
        usage();
        process.exit(1);
    }

    const company = db.findCompanyByName(name);
    if (!company) {
        console.error(`\nNo watched company named "${name}". See \`node tools/add-company.js\` for the current list.\n`);
        process.exit(1);
    }

    if (clear) {
        db.clearLinkOnly(company.id);
        console.log(`\n"${name}" is scraped and shown normally again.\n`);
        return;
    }

    db.setLinkOnly(company.id, reason);
    console.log(`\n"${name}" is now link-only: ${reason}`);
    console.log('It will no longer be scraped, and its jobs are hidden from search — the site now links out to their careers page instead.\n');
}

main();
