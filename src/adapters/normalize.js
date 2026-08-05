/**
 * Shared vocabularies for the fields the UI filters on.
 *
 * Every site spells these differently: Mobileye says "Full time", Amazon says
 * "full-time", Google grades experience as "Early / Mid / Advanced". If each
 * adapter stores its own wording, the filter dropdown ends up with six entries
 * that all mean the same thing and none of them select what you expect.
 *
 * So adapters translate into these two closed vocabularies at the boundary.
 * Same idea as RawJob itself: normalize once, on the way in.
 *
 * NOTE: not named *Adapter.js, so the registry ignores this file.
 */

const EMPLOYMENT_TYPES = ['full-time', 'part-time', 'contract', 'temporary', 'internship'];
const EXPERIENCE_LEVELS = ['intern', 'entry', 'mid', 'senior'];

/**
 * 'Full time' -> 'full-time', 'Contractor' -> 'contract'
 * @returns {string|null} one of EMPLOYMENT_TYPES, or null when unknown
 */
function normalizeEmploymentType(raw) {
    if (!raw) return null;
    const s = String(raw).toLowerCase().replace(/[\s_]+/g, '-');

    // Order matters: "temporary full-time" is temporary, not full-time.
    if (/intern(ship)?|student|co-?op/.test(s)) return 'internship';
    if (/temp|seasonal/.test(s)) return 'temporary';
    if (/contract|freelance|consultant/.test(s)) return 'contract';
    if (/part-?time/.test(s)) return 'part-time';
    if (/full-?time|permanent|regular/.test(s)) return 'full-time';
    return null;
}

/**
 * Google's 'Early' -> 'entry', 'Advanced' -> 'senior'.
 * Also handles free-text titles like 'Senior Backend Engineer'.
 * @returns {string|null} one of EXPERIENCE_LEVELS, or null when unknown
 */
function normalizeExperienceLevel(raw) {
    if (!raw) return null;
    const s = String(raw).toLowerCase();

    if (/intern(ship)?\b|student|trainee|co-?op/.test(s)) return 'intern';
    if (/principal|staff|senior|advanced|lead|manager|director|expert/.test(s)) return 'senior';
    if (/junior|entry|early|graduate|associate|\bnew grad\b/.test(s)) return 'entry';
    if (/\bmid\b|intermediate|experienced/.test(s)) return 'mid';
    return null;
}

/**
 * Last resort: guess seniority from the job title when the site doesn't say.
 * Kept separate from normalizeExperienceLevel so it's obvious at the call site
 * that this one is a guess, not data the source gave us.
 */
function guessExperienceFromTitle(title) {
    return normalizeExperienceLevel(title);
}

module.exports = {
    EMPLOYMENT_TYPES,
    EXPERIENCE_LEVELS,
    normalizeEmploymentType,
    normalizeExperienceLevel,
    guessExperienceFromTitle,
};
