/**
 * ci-add-batch-2026-09-24b.js — one-off: add the 3 companies from
 * MORE-COMPANIES-PROMPT.md, directly against whatever database
 * server/data/connection.js resolves (Turso when TURSO_DATABASE_URL /
 * TURSO_AUTH_TOKEN are set, which is how the CI workflow that runs this
 * invokes it).
 *
 * Idempotent: skips a company that's already watched instead of crashing.
 * Delete this file and the workflow that calls it once the push is
 * confirmed live — same pattern as ci-add-batch-2026-09-24.js (removed
 * after the last batch), this is not a standing tool.
 */

const db = require('../server/data');
const { getAdapterClass, validateConfig } = require('../server/adapters');

const companies = [
    { name: 'SentinelOne Israel', type: 'greenhouse', config: { boardToken: 'sentinellabs' } },
    { name: 'Island Israel', type: 'greenhouse', config: { boardToken: 'island' } },
    { name: 'Sisense Israel', type: 'ashby', config: { boardName: 'sisense', country: 'Israel' } },
];

let added = 0;
let skipped = 0;

for (const { name, type, config } of companies) {
    if (db.findCompanyByName(name)) {
        console.log(`skip (already watched): ${name}`);
        skipped++;
        continue;
    }

    const AdapterClass = getAdapterClass(type);
    const problems = validateConfig(AdapterClass, config);
    if (problems.length) {
        console.error(`CONFIG PROBLEM for ${name}: ${problems.join('; ')}`);
        process.exitCode = 1;
        continue;
    }

    const id = db.addCompany({ name, careerUrl: '', adapterType: type, config });
    console.log(`added ${name} (id ${id})`);
    added++;
}

console.log(`\nDone: ${added} added, ${skipped} already present.`);
