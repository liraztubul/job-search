/**
 * Turns the UI's query string into a repository call.
 *
 * Exists so the mapping from short URL parameter names (`?experience=senior`)
 * to internal filter names lives in one place instead of being spelled out
 * inside a route handler.
 */

const data = require('../data');
const { APPLICATION_STATUSES } = require('../domain/applicationStatus');

/** @param {URLSearchParams} params */
function searchJobs(params) {
    return data.queryJobs({
        companyId: params.get('company') || null,
        employmentType: params.get('employment') || null,
        experienceLevel: params.get('experience') || null,
        location: params.get('location') || null,
        q: params.get('q') || null,
        status: params.get('status') || null,
        openOnly: params.get('open') === '1',
        sort: params.get('sort') || null,
        limit: params.get('limit') || null,
    });
}

/** Everything the filter dropdowns are built from. */
function filterOptions() {
    return { ...data.filterOptions(), statusVocabulary: APPLICATION_STATUSES };
}

module.exports = { searchJobs, filterOptions };
