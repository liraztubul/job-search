/**
 * "Is this listing actually still there" — from an HTTP status code and, for
 * a 200, a snippet of the response body. Pure: no network, no database, no
 * import from the rest of the project. server/services/jobVerifyService.js
 * does the actual fetching; this only decides what the answer means.
 *
 * WHY A BODY CHECK AT ALL
 *
 * A 404/410 status is the clean case, but several career platforms return a
 * plain 200 for an expired posting's URL and render a "this job is gone" page
 * client-side instead — a status-code-only check would treat every one of
 * these as open forever.
 *
 * WHY THE PHRASE LIST IS THIS SHORT
 *
 * Every phrase below was checked against a REAL closed posting's fetched HTML
 * (captured 2026-08-19, saved verbatim under tests/fixtures/) and confirmed
 * ABSENT from a real, currently-open posting on the same platform — see
 * jobAvailability.test.js. Two platforms were investigated and rejected
 * specifically because they failed that second check:
 *
 *   - Apple (jobs.apple.com): the closed page's visible "this role does not
 *     exist" text is also present, verbatim, buried in a JSON translation
 *     bundle (`jobsite.error.noRoleFound`) that ships on EVERY job page,
 *     open or closed — a plain substring match would have closed every real
 *     Apple listing on the site. Confirmed by fetching a genuinely open
 *     Apple posting and finding the same string.
 *   - Qualcomm/Eightfold (careers.qualcomm.com): the fetched HTML is a bare
 *     SPA shell with no job-specific server-rendered content at all — the
 *     "expired"/"no longer" text found there turned out to belong to a
 *     generic, always-present client-side auth-form string bundle
 *     ("Your password has expired"), unrelated to the job itself.
 *
 * Workday, Ashby, Greenhouse (via a company's own proxy page) and Elbit's own
 * site were also checked and are pure client-rendered shells with no
 * detectable signal in the raw fetched HTML either way — a real closed
 * posting on each returned an empty-looking shell, not an error message.
 * These platforms fall through to `'unknown'` here, same as a timeout would.
 *
 * No Hebrew phrase is included: none of the Israel-specific sites checked
 * (a WordPress-based one included) rendered any closure message server-side
 * for a job already known to be closed — the page simply re-rendered the
 * stale post content with a 200. Guessing a Hebrew phrase with no real
 * example to check it against risks exactly the false positive this list
 * exists to avoid, so none is included.
 *
 * A FALSE "CLOSED" IS THE WORSE MISTAKE
 *
 * It deletes a real, currently-open job from the site for every visitor, and
 * the mistake is invisible until someone who wanted that exact listing can't
 * find it. A false "open" (or "unknown") costs one visitor one wasted click.
 * The list stays short and specific because of that asymmetry, not despite it.
 *
 * BOT PROTECTION IS NEVER "GONE" — IT'S THE ONE CASE THIS MODULE MUST NEVER MISS
 *
 * A handful of company sites (Rafael, Israel Aerospace Industries — see
 * CLAUDE.md) sit behind Reblaze or a similar bot-management product and
 * refuse automated requests outright. That refusal (a 403, a 429, a CAPTCHA
 * or "checking your browser" challenge page) looks exactly like "this URL is
 * bad" from the outside — but it means "this site is blocking the request,"
 * never "this posting doesn't exist." `looksLikeBotProtection` below is
 * checked FIRST, before anything else, specifically so this case can never
 * fall through to a "gone" verdict — including if a future addition to
 * GONE_PHRASES happened to also appear on a challenge page. `rbzns` and
 * `perfdrive` are Reblaze's own client-side markers, confirmed present on
 * Rafael's and IAI's real pages (see CLAUDE.md's notes on both).
 *
 * This is the general-purpose net. server/services/jobVerifyService.js has
 * its own, stricter guard on top: any company on the `manual` adapter
 * (Rafael today) is never fetched at all, because that's precisely the
 * situation this section describes and there's nothing to gain by making the
 * blocked request in the first place.
 */

const GONE_STATUS_CODES = new Set([404, 410]);

const BOT_PROTECTION_STATUS_CODES = new Set([403, 429]);

/**
 * Lowercase markers. Each either a documented, previously-confirmed signature
 * (Reblaze's `rbzns`/`perfdrive`, seen on Rafael and IAI — see CLAUDE.md) or a
 * generic challenge-page phrase common across bot-management vendors, never
 * legitimate content on a job posting page either way.
 */
const BOT_PROTECTION_MARKERS = [
    'rbzns',
    'perfdrive',
    'captcha',
    'checking your browser',
    'verify you are human',
    'attention required',
];

/** @param {{status: number, body?: string}} response */
function looksLikeBotProtection({ status, body }) {
    if (BOT_PROTECTION_STATUS_CODES.has(status)) return true;
    if (typeof body !== 'string' || !body) return false;
    const lower = body.toLowerCase();
    return BOT_PROTECTION_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Lowercase phrases, each verified against a real captured page — see the
 * header comment above and jobAvailability.test.js for the fixture each one
 * comes from.
 */
const GONE_PHRASES = [
    // Mobileye (careers.mobileye.com) — captured from a real closed posting
    // ("Product Execution Manager"); the site's own copy has a typo
    // ("avavilable"), so the phrase stops short of that word on purpose.
    // Confirmed absent from a real, currently-open Mobileye posting.
    'this position is no longer',
    // Google (google.com/about/careers) — captured from a real closed
    // posting ("Senior SOC DFT Engineer, Google Cloud"). Confirmed absent
    // from a real, currently-open Google posting and from the general
    // careers listing page.
    'this job may have been taken down',
];

/** @param {unknown} body */
function bodyIndicatesGone(body) {
    if (typeof body !== 'string' || !body) return false;
    const lower = body.toLowerCase();
    return GONE_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * @param {{status: number, body?: string}} response
 * @returns {'open'|'gone'|'unknown'}
 *
 * 'unknown' is the deliberate default for anything not confidently one of
 * the other two — a 5xx, a 3xx (the caller's `fetch` already follows
 * redirects, so a bare 3xx reaching here means something unusual happened,
 * not a page it's safe to call open), a platform whose closure page carries
 * no detectable signal, or bot protection (checked first — see the header
 * comment). The caller (jobVerifyService.js) treats 'unknown' the same as a
 * network failure: never close a job on a shrug.
 */
function evaluateAvailability(response) {
    if (looksLikeBotProtection(response)) return 'unknown';

    const { status, body } = response;
    if (GONE_STATUS_CODES.has(status)) return 'gone';
    if (status === 200 && bodyIndicatesGone(body)) return 'gone';
    if (status >= 200 && status < 300) return 'open';
    return 'unknown';
}

module.exports = {
    evaluateAvailability,
    bodyIndicatesGone,
    looksLikeBotProtection,
    GONE_PHRASES,
    GONE_STATUS_CODES,
    BOT_PROTECTION_STATUS_CODES,
    BOT_PROTECTION_MARKERS,
};
