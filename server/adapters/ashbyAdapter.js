const { JobSource } = require('./JobSource');
const { normalizeEmploymentType, guessExperienceFromTitle } = require('../domain/vocabulary');

/**
 * Ashby's public job board API — the recruiting platform behind monday.com's
 * careers site. Unlike most platforms in this file, this one is genuinely
 * meant for outside consumption: no session, no auth, no facet discovery
 * dance, just
 *
 *   GET https://api.ashbyhq.com/posting-api/job-board/{boardName}
 *
 * Verified against monday.com on 2026-08-06. The board name isn't always the
 * obvious slug — monday.com's own jobs.ashbyhq.com page uses "monday", but
 * the posting API only answers to "monday.com" (the literal domain). Probe
 * before assuming.
 */

/** Pure mapping: one Ashby posting -> RawJob. */
function mapAshbyJob(raw) {
    const externalId = String(raw.id ?? '');
    if (!externalId) {
        throw new Error(`Ashby posting has no id: ${JSON.stringify(raw).slice(0, 120)}`);
    }

    const secondary = (raw.secondaryLocations || []).map((s) => s.location).filter(Boolean);

    return {
        externalId,
        title: raw.title || '',
        location: [raw.location, ...secondary].filter(Boolean).join(' · '),
        applyUrl: raw.jobUrl || raw.applyUrl,
        department: raw.department || null,
        employmentType: normalizeEmploymentType(raw.employmentType),
        experienceLevel: guessExperienceFromTitle(raw.title || ''),
        postedAt: raw.publishedAt ? raw.publishedAt.slice(0, 10) : null,
        // Every country this posting is open in — the boundary the adapter's
        // own matchesCountry() checks against, stripped before the job leaves
        // getCurrentJobs() the same way Oracle HCM drops its countryCode.
        countries: [raw.address?.postalAddress?.addressCountry, ...(raw.secondaryLocations || []).map((s) => s.address?.postalAddress?.addressCountry)].filter(Boolean),
    };
}

class AshbyAdapter extends JobSource {
    static type = 'ashby';
    static describe = {
        help: "Ashby's public job board API. Verified against monday.com on 2026-08-06.",
        required: { boardName: "the board slug in the API URL, e.g. 'monday.com' — probe first, it isn't always the obvious one" },
        optional: { country: "country name as Ashby's own address field spells it, e.g. 'Israel'. Omit for worldwide." },
    };

    constructor(config = {}) {
        super();
        this.boardName = config.boardName;
        this.country = config.country || '';
    }

    get boardUrl() {
        return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(this.boardName)}`;
    }

    matchesCountry(job) {
        if (!this.country) return true;
        return job.countries.includes(this.country);
    }

    async getCurrentJobs() {
        const res = await fetch(this.boardUrl);
        if (!res.ok) {
            throw new Error(`Ashby fetch failed for board "${this.boardName}": ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        if (!Array.isArray(data.jobs)) {
            throw new Error(`Ashby response shape changed for board "${this.boardName}": expected jobs to be an array`);
        }

        const jobs = data.jobs.map(mapAshbyJob).filter((job) => this.matchesCountry(job));

        if (jobs.length === 0 && this.country) {
            throw new Error(
                `Ashby returned ${data.jobs.length} jobs for board "${this.boardName}" but none matched country ` +
                    `"${this.country}". Check the spelling, or re-run: node tools/probe.js "${this.boardUrl}"`
            );
        }

        return jobs.map(({ countries, ...job }) => job);
    }
}

module.exports = { AshbyAdapter, mapAshbyJob };
