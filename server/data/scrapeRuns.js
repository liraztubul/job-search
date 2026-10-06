/**
 * One row per completed scrape cycle — see schema.sql for why this is a
 * whole-cycle summary rather than the fuller per-company table
 * docs/ROADMAP.md describes for later. Thin SQL only.
 */

const { db } = require('./connection');

/**
 * @param {{startedAt: string, finishedAt: string, companies: number, newJobs: number,
 *          closedJobs: number, failures: {company: string, error: string}[]}} run
 */
function recordScrapeRun({ startedAt, finishedAt, companies, newJobs, closedJobs, failures }) {
    // NOT strictly idempotent — a replay after a dropped connection that had
    // in fact applied the INSERT leaves two identical rows. Marked retryable
    // anyway, deliberately: the only reader is getLastScrapeRun below, which
    // reads the newest row's finished_at, and a duplicate says exactly the
    // same thing. Losing this row instead is the worse outcome — the whole
    // cycle's data refreshed, but the site would still call it stale.
    db.prepare(
        `INSERT INTO scrape_runs
            (started_at, finished_at, companies, new_jobs, closed_jobs, failures, failure_details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        { idempotent: true }
    ).run(
        startedAt,
        finishedAt,
        companies,
        newJobs,
        closedJobs,
        failures.length,
        failures.length ? JSON.stringify(failures) : null
    );
}

/**
 * The most recent completed cycle, or null if none has ever run — a fresh
 * database (or one where scraping has simply never happened yet) must read as
 * "no data" rather than crash.
 */
function getLastScrapeRun() {
    return db.prepare('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1').get() || null;
}

module.exports = { recordScrapeRun, getLastScrapeRun };
