/**
 * The API surface, in one readable table.
 *
 * Every route is `METHOD /path -> handler`. A handler receives
 * `{ req, res, url }` and is responsible for sending exactly one response.
 *
 * Handlers never touch SQL. They validate nothing beyond "is this a route" —
 * the rules live in server/services/.
 */

const { sendJson, readJson } = require('../http');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const jobSearch = require('../../services/jobSearchService');
const applications = require('../../services/applicationService');
const users = require('../../services/userService');
const verification = require('../../services/verificationService');
const email = require('../../services/emailService');
const jobVerify = require('../../services/jobVerifyService');

// One process, one budget — see server/web/middleware/rateLimit.js for why
// this is safe only as long as max_machines_running stays at 1.
const authLimiter = rateLimit.createAuthRateLimiter();

// Per-IP only — there's no account or email in this request to build a
// second counter from, and unlike login/register the risk here isn't a
// guessed credential, it's one visitor using this endpoint to fire off
// outbound requests at whatever URL a job happens to carry. 20/5min is
// generous for a real person clicking through search results, not for a
// script. Reuses the same sliding-window primitive rateLimit.js's own
// two-counter auth limiter is built from — not a second implementation.
const jobVerifyLimiter = rateLimit.createSlidingWindowLimiter({ windowMs: 5 * 60 * 1000, max: 20 });

/** 429 with a Retry-After header, worded identically whether or not the
 * submitted account is real — a rate limit response is not the place to leak
 * account existence. */
function tooManyRequests(res, retryAfterSec) {
    res.setHeader('Retry-After', String(retryAfterSec));
    return sendJson(res, 429, { error: 'too many attempts, try again later', retryAfterSec });
}

/**
 * The origin to build an email link against.
 *
 * Render terminates TLS at its edge (JT_BEHIND_HTTPS=1) and forwards plain
 * HTTP inside the network, so `req` itself never says https — the same flag
 * that marks the session cookie Secure is the only source of truth for which
 * scheme a link mailed to someone should use.
 */
function originOf(req) {
    const protocol = process.env.JT_BEHIND_HTTPS === '1' ? 'https' : 'http';
    return `${protocol}://${req.headers.host}`;
}

