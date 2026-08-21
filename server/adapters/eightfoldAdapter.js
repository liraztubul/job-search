const { JobSource } = require('./JobSource');
const { decodeEntities, HTML_HEADERS } = require('./htmlUtils');
const { guessExperienceFromTitle } = require('../domain/vocabulary');
const { ScrapeError, FAILURE_KIND, classifyHttpStatus, parseJsonResponse } = require('../domain/scrapeOutcome');

/**
 * Eightfold AI — the recruiting platform behind NVIDIA's careers site.
 *
 *   https://jobs.nvidia.com/api/pcsx/search?domain=nvidia.com&query=&location=&start=0
 *
 * This is the project's first adapter written for a *platform* rather than a
 * company: host, domain and API path are all configuration, so another Eightfold
 * tenant is a CLI call rather than a new file.
 *
 * Verified against a live capture of NVIDIA on 2026-08-05 (`node tools/sniff.js
 * nvidia`): 2,586 open positions, 10 per page. The response nests the payload
 * under `data`, not at the root — see tests/fixtures/nvidia-jobs.json.
 *
 * A warning for other tenants: Eightfold's more common public path is
 * `/api/apply/v2/jobs`. NVIDIA uses `/api/pcsx/search`, and that endpoint
 * answers `403 Not authorized for PCSX` to requests it doesn't like. If you
 * point this at a different company, sniff it first instead of assuming.
 */

const DEFAULT_API_PATH = '/api/pcsx/search';
const MAX_REQUESTS = 60; // bounded, so a pagination bug can't hammer them

/** Pure mapping: one Eightfold position -> RawJob. */
function mapEightfoldJob(raw, host) {
    const externalId = String(raw.id ?? '');
    if (!externalId) {
        throw new Error(`Eightfold position has no id: ${JSON.stringify(raw).slice(0, 120)}`);
    }

    const title = decodeEntities(raw.name || '');
    const locations = Array.isArray(raw.locations) ? raw.locations : [];

    return {
        externalId,
        title,
        // A position can be open in several offices. Joining keeps every one of
        // them searchable — the UI filter is a substring match, so "Yokneam"
        // still finds a job listed as "Israel, Tel Aviv · Israel, Yokneam".
        location: locations.map((l) => decodeEntities(l)).join(' · '),
        applyUrl: raw.positionUrl ? `https://${host}${raw.positionUrl}` : `https://${host}/careers`,
        department: raw.department || null,
        // Eightfold publishes `workLocationOption` (onsite/remote/hybrid), which
        // is a work arrangement, not an employment type. Mapping one to the
        // other would put a wrong value in a filter, so: null.
        employmentType: null,
        experienceLevel: guessExperienceFromTitle(title),
        postedAt: raw.postedTs ? new Date(raw.postedTs * 1000).toISOString().slice(0, 10) : null,
        // The requisition number the careers site shows, e.g. JR2022200.
        jobCode: raw.displayJobId || raw.atsJobId || null,
    };
}

class EightfoldAdapter extends JobSource {
    static type = 'eightfold';
    static describe = {
        help: 'Eightfold AI recruiting platform. Verified against NVIDIA on 2026-08-05.',
        required: {
            host: "careers hostname, e.g. 'jobs.nvidia.com'",
            domain: "Eightfold tenant domain, e.g. 'nvidia.com'",
        },
        optional: {
            location: "location search text, e.g. 'Israel'. Omit for worldwide.",
            query: 'keyword search applied server-side',
            apiPath: `search endpoint if the tenant differs from ${DEFAULT_API_PATH}`,
        },
    };

    constructor(config = {}) {
        super();
        this.host = config.host;
        this.domain = config.domain;
        this.location = config.location || '';
        this.query = config.query || '';
        this.apiPath = config.apiPath || DEFAULT_API_PATH;
    }

    buildUrl(start) {
        const params = new URLSearchParams({
            domain: this.domain,
            query: this.query,
            location: this.location,
            start: String(start),
        });
        return `https://${this.host}${this.apiPath}?${params}`;
    }

    async fetchPage(start) {
        const res = await fetch(this.buildUrl(start), { headers: HTML_HEADERS });
        if (!res.ok) {
            throw new ScrapeError(
                `Eightfold fetch failed for ${this.host}: ${res.status} ${res.statusText}`,
                classifyHttpStatus(res.status)
            );
        }

        const body = await parseJsonResponse(res, 'Eightfold');
        const data = body?.data;
        if (!data || !Array.isArray(data.positions)) {
            throw new Error(
                `Eightfold response shape changed for ${this.host}: expected data.positions to be ` +
                    `an array, got ${typeof data?.positions}`
            );
        }
        return data;
    }

    /**
     * `location` is the site's own search box, so the server usually filters for
     * us. We re-check each job's own `locations` anyway: if a tenant ignores the
     * parameter we'd otherwise silently collect the whole world.
     */
    matchesLocation(job) {
        if (!this.location) return true;
        const needle = this.location.toLowerCase();
        return job.location.toLowerCase().includes(needle);
    }

    async getCurrentJobs() {
        const jobs = [];
        const seen = new Set();
        let start = 0;
        let total = null;

        for (let request = 0; request < MAX_REQUESTS; request++) {
            const data = await this.fetchPage(start);
            if (total === null) total = Number(data.count) || 0;

            // Step by what the server actually returned. Eightfold's page size
            // is not something we get to assume, and hard-coding 10 would either
            // skip jobs or re-read the same page forever.
            const pageSize = data.positions.length;
            if (pageSize === 0) break;

            for (const raw of data.positions) {
                const job = mapEightfoldJob(raw, this.host);
                if (seen.has(job.externalId) || !this.matchesLocation(job)) continue;
                seen.add(job.externalId);
                jobs.push(job);
            }

            start += pageSize;
            if (start >= total) break;
        }

        if (jobs.length === 0) {
            throw new ScrapeError(
                `Eightfold returned ${total} positions for ${this.host} but none matched ` +
                    `location "${this.location}". Check the location text, or re-run: ` +
                    'node tools/sniff.js nvidia',
                FAILURE_KIND.EMPTY
            );
        }

        return jobs;
    }
}

module.exports = { EightfoldAdapter, mapEightfoldJob };
