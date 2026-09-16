const { JobSource } = require('./JobSource');
const { decodeEntities, HTML_HEADERS } = require('./htmlUtils');
const { normalizeEmploymentType, guessExperienceFromTitle } = require('../domain/vocabulary');
const { locationTokens, isIsraeliLocation } = require('../domain/locations');
const { ScrapeError, FAILURE_KIND, classifyHttpStatus } = require('../domain/scrapeOutcome');
const { fetchWithRetry } = require('./httpRetry');

/**
 * Mobileye runs a Nuxt site that renders every open position server-side at
 * https://careers.mobileye.com/jobs — one page, no pagination.
 *
 * Verified against a real page fetched on 2026-09-16 (183 jobs parsed, no
 * blank fields, 214/246 already-stored jobs resolve to a real Israeli city).
 * See tests/fixtures/mobileye-jobs.html for the exact markup — refreshed
 * that day too, after the site's own redesign moved the title out of an
 * `<h3>` into `<p class="jobTitle">` with no announcement. The old regex
 * didn't error, it just matched nothing: every job on the page was being
 * stored with an empty title (an unclickable-looking card, indistinguishable
 * from a broken parser until someone actually looked at the page — see
 * docs/ROADMAP.md's Mobileye writeup). Re-probe this page before trusting
 * the markup again if titles ever look wrong.
 *
 * There is also a private API at careers-api.mbly.co (leaked in the page's Nuxt
 * config) but its routes aren't public. The server-rendered HTML is enough and
 * needs no reverse engineering, so we parse that.
 *
 * Mobileye's own page has no location/country filter of its own — it lists
 * every open role worldwide (Munich, Shanghai, Beijing, Tokyo, Koblenz,
 * Detroit, Los Angeles and Stuttgart all appeared in the same fetch as the
 * Israeli offices), which is honest of the source but wrong for a site
 * titled "משרות היי-טק בישראל". Filtered below the same way Greenhouse/
 * Comeet/SmartRecruiters fall back when no location is configured:
 * domain/locations.js's isIsraeliLocation whitelist.
 */

const BASE = 'https://careers.mobileye.com';
const LIST_URL = `${BASE}/jobs`;

/**
 * Pure parse: page HTML -> RawJob[]. Exported so it can be tested against a
 * saved fixture without touching the network.
 *
 * Anchored on the job URL shape and semantic tags (class="jobTitle",
 * class="department"), not on layout classes. Mobileye's markup is
 * hand-written and readable, which makes this far stabler than it would be
 * on a framework-generated page — but a hand-written site is exactly the
 * kind that gets a small class-name tweak with no version bump to notice,
 * which is what moved the title out of `<h3>` in the first place.
 *
 * A card whose title comes back empty is dropped rather than stored blank
 * — a job with no usable title is not data, it's an unclickable card. That
 * makes this function fail loud through the caller's own "0 jobs parsed"
 * check if the title markup ever shifts again: every card losing its title
 * means every card gets dropped, means 0 jobs, means a real error instead of
 * 183 blank cards no one notices until they scroll to one.
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

        const title = card.match(/class="jobTitle"[^>]*>([\s\S]*?)<\/p>/);
        const location = card.match(/location_icon\.svg[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/);
        const department = card.match(/class="department"[^>]*>([\s\S]*?)<\/p>/);
        // The second tag on each card is the commitment: "Full time",
        // "Contractor", "Temporary Full-time".
        const commitment = card.match(/commitment_icon\.svg[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/);

        const titleText = title ? decodeEntities(title[1]).trim() : '';
        if (!titleText) continue;

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

/** Whether a parsed job's raw location resolves to a real Israeli place —
 *  the fallback every generic-platform adapter uses when no location/country
 *  override is configured (see greenhouseAdapter.js's matchesLocation). */
function isIsraeliJob(job) {
    return locationTokens(job.location).some((token) => isIsraeliLocation(token));
}

class MobileyeAdapter extends JobSource {
    static type = 'mobileye';
    static describe = {
        help: 'Mobileye. Server-rendered, one page, worldwide postings filtered to Israel. Verified 2026-09-16.',
        required: {},
        optional: {},
    };

    async getCurrentJobs() {
        const res = await fetchWithRetry(LIST_URL, { headers: HTML_HEADERS }, { label: 'Mobileye' });
        if (!res.ok) {
            throw new ScrapeError(`Mobileye fetch failed: ${res.status} ${res.statusText}`, classifyHttpStatus(res.status));
        }

        const html = await res.text();
        const parsed = parseMobileyeJobs(html);

        // A parse that finds nothing on a page this size means the markup moved,
        // not that Mobileye closed every role. Fail loudly. ARCHITECTURE.md §4.2.
        // Checked BEFORE the location filter below: if the title markup breaks
        // again, every card gets dropped in parseMobileyeJobs and this is what
        // turns that into a real error instead of an empty-looking site.
        if (parsed.length === 0) {
            throw new Error(
                `Mobileye page parsed to 0 jobs from ${html.length} chars of HTML — ` +
                    'the markup probably changed. Re-run: node tools/probe.js "' + LIST_URL + '"'
            );
        }

        // The page itself has no location/country filter — it lists every open
        // role worldwide. No `location`/`country` config to override this with:
        // Mobileye is one company, not a generic platform, and every job this
        // adapter has ever been asked to serve is meant to be an Israeli one.
        const jobs = parsed.filter(isIsraeliJob);

        if (jobs.length === 0) {
            throw new ScrapeError(
                `Mobileye returned ${parsed.length} jobs but none resolved to an Israeli location — ` +
                    'check domain/locations.js against the real location strings, or re-run: ' +
                    `node tools/probe.js "${LIST_URL}"`,
                FAILURE_KIND.EMPTY
            );
        }

        return jobs;
    }
}

module.exports = { MobileyeAdapter, parseMobileyeJobs, isIsraeliJob };
