/**
 * Turns the UI's query string into a repository call.
 *
 * Exists so the mapping from short URL parameter names (`?experience=senior`)
 * to internal filter names lives in one place instead of being spelled out
 * inside a route handler.
 */

const data = require('../data');
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

    // totalMatching has to be known before "page" means anything: page=99999
    // against 8 real pages should land you on the last real page, not on an
    // empty one that looks like "no results" for a filter that actually matches.
    const totalMatching = data.countJobs(userId, filters);
    const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(params.get('pageSize'))) || 20));
    const totalPages = Math.max(1, Math.ceil(totalMatching / pageSize));
    const requestedPage = Math.trunc(Number(params.get('page'))) || 1;
    const page = Math.min(Math.max(1, requestedPage), totalPages);

    const { jobs } = data.queryJobs(userId, { ...filters, page, pageSize });

    return { jobs, page, pageSize, totalMatching, totalPages };
}

/** Everything the filter dropdowns are built from. */
function filterOptions() {
    return { ...data.filterOptions(), statusVocabulary: APPLICATION_STATUSES };
}

module.exports = { searchJobs, filterOptions };
