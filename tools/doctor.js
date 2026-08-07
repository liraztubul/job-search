/**
 * doctor.js — why isn't my job showing up?
 *
 *   node tools/doctor.js
 *
 * Walks the whole chain and reports the first link that's broken:
 *
 *   file / API  ->  company row  ->  adapter builds  ->  scrape ran  ->  in the UI
 *
 * Every one of those steps can fail without an error reaching you. A manual
 * file with no company row is just a file nobody reads. A company row whose
 * scrape never ran is a row with no jobs behind it. Both look identical from
 * the browser: an empty list.
 */

const fs = require('fs');
const path = require('path');
const data = require('../server/data');
const { buildAdapter, availableTypes } = require('../server/adapters');
const { MANUAL_DIR, parseManualJobs } = require('../server/adapters/manualAdapter');

const ok = (msg) => console.log(`  OK    ${msg}`);
const bad = (msg, fix) => {
    console.log(`  FIX   ${msg}`);
    if (fix) console.log(`        -> ${fix}`);
};

let problems = 0;
const fail = (...args) => {
    problems++;
    bad(...args);
};

console.log('\nJob Tracker — checking the chain\n');

// --- 1. companies ---------------------------------------------------------
const companies = data.listCompanies();
console.log(`1. Companies registered: ${companies.length}`);

if (companies.length === 0) {
    fail('no companies are being watched', 'node tools/add-company.js');
}

// --- 2. manual files without a company row --------------------------------
if (fs.existsSync(MANUAL_DIR)) {
    const files = fs.readdirSync(MANUAL_DIR).filter((f) => f.endsWith('.json'));
    const configured = new Set(
        companies
            .filter((c) => c.adapter_type === 'manual')
            .map((c) => JSON.parse(c.adapter_config || '{}').file)
    );

    for (const file of files) {
        const name = file.replace(/\.json$/, '');
        if (configured.has(name)) continue;
        fail(
            `data/manual/${file} exists but no company uses it — nothing reads this file`,
            `node tools/add-company.js --name "${name}" --type manual --file ${name}`
        );
    }
}

// --- 3. each company: does it build, and does it have jobs? ---------------
console.log('');
for (const company of companies) {
    const jobCount = data.countJobs(1, { companyId: company.id });
    console.log(`2. ${company.name}  (${company.adapter_type})`);

    try {
        buildAdapter(company);
        ok('adapter builds');
    } catch (err) {
        fail(`adapter won't build: ${err.message}`);
        continue;
    }

    if (company.adapter_type === 'manual') {
        const file = JSON.parse(company.adapter_config || '{}').file;
        const filePath = path.join(MANUAL_DIR, `${file}.json`);

        if (!fs.existsSync(filePath)) {
            fail(`no file at data/manual/${file}.json`, `node tools/add-job.js --file ${file} --title "…" --url "…"`);
            continue;
        }

        let entries;
        try {
            entries = parseManualJobs(fs.readFileSync(filePath, 'utf8'), `${file}.json`);
            ok(`${file}.json parses — ${entries.length} job(s) in it`);
        } catch (err) {
            fail(`${file}.json is broken: ${err.message}`);
            continue;
        }

        const placeholder = entries.filter((e) => /REPLACE.?ME/i.test(e.externalId));
        if (placeholder.length) {
            fail(
                `${placeholder.length} entry still has the placeholder id "${placeholder[0].externalId}"`,
                'replace it with a real job, or delete that entry'
            );
        }

        if (entries.length > jobCount) {
            fail(
                `${entries.length} job(s) in the file but ${jobCount} in the database — the scrape hasn't run since you edited it`,
                'node server/main.js'
            );
        }
    }

    if (jobCount === 0) {
        fail('0 jobs in the database for this company', 'node server/main.js');
    } else {
        ok(`${jobCount} job(s) in the database`);
    }
}

// --- 4. what the UI will actually show ------------------------------------
// Account 1 is the convention this whole project uses for local/dev tooling —
// the same account you always are when JT_SESSION_SECRET isn't set.
const total = data.countJobs(1, {});
const open = data.countJobs(1, { openOnly: true });

console.log(`\n3. What the search page shows`);
console.log(`   ${total} job(s) total, ${open} marked open`);

if (total > 0 && open === 0) {
    fail(
        'every job is marked closed, and the page filters to open jobs by default',
        'untick "משרות פתוחות בלבד" in the UI'
    );
}

console.log('');
if (problems === 0) {
    console.log('Nothing wrong here. If a job still isn\'t visible, check the filters at the');
    console.log('top of the page — a leftover location or experience filter hides everything');
    console.log('that doesn\'t match. "נקה סינון" resets them.\n');
} else {
    console.log(`${problems} thing(s) to fix, listed above.\n`);
}

console.log(`Registered adapters: ${availableTypes().join(', ')}\n`);
