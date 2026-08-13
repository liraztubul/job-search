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
        openOnly: params.get('open') === '1',
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

    return { jobs, page, pageSize, totalMatching, totalPages };
}

/** Everything the filter dropdowns are built from. */
function filterOptions() {
    return { ...data.filterOptions(), statusVocabulary: APPLICATION_STATUSES };
}

// Re-exported so `web/` can name a logged-out caller without importing from
// `data/` directly — the dependency arrow only ever points web -> services -> data.
module.exports = { searchJobs, filterOptions, GUEST };
