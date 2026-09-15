/** Splits a comma-separated filter value into lowercased, trimmed, non-empty parts. */
function splitFilter(value) {
    return String(value || '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
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
 * @param {{title:string, location:string, experience_level?:string|null, employment_type?:string|null}} job
 * @param {{keywords:string, location_filter?:string|null, experience_filter?:string|null, employment_filter?:string|null}} profile
 */
function matches(job, profile) {
    const keywords = splitFilter(profile.keywords);
    const titleLower = String(job.title || '').toLowerCase();
    const keywordHit = keywords.some((k) => titleLower.includes(k));

    if (!keywordHit) return false;

    if (profile.location_filter) {
        const locations = splitFilter(profile.location_filter);
        const jobLocation = String(job.location || '').toLowerCase();
        const locOk = locations.some((loc) => jobLocation.includes(loc));
        if (!locOk) return false;
    }

    if (profile.experience_filter) {
        const levels = splitFilter(profile.experience_filter);
        const jobLevel = String(job.experience_level || '').toLowerCase();
        if (!levels.includes(jobLevel)) return false;
    }

    if (profile.employment_filter) {
        const types = splitFilter(profile.employment_filter);
        const jobType = String(job.employment_type || '').toLowerCase();
        if (!types.includes(jobType)) return false;
    }

    return true;
}

module.exports = { matches };
