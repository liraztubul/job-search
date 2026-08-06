/**
 * Shared helpers for adapters that parse HTML instead of calling a JSON API.
 *
 * Deliberately not a base class. Adapters differ enough that inheritance would
 * force shared structure where there isn't any; a couple of small functions
 * give the reuse without the coupling.
 *
 * NOTE: this file is not named `*Adapter.js`, so the registry ignores it.
 */

const ENTITIES = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
};

/** Turn `Q&amp;A  Engineer` into `Q&A Engineer`. */
function decodeEntities(text) {
    return String(text)
        .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m])
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/\s+/g, ' ')
        .trim();
}

/** Strip tags from a fragment and collapse whitespace. */
function stripTags(html) {
    return decodeEntities(String(html).replace(/<[^>]*>/g, ' '));
}

/**
 * Career sites routinely return nothing to a default Node User-Agent. Looking
 * like a browser is the difference between "blocked" and "works" on several of
 * these — see tools/probe.js, where the same headers are used.
 */
const HTML_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
};

module.exports = { decodeEntities, stripTags, HTML_HEADERS };
