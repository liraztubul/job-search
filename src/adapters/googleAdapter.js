const { JobSource } = require('./JobSource');
const { decodeEntities, HTML_HEADERS } = require('./htmlUtils');
const { normalizeExperienceLevel, guessExperienceFromTitle } = require('./normalize');

/**
 * Google renders its careers results server-side, 20 jobs per page.
 * Verified against a real page saved on 2026-08-05 (20 jobs parsed from page 1
 * of 101, no blank fields). See tests/fixtures/google-jobs.html.
 *
 * IMPORTANT: Google's CSS classes are build-generated garbage (`WpHeLc`,
 * `l103df`, `r0wTof`) and will change without warning. So this parser anchors on
 * two things that are semantically load-bearing and therefore stable:
 *   1. the job URL shape  /jobs/results/<id>-<slug>
 *   2. aria-label="Learn more about <title>"  — an accessibility contract
 *
 * Rule of thumb: scrape the parts of a page a screen reader depends on, not the
 * parts a designer controls.
 */

const BASE = 'https://www.google.com/about/careers/applications';
const PAGE_SIZE = 20;
const MAX_PAGES = 15;

/** Pure parse: one results page of HTML -> RawJob[] */
function parseGoogleJobs(html) {
    const jobs = [];
    const seen = new Set();

    const cardRe = /href="(jobs\/results\/(\d+)-[^"?]*)[^"]*"\s+aria-label="Learn more about ([^"]*)"/g;

    let match;
    while ((match = cardRe.exec(html)) !== null) {
        const [, jobPath, id, title] = match;
        if (seen.has(id)) continue;
        seen.add(id);

        // The location sits above the link inside the same card, formatted as
        // `Google | <span><span>Tel Aviv, Israel</span></span>`.
        const before = html.slice(Math.max(0, match.index - 4000), match.index);
        const marker = before.lastIndexOf('Google | ');
        let location = '';
        if (marker >= 0) {
            const spans = before.slice(marker).match(/<span[^>]*>\s*<span[^>]*>([^<]+)<\/span>/);
            if (spans) location = decodeEntities(spans[1]);
        }

        // Google grades every posting Early / Mid / Advanced, and exposes it in
        // an aria-label — another accessibility contract rather than a CSS class.
        const levelMatch = before.match(/aria-label="(Early|Mid|Advanced), Learn more about experience filters/g);
        const level = levelMatch ? levelMatch[levelMatch.length - 1].match(/"(Early|Mid|Advanced),/)[1] : null;

        const titleText = decodeEntities(title);

        jobs.push({
            externalId: id,
            title: titleText,
            location,
            applyUrl: `${BASE}/${jobPath}`,
            experienceLevel: normalizeExperienceLevel(level) || guessExperienceFromTitle(titleText),
            employmentType: null, // Google doesn't publish this on the results page
            department: null,
            postedAt: null,
        });
    }

    return jobs;
}

class GoogleAdapter extends JobSource {
    static type = 'google';
    static describe = {
        help: 'Google careers, server-rendered. Verified 2026-08-05.',
        required: {},
        optional: { location: "location filter as Google spells it, e.g. 'Telavivhaifa Israel'" },
    };

    constructor(config = {}) {
        super();
        this.location = config.location || 'Israel';
    }

    buildUrl(page) {
        const params = new URLSearchParams({ location: this.location });
        if (page > 1) params.set('page', String(page));
        return `${BASE}/jobs/results/?${params}`;
    }

    async getCurrentJobs() {
        const all = [];
        const seen = new Set();

        for (let page = 1; page <= MAX_PAGES; page++) {
            const res = await fetch(this.buildUrl(page), { headers: HTML_HEADERS });
            if (!res.ok) {
                throw new Error(`Google fetch failed on page ${page}: ${res.status} ${res.statusText}`);
            }

            const html = await res.text();
            const jobs = parseGoogleJobs(html);

            if (page === 1 && jobs.length === 0) {
                throw new Error(
                    `Google page 1 parsed to 0 jobs from ${html.length} chars of HTML — ` +
                        'the markup probably changed. Re-run: node tools/probe.js "' + this.buildUrl(1) + '"'
                );
            }

            // Later pages returning nothing new is the normal end condition.
            const fresh = jobs.filter((j) => !seen.has(j.externalId));
            if (fresh.length === 0) break;

            for (const job of fresh) {
                seen.add(job.externalId);
                all.push(job);
            }

            if (jobs.length < PAGE_SIZE) break;
        }

        return all;
    }
}

module.exports = { GoogleAdapter, parseGoogleJobs };
