/**
 * The four things a company can fail to report cleanly in a scrape cycle —
 * and why "5 failures" stopped meaning anything (see the note in
 * server/services/scrapeService.js and server/main.js on why a run used to
 * go red for the same reason every single time).
 *
 *   broken   the adapter or the site did something unexpected — a real fault
 *   blocked  the site refused us on purpose (403/429/bot protection)
 *   empty    the adapter ran fine; this company genuinely has no matching
 *            jobs right now — see the adapters' own "returned N but none
 *            matched" throws, which stay throws on purpose (CLAUDE.md's Snyk/
 *            Broadcom/Syneron-Candela notes): a zero can equally mean "the
 *            facet lookup broke", so it is still reported loudly, just under
 *            its own kind instead of indistinguishable from a real fault
 *   refused  the sanity gate (scrapeSanity.js) rejected a suspiciously small
 *            result rather than trust it
 */
const FAILURE_KIND = Object.freeze({
    BROKEN: 'broken',
    BLOCKED: 'blocked',
    EMPTY: 'empty',
    REFUSED: 'refused',
});

/** Kinds that mean "a person should look at this" by default — see
 * scrapeService.js's known-issue acknowledgment and refusal-streak escalation
 * for the two ways a failure can move between this set and the quiet one. */
const LOUD_KINDS = new Set([FAILURE_KIND.BROKEN, FAILURE_KIND.BLOCKED]);

/**
 * Thrown at the exact point a failure is understood — an adapter that knows
 * it got a 403, or knows a zero-result is the deliberate "ran fine, nothing
 * matched" case — rather than reconstructed later by an outer catch block
 * guessing from a message string. A classifier that greps error text breaks
 * the first time someone rewords a message; this doesn't need to guess
 * because the kind travels with the error.
 *
 * `kind` defaults to BROKEN: an adapter that still just throws a plain
 * `Error` (most of them, for "the site changed shape") is exactly the case
 * that SHOULD go red, so "unclassified" and "broken" are deliberately the
 * same value rather than two states that could drift apart.
 */
class ScrapeError extends Error {
    constructor(message, kind = FAILURE_KIND.BROKEN) {
        super(message);
        this.name = 'ScrapeError';
        this.kind = kind;
    }
}

/** 403/429 are the site refusing on purpose; anything else not-ok is a fault. */
function classifyHttpStatus(status) {
    return status === 403 || status === 429 ? FAILURE_KIND.BLOCKED : FAILURE_KIND.BROKEN;
}

/**
 * Read a JSON response, and recognise the block page pretending to be one.
 *
 * `classifyHttpStatus` catches a site that refuses honestly, with a 403 or 429.
 * A bot-protection layer or WAF very often does not: it answers **200 with an
 * HTML challenge or block page**, because a browser is supposed to render it.
 * The adapter sees a success status, calls `.json()`, and gets
 * `Unexpected token '<'` — which is indistinguishable, to the classifier, from
 * the site having genuinely changed its API.
 *
 * That happened to Keter: the endpoint returns clean JSON from a laptop and
 * HTML from a GitHub runner. Classified as `broken` it turned every run red,
 * and the only way to quieten it would have been to acknowledge `broken` for
 * that company — which would also have silenced a real future breakage there.
 * The kind has to be right; muting is not a substitute for classifying.
 *
 * HTML where JSON was promised is a block far more often than it is a genuine
 * API change, and the two are told apart cheaply: a real API change usually
 * still returns JSON, of a different shape, which the adapters already check
 * for separately.
 *
 * @param {Response} res a fetch response already known to be ok
 * @param {string} label what to call this endpoint in the error
 */
async function parseJsonResponse(res, label) {
    const text = await res.text();
    const start = text.trimStart().slice(0, 1);

    if (start === '<') {
        throw new ScrapeError(
            `${label} returned HTML where JSON was expected — almost certainly a bot-protection ` +
                'or block page. The same endpoint may work from a home connection and be refused ' +
                'from a datacenter address.',
            FAILURE_KIND.BLOCKED
        );
    }

    try {
        return JSON.parse(text);
    } catch (err) {
        throw new ScrapeError(`${label} did not return valid JSON: ${err.message}`, FAILURE_KIND.BROKEN);
    }
}

/** @param {Error} err @returns {string} one of FAILURE_KIND's values */
function classifyFailure(err) {
    return err && Object.values(FAILURE_KIND).includes(err.kind) ? err.kind : FAILURE_KIND.BROKEN;
}

/**
 * Whether a company reporting this kind should turn the whole run red.
 * `empty` and `refused` are quiet by design — see the notes on FAILURE_KIND
 * above and on the sanity gate's refusal-streak escalation, which is exactly
 * how a `refused` that has gone on too long stops being quiet: it gets
 * reported as `broken` from then on, not by this function treating `refused`
 * specially.
 *
 * @param {string} kind
 * @param {string|null} [knownIssueKind] this company's acknowledged kind
 *   (watched_companies.known_issue_kind), if any
 */
function shouldGoRed(kind, knownIssueKind = null) {
    return LOUD_KINDS.has(kind) && kind !== knownIssueKind;
}

module.exports = {
    FAILURE_KIND,
    LOUD_KINDS,
    ScrapeError,
    classifyHttpStatus,
    parseJsonResponse,
    classifyFailure,
    shouldGoRed,
};
