/**
 * "How new is this job" — one pure function, so the frontend never
 * reimplements the rule and every caller (API response, tests) gets the same
 * answer for the same inputs.
 *
 * THE THREE-WAY date_source CONTRACT
 *
 *   "source"     real first-published date from the ATS   "פורסם ב-…"   eligible for is_new
 *   "first_seen" our own first sighting, company established   "נוסף ב-…"    eligible for is_new
 *   "unknown"    job predates our coverage of this company     (nothing)     never new
 *
 * "unknown" exists for one reason: the new-company trap. The day a company is
 * first added, its entire back catalogue gets first_seen_at = now — a job
 * posted eight months ago looks brand new by that measure alone. A company's
 * `first_scraped_at` (set once, at the end of its first successful cycle) is
 * the line: a job first seen at or before that moment came from the initial
 * bulk load and its true age is simply unknown. Silence, not a guess.
 *
 * CALENDAR DAYS, NOT ELAPSED MILLISECONDS
 *
 * `posted_at` is a bare date (YYYY-MM-DD, no time of day — that's the
 * precision every adapter actually has). Diffing it against `now` as raw
 * instants would silently depend on what time of day "now" is and would drift
 * by an hour across Israel's DST transition — a job could flip from "new" to
 * "not new" overnight for no reason connected to the calendar. Instead both
 * sides are reduced to a YYYY-MM-DD calendar date *in Asia/Jerusalem* first,
 * and compared in whole days. That also means there is no sub-day precision
 * to promise here: "posted today" and "posted 3 days ago" are both simply
 * `daysAgo <= 3`.
 */

const TIME_ZONE = 'Asia/Jerusalem';
const FRESH_WINDOW_DAYS = 3;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @returns {string} YYYY-MM-DD for `date` as a calendar date in Asia/Jerusalem. */
function zonedDateString(date) {
    // en-CA is the common trick for Intl to hand back Y-M-D order directly.
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date);
}

/** Whole calendar days from date string `a` to date string `b` (both YYYY-MM-DD). */
function daysBetween(a, b) {
    const toUtcDays = (isoDate) => {
        const [y, m, d] = isoDate.split('-').map(Number);
        return Date.UTC(y, m - 1, d) / 86400000;
    };
    return toUtcDays(b) - toUtcDays(a);
}

/**
 * @param {object} job
 * @param {string|null} job.postedAt        YYYY-MM-DD or null — must already be
 *   a real ISO date by the time it reaches here (see data/jobs.js's write-layer
 *   guard); this function still treats anything else as absent rather than
 *   throwing, because a pure function should never crash on bad input, it
 *   should answer honestly.
 * @param {string} job.firstSeenAt          full ISO timestamp, always present
 * @param {string|null} companyFirstScrapedAt  full ISO timestamp or null
 * @param {Date} [now]                      injectable for tests
 * @returns {{displayDate: string|null, dateSource: 'source'|'first_seen'|'unknown', isNew: boolean}}
 */
function computeFreshness({ postedAt, firstSeenAt }, companyFirstScrapedAt, now = new Date()) {
    const today = zonedDateString(now);

    const postedIsRealDate = typeof postedAt === 'string' && ISO_DATE_RE.test(postedAt);
    // A future date isn't wrong to store, but showing "פורסם ב-" for a date
    // that hasn't happened yet is a claim the source didn't actually make (or
    // more likely, a feed bug) — clamp it to absent rather than display it.
    // daysBetween(today, postedAt) is positive when postedAt comes AFTER
    // today — that's the future case.
    const postedIsFuture = postedIsRealDate && daysBetween(today, postedAt) > 0;

    if (postedIsRealDate && !postedIsFuture) {
        const daysAgo = daysBetween(postedAt, today);
        return { displayDate: postedAt, dateSource: 'source', isNew: daysAgo <= FRESH_WINDOW_DAYS };
    }

    const firstSeenDate = zonedDateString(new Date(firstSeenAt));
    const bulkLoadCutoff = companyFirstScrapedAt ? zonedDateString(new Date(companyFirstScrapedAt)) : null;

    // No company cutoff recorded at all, or this job's first sighting was at
    // or before it: it came in with the initial bulk load (or the cutoff was
    // never set, which is the more conservative case — treat it the same way,
    // since "we don't know when this company started being tracked" is itself
    // a reason not to trust a first_seen-based age).
    const fromInitialBulkLoad = !bulkLoadCutoff || firstSeenDate <= bulkLoadCutoff;
    if (fromInitialBulkLoad) {
        return { displayDate: null, dateSource: 'unknown', isNew: false };
    }

    const daysAgo = daysBetween(firstSeenDate, today);
    return { displayDate: firstSeenAt, dateSource: 'first_seen', isNew: daysAgo <= FRESH_WINDOW_DAYS };
}

/**
 * The write-layer guard: is `value` safe to store as posted_at at all?
 *
 * The invariant ("real ISO date or null, never anything else — see
 * data/jobs.js) is enforced here rather than trusted from each adapter,
 * because an adapter author remembering to validate is exactly the kind of
 * discipline that eventually lapses. A relative string ("Posted 3 Days Ago"),
 * a last-modified timestamp mistaken for one, or a future date all fail this
 * check the same way a malformed one does.
 *
 * @param {unknown} value
 * @param {Date} [now] injectable for tests
 */
function isValidPostedAt(value, now = new Date()) {
    if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
    return daysBetween(zonedDateString(now), value) <= 0;
}

module.exports = { computeFreshness, isValidPostedAt, FRESH_WINDOW_DAYS, TIME_ZONE };
