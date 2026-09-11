/**
 * The decision half of "retry a 429" — should this response be retried, and
 * for how long. The actual fetch (and the actual waiting) is I/O and lives in
 * server/adapters/httpRetry.js; nothing here touches the network, a clock
 * side effect, or a timer, so all of it is unit-testable with a fixed `now`.
 *
 * WHY ONLY 429 AND 503
 *
 * Both mean "try again, not never" — a rate limit and a temporarily
 * overloaded server. Everything else this project sees is a refusal (403),
 * a bot-protection block dressed as 200 (see parseJsonResponse in
 * scrapeOutcome.js), or a genuine break — none of those change on a second
 * attempt a few seconds later, and retrying them is exactly the behaviour
 * that earns a rate limit in the first place.
 */
const RETRYABLE_STATUSES = new Set([429, 503]);

/** Up to this many attempts total (the first try plus retries) before giving
 * up and letting the caller's normal classification (classifyHttpStatus)
 * decide the final failure kind from whatever response came back last. */
const MAX_ATTEMPTS = 3;

/** No single wait is allowed to run longer than this — a `Retry-After: 3600`
 * must not hang a workflow for an hour. A wait beyond this is treated as
 * "not now": stop retrying and report the failure this cycle, let the next
 * scheduled cycle (a few hours away regardless) try again. */
const MAX_WAIT_MS = 60_000;

/** The base for exponential backoff when the site doesn't say how long to
 * wait — 2s, 4s, doubling each attempt, unrelated to Task 1's pacing gap
 * (same order of magnitude on purpose, so a retry doesn't look like a burst
 * either). */
const BACKOFF_BASE_MS = 2_000;

function shouldRetryStatus(status) {
    return RETRYABLE_STATUSES.has(status);
}

/**
 * `Retry-After` per RFC 9110 §10.2.3 is either a number of seconds, or an
 * HTTP-date to wait until. Returns null for anything absent or unparseable —
 * a header that doesn't parse is not evidence of how long to wait, so the
 * caller falls back to backoff rather than trusting a garbage number.
 *
 * @param {string|null|undefined} headerValue
 * @param {Date} [now]
 * @returns {number|null} milliseconds to wait, or null
 */
function parseRetryAfterMs(headerValue, now = new Date()) {
    if (!headerValue) return null;
    const trimmed = String(headerValue).trim();

    // Pure digits: seconds, the common case for a rate limiter.
    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed) * 1000;
    }

    // Otherwise an HTTP-date. Date.parse handles the RFC 7231 IMF-fixdate
    // format ("Wed, 21 Oct 2026 07:28:00 GMT") that Retry-After uses.
    const asDate = Date.parse(trimmed);
    if (Number.isNaN(asDate)) return null;

    const deltaMs = asDate - now.getTime();
    // A date in the past (clock skew, or "wait until a moment that already
    // passed") means "you can try again now" — 0, not a negative wait.
    return Math.max(0, deltaMs);
}

/**
 * The actual decision: given this attempt number (0 = the first retry, i.e.
 * the original request already failed once) and what the response said,
 * should there be another attempt, and after how long.
 *
 * @param {object} params
 * @param {number} params.attempt 0-indexed retry number (not total attempts)
 * @param {string|null} [params.retryAfterHeader] the raw header value, if present
 * @param {Date} [params.now]
 * @returns {{shouldWait: true, delayMs: number} | {shouldWait: false, reason: string}}
 */
function computeRetryDelay({ attempt, retryAfterHeader = null, now = new Date() }) {
    if (attempt >= MAX_ATTEMPTS - 1) {
        return { shouldWait: false, reason: `already made ${MAX_ATTEMPTS} attempts` };
    }

    const fromHeader = parseRetryAfterMs(retryAfterHeader, now);
    if (fromHeader != null) {
        if (fromHeader > MAX_WAIT_MS) {
            return { shouldWait: false, reason: `Retry-After (${Math.round(fromHeader / 1000)}s) exceeds the ${MAX_WAIT_MS / 1000}s cap` };
        }
        return { shouldWait: true, delayMs: fromHeader };
    }

    // No usable Retry-After — exponential backoff, still capped.
    const backoff = BACKOFF_BASE_MS * 2 ** attempt;
    return { shouldWait: true, delayMs: Math.min(backoff, MAX_WAIT_MS) };
}

/** A real delay — setTimeout has no side effect on anything outside its own
 * timer, so this is fine to keep in domain/ alongside pure decision logic;
 * the actual `fetch` that needed the wait does not belong here. */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    RETRYABLE_STATUSES,
    MAX_ATTEMPTS,
    MAX_WAIT_MS,
    BACKOFF_BASE_MS,
    shouldRetryStatus,
    parseRetryAfterMs,
    computeRetryDelay,
    sleep,
};
