/**
 * "Is the job list stale?" — one pure function, so the rule that decides
 * when to warn a visitor the data might be old is testable without a
 * database, a scheduler, or a clock to wait on.
 *
 * WHY 24 HOURS
 *
 * The scrape runs every 3 hours (.github/workflows/scrape.yml) — eight runs a
 * day. A single missed run — GitHub delaying a scheduled job, one bad deploy
 * — is normal and not worth alarming anyone about. Going a full 24 hours
 * without one (eight missed runs in a row) is the signal something is
 * actually broken: the workflow disabled itself (GitHub turns off a schedule
 * with no repository activity for 60 days), the repository secrets went
 * missing, or the process is failing outright.
 */

const STALE_THRESHOLD_HOURS = 24;
const STALE_THRESHOLD_MS = STALE_THRESHOLD_HOURS * 60 * 60 * 1000;

/**
 * @param {string|null} lastScrapeAt ISO timestamp of the most recent scrape
 *   run's finish, or null when none has ever completed.
 * @param {Date} [now] injectable for tests
 * @returns {boolean} true when the data should be shown as possibly stale —
 *   including when no scrape has ever run at all.
 */
function isStale(lastScrapeAt, now = new Date()) {
    if (!lastScrapeAt) return true;
    const lastScrapeMs = new Date(lastScrapeAt).getTime();
    if (Number.isNaN(lastScrapeMs)) return true;
    return now.getTime() - lastScrapeMs > STALE_THRESHOLD_MS;
}

module.exports = { isStale, STALE_THRESHOLD_HOURS, STALE_THRESHOLD_MS };
