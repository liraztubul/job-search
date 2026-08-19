/**
 * "Is this specific job still there" — the one-click version of the scrape.
 *
 * Scraping all 37 sites on every page load isn't viable (minutes per request,
 * and every visitor's refresh becomes a burst of traffic nobody asked for),
 * but checking the ONE job someone is actually about to open is a single
 * request. On a confident "gone" it closes the job through the exact same
 * `closeMissingJobs` path the scheduled scrape uses, so one visitor's click
 * benefits everyone's next search — not just their own.
 */

const data = require('../data');
const { evaluateAvailability, GONE_STATUS_CODES } = require('../domain/jobAvailability');

const TIMEOUT_MS = 5000;
// Honest and identifiable, the same courtesy the scheduled scrape extends —
// this project has been deliberate about not looking like it's hiding what
// it is from the sites it reads.
const USER_AGENT = 'JobTrailVerifyBot/1.0 (+https://jobtrail-0xhs.onrender.com; checks one link a visitor is about to open)';

/** One HTTP attempt, with a hard timeout. Never throws — a failure of any
 * kind (timeout, DNS, TLS, connection reset) comes back as null, which the
 * caller treats as "unknown," never as "gone." */
async function fetchOnce(url, method) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method,
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': USER_AGENT },
        });
        // No point reading a body off a HEAD response — there isn't one worth
        // trusting, and a confident status (404/410) is decided without it.
        const body = method === 'GET' ? await response.text().catch(() => '') : '';
        return { status: response.status, body };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * HEAD first — cheap, and several platforms answer a real 404/410 to it,
 * which needs no body to be confident about. Everything else falls through
 * to GET: a host that rejects HEAD outright (some career platforms 405/403
 * it), a HEAD that simply failed, or a 200 that needs its body read to catch
 * a soft "this position is no longer available" page.
 */
async function fetchWithFallback(url) {
    const head = await fetchOnce(url, 'HEAD');
    if (head && GONE_STATUS_CODES.has(head.status)) return head;
    return fetchOnce(url, 'GET');
}

/**
 * Companies tracked by hand (`tools/add-job.js`, `server/adapters/manualAdapter.js`)
 * are on that path FOR A REASON: their site refuses automated access. Rafael
 * sits behind Reblaze bot protection — a server-side fetch of a Rafael URL is
 * exactly the request Reblaze exists to block, so it would fail every single
 * time. Reading that failure as "gone" would mean the first visitor who
 * clicks a Rafael job closes it permanently, and the same would happen to
 * every future company added to `manual` for the identical reason.
 *
 * There is nothing to learn from a request already known to be refused, so
 * this is a hard exemption, not a best-effort classification — it is checked
 * BEFORE any fetch is attempted, not left to `jobAvailability.js` to notice
 * after the fact. (`jobAvailability.js`'s own bot-protection detection is the
 * second, general-purpose guard — for a company that isn't on `manual` yet
 * but starts fronting itself with the same kind of protection later.)
 */
const NEVER_VERIFY_ADAPTER_TYPES = new Set(['manual']);

/**
 * @param {number} jobId
 * @returns {Promise<{status: 'gone'|'open'|'unknown'|'not_found', job?: object}>}
 */
async function verifyJob(jobId) {
    const job = data.findJobById(jobId);
    if (!job) return { status: 'not_found' };

    // Already known closed — a previous verify, or the scheduled scrape,
    // already settled this. Nothing to fetch.
    if (!job.isStillOpen) return { status: 'gone', job };

    if (NEVER_VERIFY_ADAPTER_TYPES.has(job.companyAdapterType)) return { status: 'unknown', job };

    const response = await fetchWithFallback(job.applyUrl);
    // A timeout or network error is not evidence of anything — a slow server
    // is not a closed job, and the caller must never close on a shrug.
    if (!response) return { status: 'unknown', job };

    const verdict = evaluateAvailability(response);
    if (verdict !== 'gone') return { status: verdict, job };

    // Confident "gone." Close it through the same routine the scheduled
    // scrape uses (server/data/jobs.js's closeMissingJobs), not a second
    // implementation: every OTHER currently-open job at this company counts
    // as "seen," so only this one job closes.
    const stillOpen = data.listOpenExternalIds(job.companyId).filter((externalId) => externalId !== job.externalId);
    data.closeMissingJobs(job.companyId, stillOpen);

    return { status: 'gone', job };
}

module.exports = { verifyJob, TIMEOUT_MS };
