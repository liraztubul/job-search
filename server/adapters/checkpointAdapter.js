const { JobSource } = require('./JobSource');
const { decodeEntities, HTML_HEADERS } = require('./htmlUtils');
const { guessExperienceFromTitle } = require('../domain/vocabulary');
const { ScrapeError, classifyHttpStatus } = require('../domain/scrapeOutcome');

/**
 * Check Point's own careers portal (careers.checkpoint.com) — a bespoke PHP
 * site ("cpcareers" module) backed by Solr, not a recruiting platform anyone
 * else uses. Server-rendered, 10 jobs per page.
 *
 * Verified against a live response on 2026-08-06. The country filter isn't a
 * documented query parameter — it's a Solr facet value discovered by hitting
 * the site's own autocomplete endpoint:
 *
 *   GET /ajax/getJobs.php?input=israel
 *   -> {"category":"Location","label":"Israel","filter":"country_s:Israel",...}
 *
 * That `filter` string is what the site's own JS puts on the search URL as
 * `fa[]=country_s:Israel`. Skipping the autocomplete step and guessing at
 * `country_s` from the field name alone would have worked here, but the
 * facet value casing/spelling is exactly what the site emits — safer to read
 * it than assume it.
 */

const BASE = 'https://careers.checkpoint.com';
const PAGE_SIZE = 10;
const MAX_PAGES = 30;

/** Pure parse: one results page of HTML -> RawJob[]. */
function parseCheckpointJobs(html) {
    const jobs = [];
    const seen = new Set();

    const cardRe =
        /<a href="https:\/\/careers\.checkpoint\.com\/index\.php\?m=cpcareers&a=show&joborderid=(\d+)">\s*([^<]*?)\s*<\/a>[\s\S]{0,300}?class="place">\s*([^<]*?)\s*<\/p>[\s\S]{0,150}?class="briefcase">\s*([^<]*?)\s*<span/g;

    let match;
    while ((match = cardRe.exec(html)) !== null) {
        const [, id, title, location, department] = match;
        if (seen.has(id)) continue;
        seen.add(id);

        const titleText = decodeEntities(title);

        jobs.push({
            externalId: id,
            title: titleText,
            location: decodeEntities(location),
            department: decodeEntities(department),
            applyUrl: `${BASE}/index.php?m=cpcareers&a=show&joborderid=${id}`,
            employmentType: null, // not published on the results page
            experienceLevel: guessExperienceFromTitle(titleText),
            postedAt: null,
        });
    }

    return jobs;
}

class CheckpointAdapter extends JobSource {
    static type = 'checkpoint';
    static describe = {
        help: 'Check Point careers portal, server-rendered. Verified 2026-08-06.',
        required: {},
        optional: { country: "Solr facet value as the site's own autocomplete spells it, e.g. 'Israel'" },
    };

    constructor(config = {}) {
        super();
        this.country = config.country || 'Israel';
    }

    buildUrl(start) {
        const params = new URLSearchParams({ module: 'cpcareers', a: 'search', q: '', start: String(start) });
        params.append('fa[]', `country_s:${this.country}`);
        return `${BASE}/index.php?${params}`;
    }

    async getCurrentJobs() {
        const all = [];
        const seen = new Set();

        for (let page = 0; page < MAX_PAGES; page++) {
            const start = page * PAGE_SIZE;
            const res = await fetch(this.buildUrl(start), { headers: HTML_HEADERS });
            if (!res.ok) {
                throw new ScrapeError(
                    `Check Point fetch failed on start=${start}: ${res.status} ${res.statusText}`,
                    classifyHttpStatus(res.status)
                );
            }

            const html = await res.text();
            const jobs = parseCheckpointJobs(html);

            if (page === 0 && jobs.length === 0) {
                throw new Error(
                    `Check Point page 1 parsed to 0 jobs from ${html.length} chars of HTML — ` +
                        'the markup probably changed, or "' + this.country + '" matched no Solr facet. ' +
                        'Re-run: node tools/probe.js "' + this.buildUrl(0) + '"'
                );
            }

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

module.exports = { CheckpointAdapter, parseCheckpointJobs };
