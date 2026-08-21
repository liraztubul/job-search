/**
 * acknowledge-issue.js — record that a human already knows about a standing
 * scrape failure for a company, so the scheduled run stops shouting about it
 * every single cycle without silencing a DIFFERENT kind of failure from the
 * same company.
 *
 *   node tools/acknowledge-issue.js --name "Check Point Israel" --kind blocked --reason "blocks the GitHub runner's address, confirmed 2026-08-21"
 *   node tools/acknowledge-issue.js --name "Check Point Israel" --clear
 *
 * `--kind` must be one of: broken, blocked, empty, refused (see
 * server/domain/scrapeOutcome.js's FAILURE_KIND). A scrape failure of
 * exactly this kind for this company prints every cycle but does not turn
 * the run red; a failure of any OTHER kind still does — acknowledging
 * "Check Point blocks us" can never quietly cover up "Check Point now
 * returns garbage".
 *
 * `--reason` is required with `--kind`, on purpose: this is meant to be a
 * deliberate act with a paper trail, not a config edit nobody remembers
 * making or why.
 *
 * Works against whichever database the environment points at — the local
 * file by default, or Turso when TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are
 * set (server/data/connection.js resolves this already).
 */

const db = require('../server/data');
const { FAILURE_KIND } = require('../server/domain/scrapeOutcome');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        // --clear is a flag, not a key/value pair — the next token (if any)
        // is the next flag, not this one's value.
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
            '  node tools/acknowledge-issue.js --name "Company Name" --kind <broken|blocked|empty|refused> --reason "why"\n' +
            '  node tools/acknowledge-issue.js --name "Company Name" --clear\n'
    );
}

function main() {
    const { name, kind, reason, clear } = parseArgs(process.argv.slice(2));

    if (!name || (!clear && (!kind || !reason))) {
        usage();
        process.exit(1);
    }

    const company = db.findCompanyByName(name);
    if (!company) {
        console.error(`\nNo watched company named "${name}". See \`node tools/add-company.js\` for the current list.\n`);
        process.exit(1);
    }

    if (clear) {
        db.clearKnownIssue(company.id);
        console.log(`\n"${name}" no longer has an acknowledged issue — the next matching failure will go red again.\n`);
        return;
    }

    if (!Object.values(FAILURE_KIND).includes(kind)) {
        console.error(`\n"${kind}" isn't a real kind. Use one of: ${Object.values(FAILURE_KIND).join(', ')}\n`);
        process.exit(1);
    }

    db.setKnownIssue(company.id, kind, reason);
    console.log(`\n"${name}" — ${kind} failures are now acknowledged: ${reason}`);
    console.log('A failure of any OTHER kind from this company will still turn the run red.\n');
}

main();
