const { JobSource } = require('./JobSource');
const { decodeEntities, HTML_HEADERS } = require('./htmlUtils');
const { guessExperienceFromTitle } = require('../domain/vocabulary');
const { ScrapeError, classifyHttpStatus } = require('../domain/scrapeOutcome');

/**
 * Apple's careers site (jobs.apple.com) renders its search results server-side
 * — no XHR to reverse-engineer, unlike the global-header nav widgets that show
 * up if you sniff the page (those are unrelated chrome, not the job list).
 *
 * Verified against a real page fetched 2026-08-06: 18 Israel jobs per page,
 * `?location=israel-ISR` genuinely filters server-side (unlike IBM's version of
 * the same idea, which is decorative — see ibmAdapter.js).
 *
 * Every job card is duplicated in the markup (a second copy without the
 * surrounding team/date/location spans, presumably a responsive layout
 * artifact) — the id-based dedupe here is load-bearing, not defensive
 * boilerplate. Same shape of problem Mobileye has; see mobileyeAdapter.js.
 */

const BASE = 'https://jobs.apple.com';
const MAX_PAGES = 30;

const MONTHS = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** '03 Aug 2026' -> '2026-08-03'; anything else -> null rather than a guess. */
function parseAppleDate(text) {
    const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(String(text || '').trim());
    if (!m) return null;
    const [, day, mon, year] = m;
    const month = MONTHS[mon];
    if (!month) return null;
    return `${year}-${month}-${day.padStart(2, '0')}`;
}

/** Pure parse: one results page of HTML -> RawJob[]. */
function parseAppleJobs(html) {
    const jobs = [];
    const seen = new Set();

    // Anchored on the /details/<jobId>-<locationId>/<slug> URL shape plus the
    // three sibling spans (team, posted date, location) every real card carries.
    const cardRe =
        /href="(\/[a-z-]+\/details\/(\d+-\d+)\/[^"?]*)(?:\?[^"]*)?"\s+data-discover="true">([^<]*)<\/a><\/h3><span[^>]*class="team-name[^"]*">([^<]*)<\/span><span class="job-posted-date"[^>]*>([^<]*)<\/span>[\s\S]{0,400}?<span id="search-store-name-container-\d+">([^<]*)<\/span>/g;

    let match;
    while ((match = cardRe.exec(html)) !== null) {
        const [, path, id, title, team, postedDate, location] = match;
        if (seen.has(id)) continue;
        seen.add(id);

        const titleText = decodeEntities(title);

        jobs.push({
            externalId: id,
            title: titleText,
            location: decodeEntities(location),
            department: decodeEntities(team),
            applyUrl: `${BASE}${path}`,
            employmentType: null, // Apple doesn't publish this on the results page
            experienceLevel: guessExperienceFromTitle(titleText),
            postedAt: parseAppleDate(postedDate),
        });
    }

    return jobs;
}

class AppleAdapter extends JobSource {
    static type = 'apple';
    static describe = {
        help: "Apple careers, server-rendered. Verified 2026-08-06.",
        required: {},
        optional: {
            locale: "URL locale prefix, e.g. 'en-il'",
            location: "Apple's own location facet value, e.g. 'israel-ISR'",
        },
    };

    constructor(config = {}) {
        super();
        this.locale = config.locale || 'en-il';
        this.location = config.location || 'israel-ISR';
    }

    buildUrl(page) {
        const params = new URLSearchParams({ location: this.location, page: String(page) });
        return `${BASE}/${this.locale}/search?${params}`;
    }

    async getCurrentJobs() {
        const all = [];
        const seen = new Set();

        for (let page = 1; page <= MAX_PAGES; page++) {
            const res = await fetch(this.buildUrl(page), { headers: HTML_HEADERS });
            if (!res.ok) {
                throw new ScrapeError(
                    `Apple fetch failed on page ${page}: ${res.status} ${res.statusText}`,
                    classifyHttpStatus(res.status)
                );
            }

            const html = await res.text();
            const jobs = parseAppleJobs(html);

            if (page === 1 && jobs.length === 0) {
                throw new Error(
                    `Apple page 1 parsed to 0 jobs from ${html.length} chars of HTML — ` +
                        'the markup probably changed. Re-run: node tools/probe.js "' + this.buildUrl(1) + '"'
                );
            }

            // A page with nothing new is the normal end condition — later pages
            // don't return a stable count, so this is the only signal we trust.
            const fresh = jobs.filter((j) => !seen.has(j.externalId));
            if (fresh.length === 0) break;

            for (const job of fresh) {
                seen.add(job.externalId);
                all.push(job);
            }
        }

        return all;
    }
}

module.exports = { AppleAdapter, parseAppleJobs, parseAppleDate };
