const { JobSource } = require('./JobSource');
const { locationTokens, isIsraeliLocation } = require('../domain/locations');
const { normalizeEmploymentType, normalizeExperienceLevel, guessExperienceFromTitle } = require('../domain/vocabulary');

/**
 * SmartRecruiters' public job postings API — public, unauthenticated, meant
 * for outside use:
 *
 *   GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings
 *
 * Verified against Syneron-Candela on 2026-08-11. Two things worth knowing:
 *
 *   1. The list payload has no ready-to-click apply link (its own `ref` field
 *      is the API resource, not a page a person can open) — but
 *      `https://jobs.smartrecruiters.com/{company}/{id}` resolves on its own,
 *      no slug needed, so it doesn't take a second request per job to build one.
 *   2. `location.fullLocation` is already a human string ("Wayland, MA, United
 *      States"), so the same locationTokens()/isIsraeliLocation() fallback
 *      used by the Greenhouse adapter applies directly.
 */

/** Pure mapping: one SmartRecruiters posting -> RawJob. */
function mapSmartRecruitersJob(raw, companyIdentifier) {
    const externalId = raw.id ? String(raw.id) : null;
    if (!externalId) {
        throw new Error(`SmartRecruiters posting has no id: ${JSON.stringify(raw).slice(0, 120)}`);
    }

    const title = String(raw.name || '').trim();

    return {
        externalId,
        title,
        location: raw.location?.fullLocation || '',
        applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(companyIdentifier)}/${externalId}`,
        department: raw.function?.label || null,
        employmentType: normalizeEmploymentType(raw.typeOfEmployment?.label),
        experienceLevel: normalizeExperienceLevel(raw.experienceLevel?.label) || guessExperienceFromTitle(title),
        postedAt: raw.releasedDate ? raw.releasedDate.slice(0, 10) : null,
    };
}

/** Does this posting's location count as a match for the configured filter? */
function matchesLocation(fullLocation, configLocation) {
    if (configLocation) return fullLocation.toLowerCase().includes(configLocation.toLowerCase());
    return locationTokens(fullLocation).some((token) => isIsraeliLocation(token));
}

class SmartRecruitersAdapter extends JobSource {
    static type = 'smartrecruiters';
    static describe = {
        help: "SmartRecruiters' public job postings API. Verified against Syneron-Candela on 2026-08-11.",
        required: {
            companyIdentifier: "the company slug in the API URL, e.g. 'Syneron-Candela' — usually but not always the company's own name",
        },
        optional: {
            location: "substring to match against the full location string, e.g. 'Israel'. Omit to auto-match any recognized Israeli location.",
        },
    };

    constructor(config = {}) {
        super();
        this.companyIdentifier = config.companyIdentifier;
        this.location = config.location || '';
    }

    get postingsUrl() {
        return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(this.companyIdentifier)}/postings?limit=100`;
    }

    async getCurrentJobs() {
        const res = await fetch(this.postingsUrl);
        if (!res.ok) {
            throw new Error(`SmartRecruiters fetch failed for company "${this.companyIdentifier}": ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        if (!Array.isArray(data.content)) {
            throw new Error(`SmartRecruiters response shape changed for company "${this.companyIdentifier}": expected content to be an array`);
        }

        const jobs = data.content
            .filter((raw) => matchesLocation(raw.location?.fullLocation || '', this.location))
            .map((raw) => mapSmartRecruitersJob(raw, this.companyIdentifier));

        if (jobs.length === 0) {
            throw new Error(
                `SmartRecruiters returned ${data.content.length} jobs for company "${this.companyIdentifier}" but none ` +
                    `matched the location filter. Check the spelling, or re-run: node tools/probe.js "${this.postingsUrl}"`
            );
        }

        return jobs;
    }
}

module.exports = { SmartRecruitersAdapter, mapSmartRecruitersJob, matchesLocation };
