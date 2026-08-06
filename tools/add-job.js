/**
 * add-job.js — add one job to a manual list without editing JSON by hand.
 *
 *   node tools/add-job.js --file rafael --title "מהנדס.ת תוכנה" --url "https://..."
 *   node tools/add-job.js --file rafael          list what's already in the file
 *
 * Options
 *   --file        required. which list under data/manual/, e.g. rafael
 *   --title       required
 *   --url         required. where you apply
 *   --id          optional. defaults to a slug of the title + today's date
 *   --location    optional. e.g. Haifa
 *   --department  optional
 *   --type        optional. "Full time", "Student", "Part time"...
 *   --code        optional. the requisition number the company shows you
 *   --posted      optional. YYYY-MM-DD, defaults to today
 *
 * Why a tool and not a text editor: hand-edited JSON breaks in three ways —
 * a trailing comma, a duplicated id, a missing quote — and two of them are
 * silent. This writes valid JSON, refuses a duplicate id before saving, and
 * re-reads the file afterwards to prove it still parses.
 */

const fs = require('fs');
const path = require('path');
const { parseManualJobs, MANUAL_DIR } = require('../server/adapters/manualAdapter');
const { guessExperienceFromTitle, normalizeEmploymentType } = require('../server/domain/vocabulary');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        args[key] = next && !next.startsWith('--') ? next : true;
        if (args[key] !== true) i++;
    }
    return args;
}

const today = () => new Date().toISOString().slice(0, 10);

/** A readable, stable id when the company doesn't give you one. */
function slugId(title) {
    const slug = String(title)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
    return `${slug}-${today()}`;
}

function usage() {
    console.log(`
Add one job to a manual list.

  node tools/add-job.js --file rafael --title "מהנדס.ת תוכנה" --url "https://..."

Required: --file  --title  --url
Optional: --id --location --department --type --code --posted

List an existing file:
  node tools/add-job.js --file rafael
`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.file) {
        usage();
        process.exit(1);
    }

    const filePath = path.join(MANUAL_DIR, `${path.basename(String(args.file))}.json`);
    const label = path.basename(filePath);

    let rows = [];
    if (fs.existsSync(filePath)) {
        const contents = fs.readFileSync(filePath, 'utf8');
        try {
            // Parse through the adapter's own reader, so this tool and the
            // scrape agree on what a valid file is.
            parseManualJobs(contents, label);
        } catch (err) {
            console.error(`\n${label} is currently invalid:\n  ${err.message}\n`);
            console.error('Fix it before adding more, or the next scrape will fail too.\n');
            process.exit(1);
        }
        rows = JSON.parse(contents);
    }

    // No title/url means "just show me what's in here".
    if (!args.title || !args.url) {
        console.log(`\n${label} — ${rows.length} job(s):\n`);
        for (const row of rows) {
            const level = guessExperienceFromTitle(row.title);
            console.log(`  ${String(row.externalId).padEnd(28)} ${row.title}`);
            console.log(`  ${''.padEnd(28)} ${row.location || 'no location'} · ${level || 'no level'}`);
        }
        if (rows.length === 0) console.log('  (empty)');
        console.log('');
        if (!args.title && !args.url) process.exit(0);
        console.error('Both --title and --url are required to add a job.\n');
        process.exit(1);
    }

    const externalId = String(args.id || slugId(args.title));

    if (rows.some((row) => String(row.externalId) === externalId)) {
        console.error(`\n"${externalId}" is already in ${label}.`);
        console.error('Pass a different --id, or edit the existing entry.\n');
        process.exit(1);
    }

    const entry = {
        externalId,
        title: String(args.title),
        applyUrl: String(args.url),
        location: args.location ? String(args.location) : '',
        department: args.department ? String(args.department) : null,
        employmentType: args.type ? String(args.type) : null,
        postedAt: args.posted ? String(args.posted) : today(),
        jobCode: args.code ? String(args.code) : null,
    };

    rows.push(entry);
    fs.mkdirSync(MANUAL_DIR, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');

    // Read it back through the adapter. Writing a file the scrape can't read
    // would be a failure discovered hours later, at the worst moment.
    let saved;
    try {
        saved = parseManualJobs(fs.readFileSync(filePath, 'utf8'), label);
    } catch (err) {
        console.error(`\nWrote the file but it no longer parses: ${err.message}\n`);
        process.exit(1);
    }

    const job = saved.find((j) => j.externalId === externalId);
    console.log(`\nAdded to ${label} (${saved.length} total):\n`);
    console.log(`  id         ${job.externalId}`);
    console.log(`  title      ${job.title}`);
    console.log(`  location   ${job.location || '—'}`);
    console.log(`  level      ${job.experienceLevel || '— (not inferable from the title)'}`);
    console.log(`  type       ${job.employmentType || '—'}`);
    if (args.type && !job.employmentType) {
        console.log(`\n  note: "${args.type}" isn't a recognised employment type, so it was`);
        console.log('        stored as unknown rather than guessed. Try "Full time",');
        console.log(`        "Part time", "Student" or "Contract". Known: ${['full-time','part-time','contract','temporary','internship'].join(', ')}`);
    }
    console.log('\nNext: node server/main.js\n');
}

main();
