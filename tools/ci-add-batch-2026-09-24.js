/**
 * ci-add-batch-2026-09-24.js — one-off: add the 30 companies from
 * FINISH-PROMPT.md Part 1, directly against whatever database
 * server/data/connection.js resolves (Turso when TURSO_DATABASE_URL /
 * TURSO_AUTH_TOKEN are set, which is how the CI workflow that runs this
 * invokes it).
 *
 * Idempotent: skips a company that's already watched instead of crashing,
 * so a partial or re-run is safe. Delete this file and the workflow that
 * calls it once the push is confirmed live — this is not a standing tool,
 * add-company.js already is.
 *
 * Orca Security and Salt Security get an explicit `location: "Tel Aviv"`
 * instead of the greenhouse adapter's auto-detect fallback: both have a job
 * whose office is literally the bare word "Central" (Singapore's business
 * district; a US sales territory), which collides with locations.js's
 * generic Center-region pattern for Israel and would otherwise be pulled in
 * as a false-positive Israeli job. Confirmed against the live Greenhouse
 * API before writing this — see the chat transcript / commit message.
 */

const db = require('../server/data');
const { getAdapterClass, validateConfig } = require('../server/adapters');

const companies = [
    { name: 'Cato Networks Israel', type: 'greenhouse', config: { boardToken: 'catonetworks' } },
    { name: 'JFrog Israel', type: 'greenhouse', config: { boardToken: 'jfrog' } },
    { name: 'Gong Israel', type: 'greenhouse', config: { boardToken: 'gongio' } },
    { name: 'Via Israel', type: 'greenhouse', config: { boardToken: 'via' } },
    { name: 'Transmit Security Israel', type: 'greenhouse', config: { boardToken: 'transmitsecurity' } },
    { name: 'Fireblocks Israel', type: 'greenhouse', config: { boardToken: 'fireblocks' } },
    { name: 'Axonius Israel', type: 'greenhouse', config: { boardToken: 'axonius' } },
    { name: 'Forter Israel', type: 'greenhouse', config: { boardToken: 'forter' } },
    { name: 'Tipalti Israel', type: 'greenhouse', config: { boardToken: 'tipaltisolutions' } },
    { name: 'Armis Israel', type: 'greenhouse', config: { boardToken: 'armissecurity' } },
    // Explicit location: see file header — the auto-detect fallback pulls in
    // a Singapore job because its office name is the bare word "Central".
    { name: 'Orca Security Israel', type: 'greenhouse', config: { boardToken: 'orcasecurity', location: 'Tel Aviv' } },
    { name: 'Descope Israel', type: 'greenhouse', config: { boardToken: 'descope' } },
    { name: 'BigID Israel', type: 'greenhouse', config: { boardToken: 'bigid' } },
    { name: 'Torq Israel', type: 'greenhouse', config: { boardToken: 'torq' } },
    // Explicit location: see file header — a US sales-territory job named
    // literally "Central" would otherwise false-match.
    { name: 'Salt Security Israel', type: 'greenhouse', config: { boardToken: 'saltsecurity', location: 'Tel Aviv' } },
    { name: 'Sweet Security Israel', type: 'greenhouse', config: { boardToken: 'sweetsecurity' } },
    { name: 'Innovid Israel', type: 'greenhouse', config: { boardToken: 'innovid' } },
    { name: 'Lightrun Israel', type: 'greenhouse', config: { boardToken: 'lightrun' } },
    { name: 'Cymulate Israel', type: 'greenhouse', config: { boardToken: 'cymulate' } },
    { name: 'SafeBreach Israel', type: 'greenhouse', config: { boardToken: 'safebreach' } },
    { name: 'Apiiro Israel', type: 'greenhouse', config: { boardToken: 'apiiro' } },
    { name: 'Guardz Israel', type: 'greenhouse', config: { boardToken: 'guardz' } },
    { name: 'Capitolis Israel', type: 'greenhouse', config: { boardToken: 'capitolis' } },
    { name: 'DataRails Israel', type: 'greenhouse', config: { boardToken: 'datarails' } },
    { name: 'Torii Israel', type: 'greenhouse', config: { boardToken: 'toriihq' } },
    { name: 'Hello Heart Israel', type: 'greenhouse', config: { boardToken: 'helloheart' } },
    { name: 'Lemonade Israel', type: 'ashby', config: { boardName: 'lemonade', country: 'Israel' } },
    { name: 'Moon Active Israel', type: 'ashby', config: { boardName: 'moonactive', country: 'Israel' } },
    { name: 'HoneyBook Israel', type: 'ashby', config: { boardName: 'honeybook', country: 'Israel' } },
    { name: 'Unit Israel', type: 'ashby', config: { boardName: 'unit', country: 'Israel' } },
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
