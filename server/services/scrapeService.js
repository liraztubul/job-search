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
const { evaluateSanityGate } = require('../domain/scrapeSanity');
const { FAILURE_KIND, classifyFailure, shouldGoRed } = require('../domain/scrapeOutcome');

// Three refusals in a row is nine hours (the scrape runs every 3h) of a
// company's data frozen at a number nobody has confirmed is real. See the
// comment on watched_companies.refusal_streak in schema.sql: either the drop
// is real (and evaluateSanityGate's own memory should have accepted it by
// now — see scrapeSanity.js) or something is actually wrong, and both need a
// human, which is what turning this into a `broken` failure gets.
const REFUSAL_ESCALATION_THRESHOLD = 3;

/** Records one failed company: pushes to summary.failures and fires onEvent — the one
 * place that decides `loud`/`acknowledged` from this company's known_issue_kind, so the
 * two call sites below (an adapter throwing, the sanity gate refusing) can't drift apart. */
function recordFailure(summary, onEvent, company, kind, error, extra = {}) {
    const loud = shouldGoRed(kind, company.known_issue_kind);
    summary.failures.push({ company: company.name, error, kind, loud, acknowledged: kind === company.known_issue_kind, ...extra });
    onEvent({ type: 'company:failed', company: company.name, error, kind });
}

/**
 * @param {(event: object) => void} [onEvent] progress callback
 * @returns {Promise<{companies: number, newJobs: number, closedJobs: number, matches: number, failures: object[]}>}
 */
async function runCycle(onEvent = () => {}) {
    const startedAt = new Date().toISOString();
    const companies = data.getActiveCompanies();
    const profiles = data.getActiveProfiles();
    const summary = { companies: companies.length, newJobs: 0, closedJobs: 0, matches: 0, failures: [] };

    for (const company of companies) {
        onEvent({ type: 'company:start', company: company.name });

        let jobs;
        try {
            jobs = await buildAdapter(company).getCurrentJobs();
        } catch (err) {
            // One broken company must never stop the others. See ARCHITECTURE.md
            // §4.3 — blast radius of a site change is one adapter. `classifyFailure`
            // trusts a kind the adapter set at the exact point it understood the
            // failure (server/domain/scrapeOutcome.js) and defaults to `broken` for
            // a plain, unclassified Error — which is the correct default, not a gap.
            recordFailure(summary, onEvent, company, classifyFailure(err), err.message);
            continue;
        }

        onEvent({ type: 'company:fetched', company: company.name, count: jobs.length });

        // Sanity gate (ARCHITECTURE.md §4.2, server/domain/scrapeSanity.js):
        // "the company closed every role" and "the scraper broke" look
        // identical in the data. Existing rows are left untouched when the
        // gate refuses a result, and — critically — closure detection below
        // never runs, so a broken adapter can never mass-close a company's
        // listings. `company.last_refused_count` is what makes the gate's
        // memory work: null unless the PREVIOUS cycle also refused this
        // company, in which case a closely-matching count here means the
        // drop is real, not a fluke — see evaluateSanityGate.
        const openBefore = data.countOpenJobs(company.id);
        const verdict = evaluateSanityGate(openBefore, jobs.length, company.last_refused_count);
        if (!verdict.trusted) {
            const streak = data.recordRefusal(company.id, jobs.length);
            const escalated = streak >= REFUSAL_ESCALATION_THRESHOLD;
            const kind = escalated ? FAILURE_KIND.BROKEN : FAILURE_KIND.REFUSED;
            const reason = escalated
                ? `sanity gate: ${verdict.reason} (refused ${streak} times in a row — treating as broken, not just held back)`
                : `sanity gate: ${verdict.reason}`;
            recordFailure(summary, onEvent, company, kind, reason, { refusalStreak: streak });
            continue;
        }
        // Trusted — either normally, or because the gate's memory just accepted a
        // repeating drop. Either way any past streak is over; a future refusal
        // starts counting from zero rather than inheriting this one.
        if (company.refusal_streak > 0) data.resetRefusalStreak(company.id);

        // One SELECT + a handful of batched writes for the whole company,
        // not two round trips per job — see the comment on
        // upsertJobSnapshots in data/jobs.js for why that distinction only
        // matters once the database is on the far side of a network.
        const seenExternalIds = jobs.map((job) => job.externalId);
        const results = data.upsertJobSnapshots(company.id, jobs);

        for (const job of jobs) {
            const { isNew, id } = results.get(job.externalId);
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

        // Closure detection (ARCHITECTURE.md §4.3): only ever reached after
        // the sanity gate above has passed, on purpose — see the comment there.
        const closedCount = data.closeMissingJobs(company.id, seenExternalIds);
        if (closedCount > 0) {
            summary.closedJobs += closedCount;
            onEvent({ type: 'company:closed', company: company.name, count: closedCount });
        }

        // Set once, at the end of this company's first healthy cycle — see
        // server/domain/jobFreshness.js for what this line is actually for.
        // A no-op on every cycle after the first (data/companies.js only
        // writes it while it's still NULL).
        data.setFirstScrapedAt(company.id, new Date().toISOString());
    }

    // Written unconditionally, success or partial failure — a scrape where
    // three companies failed still refreshed everyone else's data, and the
    // search page's "last updated" needs to reflect that. A cycle that
    // crashes outright (never reaches here) correctly leaves the previous
    // row standing, which is exactly what should happen: nothing was
    // actually refreshed.
    data.recordScrapeRun({
        startedAt,
        finishedAt: new Date().toISOString(),
        companies: summary.companies,
        newJobs: summary.newJobs,
        closedJobs: summary.closedJobs,
        failures: summary.failures,
    });

    return summary;
}

module.exports = { runCycle };