const routes = {
    'GET /api/meta': ({ res, userId }) => sendJson(res, 200, jobSearch.filterOptions(userId)),

    'GET /api/jobs': ({ res, url, userId }) => sendJson(res, 200, jobSearch.searchJobs(userId, url.searchParams)),

    'GET /api/applications': ({ res, userId }) => sendJson(res, 200, applications.listApplications(userId)),

    'POST /api/application': async ({ req, res, userId }) => {
        let payload;
        try {
            payload = await readJson(req);
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }

        const result = applications.updateApplication(userId, payload);
        return result.ok
            ? sendJson(res, 200, { application: result.application })
            : sendJson(res, 400, { error: result.error });
    },

    // Auth routes answer even when auth is switched off, so the client can ask
    // "do I need to log in?" without special-casing two builds of the server.
    'GET /api/session': ({ req, res }) => {
        const userId = auth.currentUserId(req);
        const info = users.currentUserInfo(userId);
        return sendJson(res, 200, {
            authRequired: auth.isEnabled(),
            authenticated: userId !== null,
            userId,
            // null when signed out — an email or a verification state only
            // means something for an actual account.
            email: info?.email ?? null,
            emailVerified: info?.emailVerified ?? null,
            // Derived from whether a mail API key is present — never a second
            // switch of its own, so adding the key is the only step that turns
            // password recovery back on. See client/login.html and
            // server/services/emailService.js.
            mailConfigured: email.isConfigured(),
        });
    },

    'POST /api/register': async ({ req, res }) => {
        if (!auth.isEnabled()) return sendJson(res, 400, { error: 'accounts are not configured' });

        let payload;
        try {
            payload = await readJson(req);
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }

        const keys = { ip: rateLimit.getClientIp(req), account: rateLimit.normalizeAccountKey(payload.email) };
        const gate = authLimiter.isBlocked('register', keys);
        if (gate.blocked) return tooManyRequests(res, gate.retryAfterSec);
        // Every attempt counts here, pass or fail — see rateLimit.js POLICIES.
        authLimiter.recordAttempt('register', keys);

        const result = await users.register(payload);
        if (!result.ok) return sendJson(res, 400, { error: result.error });

        // Fire-and-forget: a slow or failing mail provider must never delay
        // or break registration itself — see "Confirming an address" in
        // docs/ROADMAP.md. The account is fully usable either way.
        const origin = originOf(req);
        verification
            .sendEmailConfirmation(result.userId, result.email, (token) => `${origin}/api/confirm-email?token=${token}`)
            .catch((err) => console.error('registration confirmation email failed to send:', err));

        // Registering signs you in — an account you have to log into
        // immediately after creating is a pointless extra screen.
        auth.startSession(res, result.userId);
        return sendJson(res, 201, { ok: true });
    },

    'POST /api/login': async ({ req, res }) => {
        if (!auth.isEnabled()) return sendJson(res, 400, { error: 'login is not configured' });

        let payload;
        try {
            payload = await readJson(req);
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }

        const keys = { ip: rateLimit.getClientIp(req), account: rateLimit.normalizeAccountKey(payload.email) };
        const gate = authLimiter.isBlocked('login', keys);
        if (gate.blocked) return tooManyRequests(res, gate.retryAfterSec);

        const result = await users.authenticate(payload);
        if (!result.ok) {
            // Only failures spend the budget, so signing in often never locks
            // out a legitimate user — see rateLimit.js POLICIES.
            authLimiter.recordAttempt('login', keys);
            return sendJson(res, 401, { error: result.error });
        }

        auth.startSession(res, result.userId);
        return sendJson(res, 200, { ok: true });
    },

    'POST /api/logout': ({ res }) => {
        auth.logout(res);
        return sendJson(res, 200, { ok: true });
    },

    // Not in PUBLIC_ROUTES — requires a session. Also requires the current
    // password: deletion is irreversible, so a hijacked cookie alone must not
    // be enough to destroy the account, only to use it while signed in.
    'DELETE /api/account': async ({ req, res, userId }) => {
        let payload;
        try {
            payload = await readJson(req);
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }

        const keys = { ip: rateLimit.getClientIp(req), account: String(userId) };
        const gate = authLimiter.isBlocked('accountDelete', keys);
        if (gate.blocked) return tooManyRequests(res, gate.retryAfterSec);

        const result = await users.deleteAccount(userId, payload.password);
        if (!result.ok) {
            authLimiter.recordAttempt('accountDelete', keys);
            return sendJson(res, 400, { error: result.error });
        }

        auth.logout(res);
        return sendJson(res, 200, { ok: true });
    },

    'POST /api/password-reset/request': async ({ req, res }) => {
        let payload;
        try {
            payload = await readJson(req);
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }

        const keys = { ip: rateLimit.getClientIp(req), account: rateLimit.normalizeAccountKey(payload.email) };
        const gate = authLimiter.isBlocked('passwordResetRequest', keys);
        if (gate.blocked) return tooManyRequests(res, gate.retryAfterSec);
        // Every request counts, real address or not — see rateLimit.js POLICIES.
        authLimiter.recordAttempt('passwordResetRequest', keys);

        const origin = originOf(req);
        await verification.requestPasswordReset(payload.email, (token) => `${origin}/reset.html?token=${token}`);

        // Identical response whether or not the address is registered — see
        // verificationService.js.
        return sendJson(res, 200, { ok: true });
    },

    'POST /api/password-reset/confirm': async ({ req, res }) => {
        let payload;
        try {
            payload = await readJson(req);
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }

        const keys = { ip: rateLimit.getClientIp(req), account: rateLimit.tokenRateLimitKey(payload.token) };
        const gate = authLimiter.isBlocked('passwordResetConfirm', keys);
        if (gate.blocked) return tooManyRequests(res, gate.retryAfterSec);

        const result = await verification.confirmPasswordReset(payload.token, payload.password);
        if (!result.ok) {
            authLimiter.recordAttempt('passwordResetConfirm', keys);
            return sendJson(res, 400, { error: result.error });
        }

        return sendJson(res, 200, { ok: true });
    },

    // A one-click link, not a form — GET is what a mailed <a href> can be.
    // Rate limited and public like the two routes above; see PUBLIC_ROUTES.
    'GET /api/confirm-email': ({ req, res, url }) => {
        const token = url.searchParams.get('token') || '';
        const keys = { ip: rateLimit.getClientIp(req), account: rateLimit.tokenRateLimitKey(token) };
        const gate = authLimiter.isBlocked('confirmEmail', keys);
        if (gate.blocked) return tooManyRequests(res, gate.retryAfterSec);

        const confirmed = verification.confirmEmail(token);
        if (!confirmed) authLimiter.recordAttempt('confirmEmail', keys);

        res.writeHead(302, {
            Location: confirmed ? '/index.html?confirmed=1' : '/index.html?confirmed=0',
            'Cache-Control': 'no-store',
        });
        res.end();
    },
};

