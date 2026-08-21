const { JobSource } = require('./JobSource');
const { decodeEntities, HTML_HEADERS } = require('./htmlUtils');
const { normalizeEmploymentType, guessExperienceFromTitle } = require('../domain/vocabulary');
const { ScrapeError, classifyHttpStatus } = require('../domain/scrapeOutcome');

/**
 * Mobileye runs a Nuxt site that renders every open position server-side at
 * https://careers.mobileye.com/jobs — one page, no pagination, ~138 jobs.
 *
 * Verified against a real page saved on 2026-08-05 (138 jobs parsed, no blank
 * fields). See tests/fixtures/mobileye-jobs.html for the exact markup.
 *
 * There is also a private API at careers-api.mbly.co (leaked in the page's Nuxt
 * config) but its routes aren't public. The server-rendered HTML is enough and
 * needs no reverse engineering, so we parse that.
 */

const BASE = 'https://careers.mobileye.com';
const LIST_URL = `${BASE}/jobs`;

/**
 * Pure parse: page HTML -> RawJob[]. Exported so it can be tested against a
 * saved fixture without touching the network.
 *
 * Anchored on the job URL shape and semantic tags (<h3>, class="department"),
 * not on layout classes. Mobileye's markup is hand-written and readable, which
 * makes this far stabler than it would be on a framework-generated page.
 */
function parseMobileyeJobs(html) {
    const jobs = [];
    const seen = new Set();

    // Each card links to /jobs/<slug>/<uuid>. The uuid is the stable id.
    // Cards appear twice (mobile + desktop layouts), hence the dedupe.
    const linkRe = /href="\/jobs\/([a-z0-9-]+)\/([0-9a-f-]{36})"/g;

    let match;
    while ((match = linkRe.exec(html)) !== null) {
        const [, slug, uuid] = match;
        if (seen.has(uuid)) continue;
        seen.add(uuid);

        // Everything for one card lives shortly after its link.
        const card = html.slice(match.index, match.index + 4000);

        const title = card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
        const location = card.match(/location_icon\.svg[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/);
        const department = card.match(/class="department"[^>]*>([\s\S]*?)<\/p>/);
        // The second tag on each card is the commitment: "Full time",
        // "Contractor", "Temporary Full-time".
        const commitment = card.match(/commitment_icon\.svg[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/);

        const titleText = title ? decodeEntities(title[1]) : '';

        jobs.push({
            externalId: uuid,
            title: titleText,
            location: location ? decodeEntities(location[1]) : '',
            department: department ? decodeEntities(department[1]) : '',
            applyUrl: `${BASE}/jobs/${slug}/${uuid}`,
            employmentType: normalizeEmploymentType(commitment ? decodeEntities(commitment[1]) : null),
            // Mobileye doesn't publish a seniority field, so this is inferred
            // from the title and will often be null. That's honest — better an
            // empty filter than a confident wrong one.
            experienceLevel: guessExperienceFromTitle(titleText),
            postedAt: null,
        });
    }

    return jobs;
}

class MobileyeAdapter extends JobSource {
    static type = 'mobileye';
    static describe = {
        help: 'Mobileye. Server-rendered, one page, all locations. Verified 2026-08-05.',
        required: {},
        optional: {},
    };

    async getCurrentJobs() {
        const res = await fetch(LIST_URL, { headers: HTML_HEADERS });
        if (!res.ok) {
            throw new ScrapeError(`Mobileye fetch failed: ${res.status} ${res.statusText}`, classifyHttpStatus(res.status));
        }

        const html = await res.text();
        const jobs = parseMobileyeJobs(html);

        // A parse that finds nothing on a page this size means the markup moved,
        // not that Mobileye closed every role. Fail loudly. ARCHITECTURE.md §4.2.
        if (jobs.length === 0) {
            throw new Error(
                `Mobileye page parsed to 0 jobs from ${html.length} chars of HTML — ` +
                    'the markup probably changed. Re-run: node tools/probe.js "' + LIST_URL + '"'
            );
        }

        return jobs;
    }
}

module.exports = { MobileyeAdapter, parseMobileyeJobs };
