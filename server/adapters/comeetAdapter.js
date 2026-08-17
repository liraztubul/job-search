const { JobSource } = require('./JobSource');
const { locationTokens, isIsraeliLocation } = require('../domain/locations');
const { normalizeEmploymentType, normalizeExperienceLevel, guessExperienceFromTitle } = require('../domain/vocabulary');

/**
 * Comeet's public per-company positions API. Verified against Lumenis on
 * 2026-08-11 — the adapter as first written (companyUid only, flat
 * `location.name` string) never actually worked:
 *
 *   1. The endpoint 400s with "Token is missing" without a `?token=` query
 *      param. It isn't the company uid — it's a separate value baked into
 *      the careers page's own JS config (`"token": "..."` next to
 *      `"company_uid"` in the page source). Both are required.
 *   2. `location` is a structured object (`city`, `country` as an ISO-2 code,
 *      `state`, ...), not a single display string — there's no `.name`
 *      field worth reading for this, `city`/`country` have to be joined.
 *   3. A posting open in several offices comes back as one array entry per
 *      office, with the same base uid suffixed per location
 *      (`"C5.F67"` and `"C5.F67-51.308"`) — not a single job with a location
 *      list. Each entry is already a distinct RawJob as far as this adapter
 *      is concerned.
 */
class ComeetAdapter extends JobSource {
    static type = 'comeet';
    static describe = {
        help: "Comeet's public per-company positions API. Verified against Lumenis on 2026-08-11.",
        required: {
            companyUid: "the company's Comeet uid, e.g. 'A1.00C' — found in its careers page URL",
            token: "the per-company API token — found in the careers page's own script tag next to \"company_uid\"",
        },
        optional: {
            location: "substring to match against the office name/city, e.g. 'Tel Aviv'. Omit to auto-match any recognized Israeli location.",
        },
    };

    constructor(config = {}) {
        super();
        this.companyUid = config.companyUid;
        this.token = config.token;
        this.location = config.location || '';
    }

    get positionsUrl() {
        return `https://www.comeet.com/careers-api/2.0/company/${encodeURIComponent(this.companyUid)}/positions?token=${encodeURIComponent(this.token)}`;
    }

    async getCurrentJobs() {
        const res = await fetch(this.positionsUrl);
        if (!res.ok) {
            throw new Error(`Comeet fetch failed for company "${this.companyUid}": ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        if (!Array.isArray(data)) {
            throw new Error(`Comeet response shape changed for company "${this.companyUid}": expected an array, got ${typeof data}`);
        }

        const jobs = data.filter((pos) => this.matchesLocation(pos.location)).map((pos) => mapComeetJob(pos));

        if (jobs.length === 0) {
            throw new Error(
                `Comeet returned ${data.length} jobs for company "${this.companyUid}" but none matched the location ` +
                    `filter. Check the spelling, or re-run: node tools/probe.js "${this.positionsUrl}"`
            );
        }

        return jobs;
    }

    matchesLocation(loc) {
        const display = comeetLocationText(loc);
        if (this.location) return display.toLowerCase().includes(this.location.toLowerCase());
        return locationTokens(display).some((token) => isIsraeliLocation(token));
    }
}

/** Join Comeet's structured location into one display string. */
function comeetLocationText(loc) {
    if (!loc) return '';
    return [loc.city, loc.country].filter(Boolean).join(', ');
}

/** Pure mapping: one Comeet position -> RawJob. */
function mapComeetJob(pos) {
    const externalId = pos.uid ? String(pos.uid) : null;
    if (!externalId) {
        throw new Error(`Comeet posting has no uid: ${JSON.stringify(pos).slice(0, 120)}`);
    }

    const title = String(pos.name || '').trim();

    return {
        externalId,
        title,
        location: comeetLocationText(pos.location),
        applyUrl: pos.url_comeet_hosted_page || pos.url_recruit_hosted_page || pos.url_active_page,
        department: pos.department || null,
        employmentType: normalizeEmploymentType(pos.employment_type),
        experienceLevel: normalizeExperienceLevel(pos.experience_level) || guessExperienceFromTitle(title),
        // time_updated is a LAST-MODIFIED timestamp, not a first-published
        // one — a six-month-old posting edited yesterday would arrive with a
        // fresh date and wrongly earn a "just added" badge (posted_at is a
        // strict first-published-or-null invariant, see data/jobs.js). Could
        // be preserved separately as a source_updated_at column if the signal
        // is ever wanted for something else, but nothing needs it today.
        postedAt: null,
    };
}

module.exports = { ComeetAdapter, mapComeetJob, comeetLocationText };
