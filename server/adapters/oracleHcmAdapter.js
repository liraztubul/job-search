const { JobSource } = require('./JobSource');
const { decodeEntities, HTML_HEADERS } = require('./htmlUtils');
const { guessExperienceFromTitle } = require('../domain/vocabulary');

/**
 * Oracle Recruiting Cloud (the "Candidate Experience" site under
 * hcmRestApi/resources/.../recruitingCEJobRequisitions) — the ATS behind Dell's
 * careers site and a lot of other large enterprises.
 *
 * Verified against a live Dell response on 2026-08-06. Two things aren't
 * obvious from the API docs and will waste your afternoon if you skip them:
 *
 *   1. Without `expand=requisitionList` the endpoint returns 200 with facets
 *      and a TotalJobsCount, but the actual `requisitionList` array is just
 *      missing from the response — not empty, absent. Looks like a working
 *      search until you notice zero jobs ever come back.
 *   2. `limit` is capped server-side around 200 regardless of what you ask
 *      for, so a tenant with more open reqs than that needs real pagination
 *      via `offset`, not one big request.
 *
 * Country filtering happens client-side against PrimaryLocationCountry
 * (ISO alpha-2, e.g. "IL") because the location facet only lists countries
 * that make its top-N-by-count cutoff — Israel didn't for Dell despite
 * having real open reqs, so trusting the facet would silently drop them.
 */

const PAGE_SIZE = 200; // the server's own cap, not a choice we get to make
const MAX_REQUESTS = 20; // bounded so a pagination bug can't hammer the tenant

/** Pure mapping: one Oracle requisition -> RawJob. */
function mapOracleJob(raw, host, siteNumber) {
    const externalId = String(raw.Id ?? '');
    if (!externalId) {
        throw new Error(`Oracle requisition has no Id: ${JSON.stringify(raw).slice(0, 120)}`);
    }

    const title = decodeEntities(raw.Title || '');

    return {
        externalId,
        title,
        location: raw.PrimaryLocation || '',
        applyUrl: `https://${host}/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${externalId}`,
        department: raw.JobFamily || raw.Organization || raw.BusinessUnit || null,
        // WorkplaceTypeCode (on-site/remote/hybrid) is where you sit, not
        // whether the job is full time — same call the Eightfold adapter makes.
        employmentType: null,
        experienceLevel: guessExperienceFromTitle(title),
        postedAt: raw.PostedDate || null,
        countryCode: raw.PrimaryLocationCountry || null,
    };
}

class OracleHcmAdapter extends JobSource {
    static type = 'oracle-hcm';
    static describe = {
        help: 'Oracle Recruiting Cloud (Candidate Experience site). Verified against Dell on 2026-08-06.',
        required: {
            host: "career site hostname, e.g. 'enterpriseplatform.dell.com'",
            siteNumber: "the site's own id, e.g. 'CX_1' — visible in its search API calls",
        },
        optional: { country: "ISO alpha-2 country code to keep, e.g. 'IL'. Omit for worldwide." },
    };

    constructor(config = {}) {
        super();
        this.host = config.host;
        this.siteNumber = config.siteNumber;
        this.country = config.country || '';
    }

    buildUrl(offset) {
        const params = new URLSearchParams({
            onlyData: 'true',
            expand: 'requisitionList',
            finder: `findReqs;siteNumber=${this.siteNumber},limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`,
        });
        return `https://${this.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${params}`;
    }

    async fetchPage(offset) {
        const res = await fetch(this.buildUrl(offset), { headers: HTML_HEADERS });
        if (!res.ok) {
            throw new Error(`Oracle HCM fetch failed for ${this.host}: ${res.status} ${res.statusText}`);
        }

        const body = await res.json();
        const item = body?.items?.[0];
        if (!item || !Array.isArray(item.requisitionList)) {
            throw new Error(
                `Oracle HCM response shape changed for ${this.host}: expected items[0].requisitionList ` +
                    `to be an array. Did the "expand=requisitionList" param get dropped?`
            );
        }
        return item;
    }

    matchesCountry(job) {
        if (!this.country) return true;
        return job.countryCode === this.country;
    }

    async getCurrentJobs() {
        const jobs = [];
        let offset = 0;
        let total = null;

        for (let request = 0; request < MAX_REQUESTS; request++) {
            const item = await this.fetchPage(offset);
            if (total === null) total = Number(item.TotalJobsCount) || 0;

            const pageSize = item.requisitionList.length;
            if (pageSize === 0) break;

            for (const raw of item.requisitionList) {
                const job = mapOracleJob(raw, this.host, this.siteNumber);
                if (this.matchesCountry(job)) jobs.push(job);
            }

            offset += pageSize;
            if (offset >= total) break;
        }

        if (jobs.length === 0 && this.country) {
            throw new Error(
                `Oracle HCM returned ${total} requisitions for ${this.host} but none matched country ` +
                    `"${this.country}". Check the country code, or re-run: node tools/probe.js "${this.buildUrl(0)}"`
            );
        }

        return jobs.map(({ countryCode, ...job }) => job);
    }
}

module.exports = { OracleHcmAdapter, mapOracleJob };
