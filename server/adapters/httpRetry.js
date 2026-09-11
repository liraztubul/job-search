/**
 * The one place that calls `fetch` more than once for the same request.
 *
 * Every adapter used to call the global `fetch` directly; this is a drop-in
 * replacement with the same two-argument shape plus a third options object,
 * so a call site changes from `fetch(url, opts)` to
 * `fetchWithRetry(url, opts, { label: 'Elbit' })` and nothing else about the
 * adapter's own status/shape checking has to change — a 429 that survives
 * every retry still reaches the adapter's existing
 * `if (!res.ok) throw new ScrapeError(..., classifyHttpStatus(res.status))`
 * exactly as before.
 *
 * The decision logic (should this be retried, for how long) lives in
 * server/domain/retryPolicy.js, kept pure and unit-tested without a network;
 * this file is only the network + timer side effects around that decision.
 */

const { shouldRetryStatus, computeRetryDelay, sleep, MAX_ATTEMPTS } = require('../domain/retryPolicy');

/**
 * @param {string} url
 * @param {object} [options] passed straight to fetch
 * @param {{label?: string}} [context] `label` names the endpoint in the retry log
 * @returns {Promise<Response>} the last response received — may still be a
 *   429/503 if every retry was exhausted or a wait exceeded the cap; the
 *   caller classifies that exactly as it would have classified a first-try
 *   failure.
 */
async function fetchWithRetry(url, options, { label = url } = {}) {
    let response;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        response = await fetch(url, options);

        if (response.ok || !shouldRetryStatus(response.status)) return response;

        const decision = computeRetryDelay({ attempt, retryAfterHeader: response.headers.get('retry-after') });
        if (!decision.shouldWait) {
            console.log(`  ${label}: got ${response.status}, not retrying (${decision.reason})`);
            return response;
        }

        console.log(`  ${label}: got ${response.status}, waiting ${Math.round(decision.delayMs / 1000)}s before retry ${attempt + 1}/${MAX_ATTEMPTS - 1}`);
        await sleep(decision.delayMs);
    }

    return response;
}

module.exports = { fetchWithRetry };
