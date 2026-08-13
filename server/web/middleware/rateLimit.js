/**
 * Rate limiting for login and registration.
 *
 * WHY TWO COUNTERS
 *
 * An IP-only limit is defeated by a botnet: spread the same credential-stuffing
 * attempt across a thousand addresses and no single one ever trips it. An
 * account-only limit is defeated the opposite way: one machine sprays one
 * common password across a thousand different accounts, and no single account
 * ever sees five failures. Neither limit alone stops a realistic attacker —
 * both are checked, and either one tripping refuses the request.
 *
 * WHY IN-MEMORY, AND WHEN THAT STOPS BEING TRUE
 *
 * This process is the only Fly machine allowed to run (`max_machines_running =
 * 1` in fly.toml — SQLite has one writer, see ARCHITECTURE.md ADR-002), so
 * there is nothing else to share counters with. A `rate_limits` table would
 * add write load to the same SQLite file that serves every job search, for
 * state that only needs to survive 15 minutes. The moment `max_machines_running`
 * goes above 1, this becomes wrong: each machine would enforce its own
 * separate budget, and an attacker who gets load-balanced across machines
 * effectively multiplies the limit by the machine count. Move counters to a
 * shared store (or back to Postgres) before scaling out.
 *
 * WHY A SLIDING WINDOW WITH AN INJECTABLE CLOCK
 *
 * A fixed window (reset every 15 minutes on the clock) lets an attacker do a
 * full budget's worth of attempts right before the reset and another right
 * after — effectively doubling the limit at the boundary. A sliding window
 * (count only attempts within the last `windowMs`, whenever "now" is) doesn't
 * have that seam. `now` is a parameter rather than `Date.now()` called
 * directly so tests can move time forward without sleeping for real minutes.
 */

const crypto = require('crypto');

const DEFAULT_CAP = 5000;

/**
 * Sliding-window counter for one identifier space (e.g. "IP" or "account").
 * Tracks attempt timestamps per key; a key is "over limit" once `max`
 * timestamps fall inside the trailing `windowMs`.
 */
function createSlidingWindowLimiter({ windowMs, max, cap = DEFAULT_CAP, now = Date.now }) {
    /** @type {Map<string, number[]>} key -> ascending attempt timestamps */
    const store = new Map();

    function prune(timestamps, cutoff) {
        let i = 0;
        while (i < timestamps.length && timestamps[i] <= cutoff) i++;
        return i === 0 ? timestamps : timestamps.slice(i);
    }

    /** Drop keys whose every timestamp has expired, to make room in the cap. */
    function evictExpired(cutoff) {
        for (const [key, timestamps] of store) {
            const pruned = prune(timestamps, cutoff);
            if (pruned.length === 0) store.delete(key);
            else if (pruned !== timestamps) store.set(key, pruned);
        }
    }

    function statusFrom(timestamps, nowMs) {
        if (!timestamps || timestamps.length < max) return { blocked: false, retryAfterSec: 0 };
        const retryAfterMs = timestamps[0] + windowMs - nowMs;
        return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    /** Read-only: is this key currently over limit? Never creates an entry. */
    function status(key) {
        const nowMs = now();
        const cutoff = nowMs - windowMs;
        const existing = store.get(key);
        if (!existing) return { blocked: false, retryAfterSec: 0 };

        const pruned = prune(existing, cutoff);
        if (pruned.length !== existing.length) {
            if (pruned.length === 0) store.delete(key);
            else store.set(key, pruned);
        }
        return statusFrom(pruned, nowMs);
    }

    /**
     * Record one attempt against `key`. Only call this for attempts that
     * should count toward the budget — see the success/failure split in
     * `AuthRateLimiter` below.
     *
     * @returns {{blocked: boolean, retryAfterSec: number}} status AFTER recording
     */
    function record(key) {
        const nowMs = now();
        const cutoff = nowMs - windowMs;
        let timestamps = store.get(key);

        if (!timestamps) {
            // A key never seen before. If the map is full, try to free a slot by
            // dropping anything fully expired. If nothing is expired either, we
            // cannot safely start tracking this identifier — growing without
            // bound is the memory-exhaustion attack this cap exists to stop, so
            // the request fails closed (refused) instead of sailing through
            // unmonitored.
            if (store.size >= cap) {
                evictExpired(cutoff);
                if (store.size >= cap) {
                    return { blocked: true, retryAfterSec: Math.ceil(windowMs / 1000) };
                }
            }
            timestamps = [];
            store.set(key, timestamps);
        } else {
            const pruned = prune(timestamps, cutoff);
            if (pruned !== timestamps) {
                timestamps = pruned;
                store.set(key, timestamps);
            }
        }

        const before = statusFrom(timestamps, nowMs);
        if (before.blocked) return before;

        timestamps.push(nowMs);
        return { blocked: false, retryAfterSec: 0 };
    }

    return { status, record, size: () => store.size };
}

/**
 * Read the visitor's real address.
 *
 * On Fly, `req.socket.remoteAddress` is Fly's own internal proxy — every
 * request looks like it comes from the same machine, so a naive per-IP limit
 * would let one attacker's failures lock out every visitor. The real address
 * is in `Fly-Client-IP`, falling back to the leftmost `X-Forwarded-For` entry.
 *
 * Those headers are only trusted when `JT_TRUST_PROXY=1` is set (set it in
 * fly.toml; leave it unset locally) — anyone can send them from a plain HTTP
 * client, so honouring them unconditionally would let an attacker forge a new
 * IP on every request and bypass the limit entirely.
 */
function getClientIp(req) {
    if (process.env.JT_TRUST_PROXY === '1') {
        const flyIp = req.headers['fly-client-ip'];
        if (flyIp) return String(flyIp).trim();

        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) return String(forwarded).split(',')[0].trim();
    }
    return req.socket.remoteAddress;
}