/**
 * `POST /api/jobs/:id/verify` — the one route with a dynamic segment, so it
 * doesn't fit the flat `routes` table above. Kept as a single regex rather
 * than reaching for a router: one dynamic route doesn't justify a dependency
 * or a hand-rolled framework, and `handleApi` below already knows how to
 * dispatch to it.
 *
 * Public, like `GET /api/jobs` — verifying a listing is still open touches
 * no personal data, and a confirmed "gone" benefits every visitor's next
 * search, not just whoever clicked.
 */
const JOB_VERIFY_ROUTE = /^\/api\/jobs\/(\d+)\/verify$/;

async function verifyJobHandler({ req, res, jobId }) {
    const ip = rateLimit.getClientIp(req);
    const gate = jobVerifyLimiter.status(ip);
    if (gate.blocked) return tooManyRequests(res, gate.retryAfterSec);
    // Every call counts, not just ones that find a closed job — this makes
    // outbound requests regardless of the answer, which is exactly the cost
    // the limit exists to bound.
    jobVerifyLimiter.record(ip);

    const result = await jobVerify.verifyJob(jobId);
    if (result.status === 'not_found') return sendJson(res, 404, { error: 'no such job' });

    return sendJson(res, 200, { status: result.status });
}

/**
 * Routes a logged-out visitor may call.
 *
 * The job list is deliberately among them. A search engine cannot log in, so
 * anything behind a session is a page Google will never read — a site whose
 * only public surface is a login form is unfindable by definition.
 *
 * The line is drawn at ownership, not at sensitivity: the job market is the
 * same for everyone and is public; which of those jobs *you* applied to is
 * yours. Everything below the line gets GUEST, which reads shared tables
 * normally and matches no personal row (see data/tenancy.js).
 */
const PUBLIC_ROUTES = new Set([
    'GET /api/session',
    'POST /api/register',
    'POST /api/login',
    'POST /api/logout',
    'GET /api/meta',
    'GET /api/jobs',
    // Reaching all three requires proving you don't have a session (you
    // forgot your password) or are acting on a mailed link, not that you
    // have one — the same "ownership, not sensitivity" line PUBLIC_ROUTES
    // already draws for the job list.
    'POST /api/password-reset/request',
    'POST /api/password-reset/confirm',
    'GET /api/confirm-email',
]);

async function handleApi(req, res, url) {
    const key = `${req.method} ${url.pathname}`;
    let handler = routes[key];
    let routeParams = {};
    let isPublic = PUBLIC_ROUTES.has(key);

    if (!handler && req.method === 'POST') {
        const match = url.pathname.match(JOB_VERIFY_ROUTE);
        if (match) {
            handler = verifyJobHandler;
            routeParams = { jobId: Number(match[1]) };
            isPublic = true; // see JOB_VERIFY_ROUTE's own comment
        }
    }

    if (!handler) return sendJson(res, 404, { error: 'no such endpoint' });

    const signedIn = auth.currentUserId(req);
    if (!isPublic && signedIn === null) {
        return sendJson(res, 401, { error: 'not logged in' });
    }

    // A public route with nobody signed in gets the guest sentinel rather than
    // null, so the repository layer never has to interpret "no id" — which is
    // exactly the ambiguity requireUser exists to reject.
    const userId = signedIn === null ? jobSearch.GUEST : signedIn;

    // Handlers get the caller's id rather than reaching for it themselves, so
    // no route can accidentally query without one.
    return handler({ req, res, url, userId, ...routeParams });
}

module.exports = { handleApi, routes, PUBLIC_ROUTES };
