/**
 * Simple keyword + location match (upgrade path: embeddings/cosine similarity later).
 * @param {{title:string, location:string}} job
 * @param {{keywords:string, location_filter:string|null}} profile
 */
function matches(job, profile) {
    const keywords = profile.keywords.split(',').map((k) => k.trim().toLowerCase());
    const titleLower = job.title.toLowerCase();
    const keywordHit = keywords.some((k) => titleLower.includes(k));

    if (!keywordHit) return false;

    if (profile.location_filter) {
        const locOk = job.location.toLowerCase().includes(profile.location_filter.toLowerCase());
        if (!locOk) return false;
    }

    return true;
}

module.exports = { matches };
