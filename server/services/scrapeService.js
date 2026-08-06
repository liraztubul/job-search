/**
 * One check cycle: for every watched company, fetch what's posted now, store
 * what's new, and note which saved profiles it matches.
 *
 * The cycle is here rather than in main.js so it can be called from anywhere —
 * a scheduler, a test, or eventually a "scrape now" button — instead of only by
 * running a script.
 *
 * Reporting is returned, not printed. Whoever calls this decides how to show it.
 */

const data = require('../data');
const { matches } = require('../domain/matcher');
const { buildAdapter } = require('../adapters');

/**
 * @param {(event: object) => void} [onEvent] progress callback
 * @returns {Promise<{companies: number, newJobs: number, matches: number, failures: object[]}>}
 */
async function runCycle(onEvent = () => {}) {
    const companies = data.getActiveCompanies();
    const profiles = data.getActiveProfiles();
    const summary = { companies: companies.length, newJobs: 0, matches: 0, failures: [] };

    for (const company of companies) {
        onEvent({ type: 'company:start', company: company.name });

        let jobs;
        try {
            jobs = await buildAdapter(company).getCurrentJobs();
        } catch (err) {
            // One broken company must never stop the others. See ARCHITECTURE.md
            // §4.3 — blast radius of a site change is one adapter.
            summary.failures.push({ company: company.name, error: err.message });
            onEvent({ type: 'company:failed', company: company.name, error: err.message });
            continue;
        }

        onEvent({ type: 'company:fetched', company: company.name, count: jobs.length });

        for (const job of jobs) {
            const { isNew, id } = data.upsertJobSnapshot(company.id, job);
            if (!isNew) continue;

            summary.newJobs++;
            onEvent({ type: 'job:new', company: company.name, title: job.title, location: job.location });

            for (const profile of profiles) {
                if (!matches(job, profile) || data.wasNotified(id, profile.id)) continue;

                summary.matches++;
                onEvent({ type: 'job:matched', profile: profile.name, title: job.title, url: job.applyUrl });

                // Recorded, not sent. The queue-and-drain design is in
                // ARCHITECTURE.md §4.5; until a sender exists this is console-only.
                data.recordNotification(id, profile.id);
            }
        }
    }

    return summary;
}

module.exports = { runCycle };
