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
const { isStale } = require('../domain/scrapeFreshness');
const { primaryCanonicalLocation } = require('../domain/locations');

/**
 * The employment-type and experience-level filters exact-match a column that
 * most jobs don't have a value for (measured against the real database: 77.5%
 * unknown for employment type, 42.7% for experience level — see docs/
 * ROADMAP.md). Silently excluding them would make selecting a filter drop
 * the vast majority of the database with no way to tell why. Chosen answer:
 * KEEP excluding (the filter still means "only jobs confirmed to be this"),
 * but tell the user how many more jobs simply don't say — see `*Gap` below,
 * rendered by client/js/search.js. This is a different call from matcher.js's
 * (unknown always passes) because this is a deliberate, visible, interactive
 * click on a results list, not a background "is this worth telling someone
 * about" computation — a filter that visibly does nothing (option (a) here
 * would drop 2,274 results to ~2,244) reads as broken just as easily as one
 * that silently hides too much.
 *
 * @param {number|typeof GUEST} userId
 * @param {object} filters - already has `field` itself cleared by the caller
 * @param {'employmentType'|'experienceLevel'} field
 */
function unknownGap(userId, filters, field) {
    return {
        totalWithoutFilter: data.countJobs(userId, filters),
        unknownCount: data.countUnknownForField(userId, filters, field),
    };
}

/**
 * @param {number} userId
 * @param {URLSearchParams} params
 * @returns {{jobs: object[], page: number, pageSize: number, totalMatching: number, totalPages: number}}
 */
function searchJobs(userId, params) {
    // "רק היי-טק" (docs/ROADMAP.md) — ON by default; only an explicit
    // ?tech=0 (the "הצג את כל המשרות" toggle) turns it off. Absent means on,
    // which is what makes it a real default rather than something a caller
    // has to opt into.
    const techOnly = params.get('tech') !== '0';

    const filters = {
        companyId: params.get('company') || null,
        employmentType: params.get('employment') || null,
        experienceLevel: params.get('experience') || null,
        // Repeatable: ?location=Tel+Aviv&location=Haifa — a multi-select filter.
        locations: params.getAll('location').filter(Boolean),
        q: params.get('q') || null,
        status: params.get('status') || null,
        sort: params.get('sort') || null,
        techOnly,
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
    // companyFirstScrapedAt was only ever needed to compute that, and
    // companyRecency only exists to drive the SQL ORDER BY (see queryJobs) —
    // both are implementation details of how the list was built, not part of
    // the job's own shape, so neither rides along into the response.
    //
    // locationCanonical rides along too: the one canonical city/region
    // domain/locations.js resolves the raw location to, or null. The client
    // looks that up in its own Hebrew label map instead of trying to parse
    // the raw string itself — one resolver, one source of truth (see
    // primaryCanonicalLocation's own comment).
    const jobsWithFreshness = jobs.map(({ companyFirstScrapedAt, companyRecency, ...job }) => ({
        ...job,
        ...computeFreshness(job, companyFirstScrapedAt),
        locationCanonical: primaryCanonicalLocation(job.location),
    }));

    const result = { jobs: jobsWithFreshness, page, pageSize, totalMatching, totalPages, techOnly };

    // A default-on filter that stays quiet is the same bug as the
    // employment/experience gap above, in a new costume — the header must
    // always be able to say what it's doing, not just when a filter happens
    // to be off the default. totalWithoutTechFilter is what lets the client
    // say "X מתוך Y" while the filter is on.
    if (techOnly) result.totalWithoutTechFilter = data.countJobs(userId, { ...filters, techOnly: false });

    // Only computed when that filter is actually active — two more queries
    // on every request would be waste for the common case of no filter set.
    if (filters.employmentType) result.employmentGap = unknownGap(userId, { ...filters, employmentType: null }, 'employmentType');
    if (filters.experienceLevel) result.experienceGap = unknownGap(userId, { ...filters, experienceLevel: null }, 'experienceLevel');

    return result;
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
    const lastRun = data.getLastScrapeRun();
    const lastScrapeAt = lastRun?.finished_at ?? null;

    return {
        ...data.filterOptions(userId),
        statusVocabulary: APPLICATION_STATUSES,
        // Null (never scraped) reads as stale too — see domain/scrapeFreshness.js.
        lastScrapeAt,
        scrapeStale: isStale(lastScrapeAt),
    };
}

// Re-exported so `web/` can name a logged-out caller without importing from
// `data/` directly — the dependency arrow only ever points web -> services -> data.
module.exports = { searchJobs, filterOptions, GUEST };
