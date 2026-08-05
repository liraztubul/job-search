const { JobSource } = require('./JobSource');
const { normalizeEmploymentType, normalizeExperienceLevel, guessExperienceFromTitle } = require('./normalize');

/**
 * Amazon (including AWS and Annapurna Labs) exposes the same JSON endpoint its
 * own careers page calls: https://www.amazon.jobs/search.json
 *
 * The field names below were read off a REAL response on 2026-08-03, not off
 * documentation. See tests/amazonAdapter.test.js for the captured payload.
 */

const BASE = 'https://www.amazon.jobs';
const PAGE_SIZE = 100; // the endpoint caps result_limit around here
const MAX_PAGES = 10;  // safety net so a bad response can't loop forever

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json',
};

/**
 * Pure mapping: one raw Amazon job -> one RawJob. Exported separately so it can
 * be tested without touching the network.
 * @returns {{externalId:string,title:string,location:string,applyUrl:string,postedAt:string|null}}
 */
function mapAmazonJob(raw) {
    // id_icims is the requisition number that also appears in the job URL, and
    // it survives edits to the posting. `id` is a uuid that we don't control;
    // prefer the requisition number, fall back to the uuid.
    const externalId = String(raw.id_icims || raw.id || '');
    if (!externalId) {
        throw new Error(`Amazon job has no usable id: ${JSON.stringify(raw).slice(0, 120)}`);
    }

    // Amazon flags interns explicitly; otherwise the title is the only signal.
    const experienceLevel = raw.is_intern
        ? 'intern'
        : normalizeExperienceLevel(raw.job_family) || guessExperienceFromTitle(raw.title);

    return {
        externalId,
        title: raw.title || '',
        // normalized_location reads "Haifa, Haifa, ISR"; `location` reads
        // "IL, Haifa". The normalized one contains the plain city name, which is
        // what a profile's location_filter is written against.
        location: raw.normalized_location || raw.location || raw.city || '',
        applyUrl: raw.job_path ? `${BASE}${raw.job_path}` : `${BASE}/en/jobs/${externalId}`,
        postedAt: raw.posted_date || null,
        employmentType: normalizeEmploymentType(raw.job_schedule_type),
        experienceLevel,
        department: raw.job_category || raw.job_family || null,
    };
}

class AmazonAdapter extends JobSource {
    // Declared here, not in a switch somewhere else. The registry reads these.
    static type = 'amazon';
    static describe = {
        help: 'Amazon, AWS and Annapurna Labs. Verified against a live response.',
        required: { country: "ISO3 country code, e.g. 'ISR'" },
        optional: { query: 'keyword pre-filter applied server-side' },
    };

    /**
     * @param {{ country?: string, query?: string }} config
     *   country — ISO3 code, e.g. 'ISR'. query — optional keyword pre-filter.
     */
    constructor(config = {}) {
        super();
        this.country = config.country || 'ISR';
        this.query = config.query || '';
    }

    buildUrl(offset) {
        const params = new URLSearchParams({
            country: this.country,
            result_limit: String(PAGE_SIZE),
            offset: String(offset),
            sort: 'recent',
        });
        if (this.query) params.set('base_query', this.query);
        return `${BASE}/search.json?${params}`;
    }

    async fetchPage(offset) {
        const res = await fetch(this.buildUrl(offset), { headers: HEADERS });
        if (!res.ok) {
            throw new Error(`Amazon fetch failed: ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        // A shape change must be loud. Silently returning [] here is exactly how
        // the diff would conclude "every job closed". See ARCHITECTURE.md §4.2.
        if (!Array.isArray(data.jobs)) {
            throw new Error(
                `Amazon response shape changed: expected data.jobs to be an array, got ${typeof data.jobs}`
            );
        }
        return data;
    }

    /** @returns {Promise<import('./JobSource').RawJob[]>} */
    async getCurrentJobs() {
        const jobs = [];

        for (let page = 0; page < MAX_PAGES; page++) {
            const data = await this.fetchPage(page * PAGE_SIZE);
            jobs.push(...data.jobs.map(mapAmazonJob));

            if (data.jobs.length < PAGE_SIZE) break;       // last page
            if (jobs.length >= (data.hits || 0)) break;    // got everything
        }

        return jobs;
    }
}

module.exports = { AmazonAdapter, mapAmazonJob };
