/**
 * The sanity gate (docs/ARCHITECTURE.md §4.2): "the company closed every
 * role" and "the scraper broke" produce the exact same shape of result — a
 * job list far smaller than before. This is the rule that decides which one
 * to believe, kept as a pure function so the decision itself is testable
 * without spinning up a scrape cycle.
 *
 * A company with no prior open jobs is always trusted, regardless of what
 * this cycle returns — there's nothing to have dropped from. That's
 * deliberate: it's what lets a brand-new company's first cycle (and a
 * company that's genuinely and legitimately been at zero) through without
 * special-casing "is this the first run" separately. Same bootstrap
 * reasoning as ADR-005.
 */

const SANITY_DROP_RATIO = 0.5;

/**
 * How close two counts have to be to count as "the same result, reported
 * twice" rather than two unrelated numbers that both happen to be low. A
 * transient failure — a timeout, a half-loaded page — essentially never
 * reproduces the exact same count three hours later; a real reduction does.
 */
const CLOSE_MATCH_TOLERANCE = 0.1;

function closelyMatches(a, b) {
    return a === b || Math.abs(a - b) <= Math.max(a, b) * CLOSE_MATCH_TOLERANCE;
}

/**
 * @param {number} openBefore   how many jobs were believed open before this cycle
 * @param {number} returnedCount   how many jobs this cycle's fetch returned
 * @param {number|null} [previousRefusedCount]   what the LAST cycle's fetch
 *   returned, if the gate refused it too (server/data/companies.js's
 *   recordRefusal/resetRefusalStreak track this per company) — null the
 *   first time, or once a cycle has been trusted since. Without memory the
 *   gate refuses a genuine, lasting drop forever; with it, a drop that
 *   reproduces closely on the very next cycle is accepted as reality rather
 *   than assumed broken — see docs/ARCHITECTURE.md and CLAUDE.md's notes on
 *   this gate for why "the scraper broke" and "the company actually shrank"
 *   must never be told apart by a hardcoded threshold alone.
 * @returns {{trusted: true} | {trusted: false, reason: string}}
 */
function evaluateSanityGate(openBefore, returnedCount, previousRefusedCount = null) {
    if (openBefore <= 0) return { trusted: true };

    const isDrop = returnedCount === 0 || returnedCount < openBefore * SANITY_DROP_RATIO;
    if (!isDrop) return { trusted: true };

    if (previousRefusedCount != null && closelyMatches(returnedCount, previousRefusedCount)) {
        return { trusted: true };
    }

    const reason =
        returnedCount === 0
            ? `returned 0 jobs, had ${openBefore} open before`
            : `returned ${returnedCount} job(s), had ${openBefore} open before (over 50% drop)`;
    return { trusted: false, reason };
}

module.exports = { evaluateSanityGate, SANITY_DROP_RATIO, CLOSE_MATCH_TOLERANCE, closelyMatches };
