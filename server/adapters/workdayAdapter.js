const { JobSource } = require('./JobSource');
const { HTML_HEADERS } = require('./htmlUtils');
const { guessExperienceFromTitle } = require('../domain/vocabulary');

/**
 * Workday's candidate experience site (CXS) — the recruiting platform behind
 * Intel's careers site, and one of the most common ATSes among large
 * enterprises generally. Verified against Intel on 2026-08-06.
 *
 *   POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *
 * Two things that aren't obvious from the API shape:
 *
 *   1. There's no plain "give me jobs in Israel" parameter. Location filtering
 *      goes through `appliedFacets.locations`, a list of opaque per-tenant
 *      hashes — you get them by making an unfiltered request first and reading
 *      the `facets` field. A free-text search for the country name looks like
 *      it works but is really a keyword match against title/description, and
 *      quietly returns a different (usually smaller) set than the real filter.
 *   2. `limit` is capped at 20 server-side; asking for more is a 400, not a
 *      truncated response.
 */

const PAGE_SIZE = 20;
const MAX_PAGES = 30;

/**
 * Pull the requisition code out of bulletFields — the number the site itself
 * treats as the job's identity. Format isn't standard across tenants: Intel
 * spells it "JR0281513" (no separator), Palo Alto Networks "JR-020840" (a
 * dash before the digits). Both fit letters-then-optional-dash-then-digits.
 */
function extractJobCode(bulletFields) {
    const hit = (bulletFields || []).find((b) => /^[A-Z]{1,4}-?\d{4,}/.test(b));
    return hit || null;
}

/**
 * Does a facet descriptor name this country? Descriptor format isn't standard
 * across tenants: Intel spells it "Israel, Haifa" (country first, comma
 * delimited); Palo Alto Networks spells the same idea "Office - Israel -
 * CyberArk Be'er Sheva" (dashes, country in the middle). Splitting on every
 * delimiter seen so far and matching any whole segment survives both instead
 * of assuming one.
 */
function descriptorMatchesCountry(descriptor, country) {
    const needle = country.trim().toLowerCase();
    return descriptor.split(/[,\-|]/).some((part) => part.trim().toLowerCase() === needle);
}

/** Pure mapping: one Workday job posting -> RawJob. */
function mapWorkdayJob(posting, host, site, locale) {
    const externalPath = posting.externalPath || '';
    const jobCode = extractJobCode(posting.bulletFields);
    const externalId = jobCode || externalPath;
    if (!externalId) {
        throw new Error(`Workday posting has no usable id: ${JSON.stringify(posting).slice(0, 120)}`);
    }

    const title = posting.title || '';

    return {
        externalId,
        title,
        location: posting.locationsText || '',
        applyUrl: `https://${host}/${locale}/${site}${externalPath}`,
        // Not on the list payload — only the per-job detail page has it, and
        // fetching every posting individually just to fill this in would turn
        // one request per page into one request per job.
        department: null,
        employmentType: null,
        experienceLevel: guessExperienceFromTitle(title),
        // Workday gives relative text ("Posted Yesterday"), not a date — kept
        // verbatim, same as Amazon's posted_date. Not ours to parse into one.
        postedAt: posting.postedOn || null,
        jobCode,
    };
}

class WorkdayAdapter extends JobSource {
    static type = 'workday';
    static describe = {
        help: 'Workday candidate experience site (CXS). Verified against Intel on 2026-08-06.',
        required: {
            host: "the tenant's Workday hostname, e.g. 'intel.wd1.myworkdayjobs.com'",
            tenant: "the tenant slug in the API path, e.g. 'intel'",
            site: "the career site name, e.g. 'External'",
        },
        optional: {
            country: "country name exactly as this tenant's own location facet spells it, e.g. 'Israel'. Omit for worldwide.",
            locale: "URL locale segment, default 'en-US'",
        },
    };

    constructor(config = {}) {
        super();
        this.host = config.host;
        this.tenant = config.tenant;
        this.site = config.site;
        this.country = config.country || '';
        this.locale = config.locale || 'en-US';
    }

    get jobsUrl() {
        return `https://${this.host}/wday/cxs/${this.tenant}/${this.site}/jobs`;
    }

    async postSearch(body) {
        const res = await fetch(this.jobsUrl, {
            method: 'POST',
            headers: { ...HTML_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`Workday search failed for ${this.host}: ${res.status} ${res.statusText}`);
        }
        return res.json();
    }

    /** @returns {Promise<string[]>} facet ids for every location under this.country */
    async resolveLocationIds() {
        const data = await this.postSearch({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' });
        const group = (data.facets || []).find((f) => f.facetParameter === 'locationMainGroup');
        const locations = group?.values?.find((v) => v.facetParameter === 'locations')?.values || [];
        const ids = locations.filter((v) => descriptorMatchesCountry(v.descriptor, this.country)).map((v) => v.id);

        if (ids.length === 0) {
            throw new Error(
                `Workday: no location on ${this.host} matches country "${this.country}". Check the ` +
                    `spelling against the tenant's own facet list, or re-run: node tools/probe.js "${this.jobsUrl}"`
            );
        }
        return ids;
    }

    async getCurrentJobs() {
        const locationIds = this.country ? await this.resolveLocationIds() : [];
        const appliedFacets = locationIds.length ? { locations: locationIds } : {};

        const jobs = [];
        let total = null;

        for (let page = 0; page < MAX_PAGES; page++) {
            const offset = page * PAGE_SIZE;
            const data = await this.postSearch({ appliedFacets, limit: PAGE_SIZE, offset, searchText: '' });
            if (total === null) total = Number(data.total) || 0;

            if (!Array.isArray(data.jobPostings) || data.jobPostings.length === 0) break;
            jobs.push(...data.jobPostings.map((p) => mapWorkdayJob(p, this.host, this.site, this.locale)));

            if (jobs.length >= total) break;
        }

        return jobs;
    }
}

module.exports = { WorkdayAdapter, mapWorkdayJob, extractJobCode, descriptorMatchesCountry };
