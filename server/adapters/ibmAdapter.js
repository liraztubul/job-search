const { JobSource } = require('./JobSource');
const { decodeEntities } = require('./htmlUtils');
const { normalizeEmploymentType, normalizeExperienceLevel, guessExperienceFromTitle } = require('../domain/vocabulary');
const { ScrapeError, classifyHttpStatus, parseJsonResponse } = require('../domain/scrapeOutcome');

/**
 * IBM's careers site (careers.ibm.com, searched from www.ibm.com/careers/search)
 * is a bare Elasticsearch index behind https://www-api.ibm.com/search/api/v2.
 * There is no public documentation for it — this was reverse-engineered from
 * the site's own POST request on 2026-08-06 (`node tools/sniff.js ibm`).
 *
 * The site's own `?location=Israel` query-string param does nothing; it's
 * decorative. The real filter is a `term` query against `field_keyword_05`,
 * which holds the plain country name ("India", "Israel", ...) — confirmed by
 * matching the "India" facet count (714) exactly. As of this writing IBM
 * genuinely has zero requisitions tagged Israel (title/description text
 * search for "Israel"/"Haifa"/"Tel Aviv" also returns zero) — verified the
 * filter mechanism works, not just guessed at an empty result. See
 * ARCHITECTURE.md §4.2 / CLAUDE.md: an empty result here is real, not broken.
 *
 * field_keyword_08 = department, field_keyword_18 = career track (Professional
 * / Entry Level / Internship), field_keyword_19 = "City, ISO2".
 */

const SEARCH_URL = 'https://www-api.ibm.com/search/api/v2';
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // bounded so a pagination bug can't loop forever

const SOURCE_FIELDS = ['_id', 'title', 'url', 'field_keyword_05', 'field_keyword_08', 'field_keyword_18', 'field_keyword_19'];

/** Pure mapping: one IBM search hit -> RawJob. */
function mapIbmJob(hit) {
    const src = hit._source || {};

    // The requisition id lives in the apply URL's query string; the ES _id is
    // an opaque hash that changes if the document gets reindexed, so prefer
    // the number a human (and the site itself) actually treats as the job id.
    const fromUrl = /[?&]jobId=(\d+)/.exec(src.url || '');
    const externalId = fromUrl ? fromUrl[1] : String(hit._id || '');
    if (!externalId) {
        throw new Error(`IBM search hit has no usable id: ${JSON.stringify(hit).slice(0, 120)}`);
    }

    const title = decodeEntities(src.title || '');
    const track = src.field_keyword_18 || null;

    return {
        externalId,
        title,
        location: src.field_keyword_19 || '',
        applyUrl: src.url || `https://careers.ibm.com/careers/JobDetail?jobId=${externalId}`,
        department: src.field_keyword_08 || null,
        employmentType: normalizeEmploymentType(track),
        experienceLevel: normalizeExperienceLevel(track) || guessExperienceFromTitle(title),
        postedAt: null,
    };
}

class IbmAdapter extends JobSource {
    static type = 'ibm';
    static describe = {
        help: 'IBM careers (careers.ibm.com), the Elasticsearch API behind it. Verified 2026-08-06.',
        required: {},
        optional: { country: "country name exactly as IBM spells it, e.g. 'Israel'. Omit for worldwide." },
    };

    constructor(config = {}) {
        super();
        this.country = config.country || 'Israel';
    }

    buildBody(from) {
        return {
            appId: 'careers',
            scopes: ['careers2'],
            query: this.country
                ? { bool: { must: [{ term: { field_keyword_05: this.country } }] } }
                : { bool: { must: [] } },
            size: PAGE_SIZE,
            from,
            sort: [{ _score: 'desc' }],
            lang: 'zz',
            _source: SOURCE_FIELDS,
        };
    }

    async fetchPage(from) {
        const res = await fetch(SEARCH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.buildBody(from)),
        });
        if (!res.ok) {
            throw new ScrapeError(`IBM search failed: ${res.status} ${res.statusText}`, classifyHttpStatus(res.status));
        }

        const data = await parseJsonResponse(res, 'IBM');
        if (!Array.isArray(data?.hits?.hits)) {
            throw new Error(
                `IBM search response shape changed: expected hits.hits to be an array, got ${typeof data?.hits?.hits}`
            );
        }
        return data.hits;
    }

    async getCurrentJobs() {
        const jobs = [];
        let from = 0;
        let total = null;

        for (let page = 0; page < MAX_PAGES; page++) {
            const hits = await this.fetchPage(from);
            if (total === null) total = Number(hits.total?.value) || 0;

            if (hits.hits.length === 0) break;
            jobs.push(...hits.hits.map(mapIbmJob));

            from += hits.hits.length;
            if (from >= total) break;
        }

        return jobs;
    }
}

module.exports = { IbmAdapter, mapIbmJob };
