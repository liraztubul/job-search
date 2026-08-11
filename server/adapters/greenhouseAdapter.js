const { JobSource } = require('./JobSource');
const { locationTokens, isIsraeliLocation } = require('../domain/locations');
const { guessExperienceFromTitle } = require('../domain/vocabulary');

/**
 * Greenhouse's public job board API — one of the most common third-party
 * ATSes, and genuinely meant for outside consumption (no auth, no session,
 * documented and stable):
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/{boardToken}/jobs
 *
 * Verified against Riskified on 2026-08-11 — found by noticing their own
 * `/api/get-jobs/v1/jobs/` proxy returns `absolute_url` values containing
 * `?gh_jid=`, the tell that a "custom" careers page is Greenhouse underneath.
 * The board token is usually the company's own lowercase name, but not
 * always — confirm with `node tools/probe.js` before assuming.
 *
 * The flat `/jobs` list has no per-job department/office breakdown (that
 * needs a different, hierarchical endpoint) and no employment type field —
 * both stay null rather than guessed.
 */

const MAX_TITLE_LENGTH_FOR_GUESS = 200; // sanity bound, not a real constraint

/** Pure mapping: one Greenhouse posting -> RawJob. */
function mapGreenhouseJob(raw) {
    const externalId = String(raw.id ?? '');
    if (!externalId) {
        throw new Error(`Greenhouse posting has no id: ${JSON.stringify(raw).slice(0, 120)}`);
    }

    const title = String(raw.title || '').trim();

    return {
        externalId,
        title,
        location: raw.location?.name || '',
        applyUrl: raw.absolute_url,
        department: null,
        employmentType: null,
        experienceLevel: title.length < MAX_TITLE_LENGTH_FOR_GUESS ? guessExperienceFromTitle(title) : null,
        postedAt: raw.first_published ? raw.first_published.slice(0, 10) : null,
    };
}

/** Does this posting's office count as a match for the configured filter? */
function matchesLocation(rawLocationName, configLocation) {
    if (configLocation) return rawLocationName.toLowerCase().includes(configLocation.toLowerCase());
    // No explicit filter configured: fall back to the same Israeli-place
    // whitelist the rest of the site uses, so "Tel Aviv" / "Herzliya" / etc.
    // match without having to know in advance what a tenant calls its office.
    return locationTokens(rawLocationName).some((token) => isIsraeliLocation(token));
}

class GreenhouseAdapter extends JobSource {
    static type = 'greenhouse';
    static describe = {
        help: "Greenhouse's public job board API. Verified against Riskified on 2026-08-11.",
        required: { boardToken: "the board slug in the API URL, e.g. 'riskified' — usually but not always the company's own name" },
        optional: {
            location: "substring to match against the office name, e.g. 'Tel Aviv'. Omit to auto-match any recognized Israeli location.",
        },
    };

    constructor(config = {}) {
        super();
        this.boardToken = config.boardToken;
        this.location = config.location || '';
    }

    get boardUrl() {
        return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(this.boardToken)}/jobs`;
    }

    async getCurrentJobs() {
        const res = await fetch(this.boardUrl);
        if (!res.ok) {
            throw new Error(`Greenhouse fetch failed for board "${this.boardToken}": ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        if (!Array.isArray(data.jobs)) {
            throw new Error(`Greenhouse response shape changed for board "${this.boardToken}": expected jobs to be an array`);
        }

        const jobs = data.jobs
            .filter((raw) => matchesLocation(raw.location?.name || '', this.location))
            .map(mapGreenhouseJob);

        if (jobs.length === 0) {
            throw new Error(
                `Greenhouse returned ${data.jobs.length} jobs for board "${this.boardToken}" but none matched the ` +
                    `location filter. Check the spelling, or re-run: node tools/probe.js "${this.boardUrl}"`
            );
        }

        return jobs;
    }
}

module.exports = { GreenhouseAdapter, mapGreenhouseJob, matchesLocation };
