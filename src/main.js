const db = require('./db');
const { matches } = require('./matcher');
const { ComeetAdapter } = require('./adapters/comeetAdapter');

function buildAdapter(company) {
    const config = company.adapter_config ? JSON.parse(company.adapter_config) : {};
    switch (company.adapter_type) {
        case 'comeet':
            return new ComeetAdapter(config);
        // case 'greenhouse': return new GreenhouseAdapter(config);
        // case 'custom_elbit': return new ElbitAdapter(config);
        default:
            throw new Error(`Unknown adapter_type: ${company.adapter_type}`);
    }
}

async function runCycle() {
    const companies = db.getActiveCompanies();
    const profiles = db.getActiveProfiles();

    if (companies.length === 0) {
        console.log('No watched companies yet — add one to watched_companies first.');
        return;
    }

    for (const company of companies) {
        console.log(`Checking ${company.name}...`);
        let jobs;
        try {
            const adapter = buildAdapter(company);
            jobs = await adapter.getCurrentJobs();
        } catch (err) {
            console.error(`  Failed to fetch ${company.name}: ${err.message}`);
            continue;
        }

        for (const job of jobs) {
            const { isNew, id } = db.upsertJobSnapshot(company.id, job);
            if (!isNew) continue;

            console.log(`  NEW JOB: ${job.title} (${job.location})`);
            for (const profile of profiles) {
                if (matches(job, profile) && !db.wasNotified(id, profile.id)) {
                    console.log(`    -> matches profile "${profile.name}": ${job.applyUrl}`);
                    db.recordNotification(id, profile.id);
                    // TODO: replace with real notification (Telegram bot / email)
                }
            }
        }
    }
}

runCycle().then(() => process.exit(0));
