/**
 * Turns the UI's query string into a repository call.
 *
 * Exists so the mapping from short URL parameter names (`?experience=senior`)
 * to internal filter names lives in one place instead of being spelled out
 * inside a route handler.
 */

const data = require('../data');
const { GUEST } = require('../data/tenancy');
const { APPLICATION_STATUSES } = require('../domain/applicationStatus');
const { computeFreshness } = require('../domain/jobFreshness');

/**
 * @param {number} userId
 * @param {URLSearchParams} params
 * @returns {{jobs: object[], page: number, pageSize: number, totalMatching: number, totalPages: number}}
 */
function searchJobs(userId, params) {
    const filters = {
        companyId: params.get('company') || null,
        employmentType: params.get('employment') || null,
        experienceLevel: params.get('experience') || null,
        // Repeatable: ?location=Tel+Aviv&location=Haifa — a multi-select filter.
        locations: params.getAll('location').filter(Boolean),
        q: params.get('q') || null,
        status: params.get('status') || null,
        sort: params.get('sort') || null,
    };

    const totalMatching = data.countJobs(userId, filters);
    const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(params.get('pageSize'))) || 20));
    const totalPages = Math.max(1, Math.ceil(totalMatching / pageSize));
    // Sanitized (a real positive integer), never substituted: page=99999 against
    // 8 real pages is answered honestly — jobs: [] — not by silently swapping in
    // page 8's rows for a page nobody asked for. totalPages is right there in
    // the response for a caller that wants to react to being out of range.
    const page = Math.max(1, Math.trunc(Number(params.get('page'))) || 1);

    const { jobs } = data.queryJobs(userId, { ...filters, page, pageSize });

    // displayDate/dateSource/isNew computed once, here, so the client never
    // reimplements "how new is this job" — see domain/jobFreshness.js.
    // companyFirstScrapedAt was only ever needed to compute that; it's an
    // implementation detail of the freshness rule, not part of the job's
    // own shape, so it doesn't ride along into the response.
    const jobsWithFreshness = jobs.map(({ companyFirstScrapedAt, ...job }) => ({
        ...job,
        ...computeFreshness(job, companyFirstScrapedAt),
    }));

    return { jobs: jobsWithFreshness, page, pageSize, totalMatching, totalPages };
}

/**
 * Everything the filter dropdowns are built from.
 * @param {number|typeof GUEST} userId
 */
function filterOptions(userId) {
    // statusVocabulary is the fixed enum of possible statuses (saved/applied/
    // interviewing/offer/rejected) — not personal data, always included.
    // `statuses` (the per-account counts) is data.filterOptions()'s call to
    // make, and it's the one that's actually scoped or omitted based on userId.
    return { ...data.filterOptions(userId), statusVocabulary: APPLICATION_STATUSES };
}

// Re-exported so `web/` can name a logged-out caller without importing from
// `data/` directly — the dependency arrow only ever points web -> services -> data.
module.exports = { searchJobs, filterOptions, GUEST };