const normalizeAccountKey = (email) => String(email || '').trim().toLowerCase();

/** The "account" counter for a token-based route (password-reset confirm,
 * email confirm) — there is no account identifier in the request body to key
 * on, so the token itself stands in. Hashed rather than kept as the raw
 * token, matching the "never store the raw token" rule elsewhere in this
 * flow — this is only ever a short-lived in-memory Map key, but there is no
 * reason for a raw token to exist in one more place than it has to. */
const tokenRateLimitKey = (token) =>
    crypto.createHash('sha256').update(String(token || '')).digest('hex');

/**
 * Named policies for the two endpoints that need this. Numbers are a starting
 * point, not measured: 5 failed attempts/account/15min and 20/IP/15min for
 * login, 3/hour for registration.
 */
const POLICIES = {
    login: {
        windowMs: 15 * 60 * 1000,
        ip: { max: 20 },
        account: { max: 5 },
        // A legitimate user who logs in often must never lock themselves out —
        // only failed attempts count. Recorded explicitly by the caller, not
        // here, since only the caller knows whether auth actually succeeded.
    },
    register: {
        windowMs: 60 * 60 * 1000,
        ip: { max: 3 },
        account: { max: 3 },
        // Unlike login, every registration attempt counts here (success
        // included) — the risk is spam account creation, not a guessed
        // password, so there is no "successful attempt" to exempt.
    },
    // Requesting a reset SENDS MAIL — that costs the app's Brevo quota and
    // can be aimed at a stranger's inbox as harassment, which is a step
    // worse than a wasted login attempt. Every request counts, same as
    // register: the response is identical either way, so there is no
    // "failed attempt" to distinguish.
    passwordResetRequest: {
        windowMs: 60 * 60 * 1000,
        ip: { max: 10 },
        account: { max: 3 }, // keyed by the normalized email in the request body
    },
    // Confirm has no email in its body ({ token, password }) — the "account"
    // counter here is keyed by a hash of the submitted token instead (see
    // routes/index.js). That still gives the same two-counter shape: one
    // token being retried a lot is throttled without capping every other
    // reset in flight from the same IP.
    passwordResetConfirm: {
        windowMs: 60 * 60 * 1000,
        ip: { max: 20 },
        account: { max: 5 },
    },
    // Same token-keyed shape as passwordResetConfirm, for the registration
    // confirmation link.
    confirmEmail: {
        windowMs: 60 * 60 * 1000,
        ip: { max: 20 },
        account: { max: 5 },
    },
};

/** Builds the ip+account counter pair for every policy, sharing one clock. */
function createAuthRateLimiter({ now = Date.now, cap = DEFAULT_CAP } = {}) {
    const counters = {};
    for (const [name, policy] of Object.entries(POLICIES)) {
        counters[name] = {
            ip: createSlidingWindowLimiter({ windowMs: policy.windowMs, max: policy.ip.max, cap, now }),
            account: createSlidingWindowLimiter({ windowMs: policy.windowMs, max: policy.account.max, cap, now }),
        };
    }

    /** Peek only. True if either counter for this policy is already tripped. */
    function isBlocked(policyName, { ip, account }) {
        const pair = counters[policyName];
        const ipStatus = pair.ip.status(ip);
        const accountStatus = pair.account.status(account);
        if (!ipStatus.blocked && !accountStatus.blocked) return { blocked: false, retryAfterSec: 0 };
        return { blocked: true, retryAfterSec: Math.max(ipStatus.retryAfterSec, accountStatus.retryAfterSec) };
    }

    /** Record one countable attempt on both counters for this policy. */
    function recordAttempt(policyName, { ip, account }) {
        const pair = counters[policyName];
        pair.ip.record(ip);
        pair.account.record(account);
    }

    return { isBlocked, recordAttempt, _counters: counters };
}

module.exports = {
    createSlidingWindowLimiter,
    createAuthRateLimiter,
    getClientIp,
    normalizeAccountKey,
    tokenRateLimitKey,
    POLICIES,
};
