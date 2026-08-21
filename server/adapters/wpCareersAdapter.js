const { JobSource } = require('./JobSource');
const { decodeEntities, HTML_HEADERS } = require('./htmlUtils');
const { guessExperienceFromTitle } = require('../domain/vocabulary');
const { ScrapeError, classifyHttpStatus, parseJsonResponse } = require('../domain/scrapeOutcome');

/**
 * WordPress sites that publish jobs as a custom post type with a taxonomy for
 * location — a common shape for Israeli SMB/industrial career sites built on
 * a stock "job board" plugin rather than a real ATS. Verified against Keter's
 * Israel careers site (careers.ketergroup.com) on 2026-08-11: its post type
 * is `careers`, its location taxonomy `job_locall` (their own typo, kept
 * as-is since it's the real slug), listed at
 *
 *   GET https://{host}/wp-json/wp/v2/{postType}?per_page=100&_embed=true
 *
 * `_embed=true` is what resolves the taxonomy term id into a human-readable
 * name inline — without it every posting's location is just a numeric term
 * id, useless for filtering or display.
 *
 * This is a generic WordPress REST shape, not a platform with its own brand
 * name — every field name (`postType`, `locationTaxonomy`) is configuration
 * because the next WP-based company probably spells its own post type and
 * taxonomy differently. There's no server-side country filter to ask for;
 * a site like this is usually already the company's own dedicated Israel
 * careers subdomain, so no client-side location filtering is applied either
 * — every posting on it is returned as-is.
 */
class WpCareersAdapter extends JobSource {
    static type = 'wp-careers';
    static describe = {
        help: "WordPress career sites publishing jobs as a custom post type. Verified against Keter's Israel careers site on 2026-08-11.",
        required: {
            host: "the site's hostname, e.g. 'careers.ketergroup.com'",
            postType: "the custom post type's REST base, e.g. 'careers' — check /wp-json/wp/v2/types",
        },
        optional: {
            locationTaxonomy: "taxonomy slug that carries the office/city, e.g. 'job_locall' — check /wp-json/wp/v2/taxonomies. Omit to leave location blank.",
        },
    };

    constructor(config = {}) {
        super();
        this.host = config.host;
        this.postType = config.postType;
        this.locationTaxonomy = config.locationTaxonomy || '';
    }

    get postingsUrl() {
        return `https://${this.host}/wp-json/wp/v2/${encodeURIComponent(this.postType)}?per_page=100&_embed=true`;
    }

    async getCurrentJobs() {
        const res = await fetch(this.postingsUrl, { headers: HTML_HEADERS });
        if (!res.ok) {
            throw new ScrapeError(
                `WordPress careers fetch failed for ${this.host}: ${res.status} ${res.statusText}`,
                classifyHttpStatus(res.status)
            );
        }

        const data = await parseJsonResponse(res, 'WordPress careers');
        if (!Array.isArray(data)) {
            throw new Error(`WordPress careers response shape changed for ${this.host}: expected an array, got ${typeof data}`);
        }

        return data.map((post) => mapWpCareersPost(post, this.locationTaxonomy));
    }
}

/** Pull the human name of a taxonomy term out of `_embed`'s `wp:term` groups. */
function embeddedTermName(post, taxonomy) {
    if (!taxonomy) return '';
    const groups = post._embedded?.['wp:term'] || [];
    const term = groups.flat().find((t) => t.taxonomy === taxonomy);
    return term ? decodeEntities(term.name) : '';
}

/** Pure mapping: one WordPress REST post -> RawJob. */
function mapWpCareersPost(post, locationTaxonomy) {
    const externalId = post.id != null ? String(post.id) : null;
    if (!externalId) {
        throw new Error(`WordPress careers post has no id: ${JSON.stringify(post).slice(0, 120)}`);
    }

    const title = decodeEntities(post.title?.rendered || '');

    return {
        externalId,
        title,
        location: embeddedTermName(post, locationTaxonomy),
        applyUrl: post.link,
        department: null,
        employmentType: null, // not a field this shape publishes
        experienceLevel: guessExperienceFromTitle(title),
        postedAt: post.date ? post.date.slice(0, 10) : null,
    };
}

module.exports = { WpCareersAdapter, mapWpCareersPost, embeddedTermName };
