/** Splits a comma-separated filter value into lowercased, trimmed, non-empty parts. */
function splitFilter(value) {
    return String(value || '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
}

/** A job's value for a filtered field couldn't be determined at scrape time —
 *  server/domain/vocabulary.js writes null rather than guess. */
function isUnknownValue(value) {
    return value == null || String(value).trim() === '';
}

/**
 * Simple keyword + location + experience + employment-type match (upgrade
 * path: embeddings/cosine similarity later).
 *
 * `location_filter`, `experience_filter` and `employment_filter` are each
 * comma-separated, same shape as `keywords` — the browser's multi-select
 * checkboxes (or single-select dropdowns) for any of them write a joined
 * list, and a job matches if it fits ANY of them (OR), not all.
 *
 * UNKNOWN-VALUE POLICY — deliberate, measured, not an accident of `|| ''`:
 * a job whose value for a filtered field is unknown (null/empty — see
 * isUnknownValue) always PASSES that filter, rather than being excluded.
 *
 * Measured against the real database (2026-09-15, 2,277 open jobs):
 * experience_level is unknown on 42.7% of jobs, spread across nearly every
 * adapter (23%-73%, not one broken source); employment_type is unknown on
 * 82.6%, with most platforms never publishing it at all; location is unknown
 * on only 0.4%. Excluding unknowns would make an experience/employment
 * filter hide far more jobs than it filters — someone filtering to "student"
 * roles would also silently lose every job nobody could grade at all, which
 * reads as "there's nothing for me," not as a working filter. location is
 * rare enough that either choice is nearly free there; it follows the same
 * rule rather than being a field-by-field special case.
 *
 * tests/matcher.test.js's "unknown values" tests pin this so a future change
 * can't flip it without a failing test to explain why.
 *
 * @param {{title:string, location:string, experience_level?:string|null, employment_type?:string|null}} job
 * @param {{keywords:string, location_filter?:string|null, experience_filter?:string|null, employment_filter?:string|null}} profile
 */
function matches(job, profile) {
    const keywords = splitFilter(profile.keywords);
    const titleLower = String(job.title || '').toLowerCase();
    const keywordHit = keywords.some((k) => titleLower.includes(k));

    if (!keywordHit) return false;

    if (profile.location_filter && !isUnknownValue(job.location)) {
        const locations = splitFilter(profile.location_filter);
        const jobLocation = String(job.location).toLowerCase();
        if (!locations.some((loc) => jobLocation.includes(loc))) return false;
    }

    if (profile.experience_filter && !isUnknownValue(job.experience_level)) {
        const levels = splitFilter(profile.experience_filter);
        if (!levels.includes(String(job.experience_level).toLowerCase())) return false;
    }

    if (profile.employment_filter && !isUnknownValue(job.employment_type)) {
        const types = splitFilter(profile.employment_filter);
        if (!types.includes(String(job.employment_type).toLowerCase())) return false;
    }

    return true;
}

module.exports = { matches, isUnknownValue };
