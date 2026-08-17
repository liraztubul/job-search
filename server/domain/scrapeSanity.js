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
 * @param {number} openBefore   how many jobs were believed open before this cycle
 * @param {number} returnedCount   how many jobs this cycle's fetch returned
 * @returns {{trusted: true} | {trusted: false, reason: string}}
 */
function evaluateSanityGate(openBefore, returnedCount) {
    if (openBefore <= 0) return { trusted: true };

    if (returnedCount === 0) {
        return { trusted: false, reason: `returned 0 jobs, had ${openBefore} open before` };
    }
    if (returnedCount < openBefore * SANITY_DROP_RATIO) {
        return { trusted: false, reason: `returned ${returnedCount} job(s), had ${openBefore} open before (over 50% drop)` };
    }
    return { trusted: true };
}

module.exports = { evaluateSanityGate, SANITY_DROP_RATIO };
