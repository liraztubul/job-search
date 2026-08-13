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

// One process, one budget — see server/web/middleware/rateLimit.js for why
// this is safe only as long as max_machines_running stays at 1.
const authLimiter = rateLimit.createAuthRateLimiter();

/** 429 with a Retry-After header, worded identically whether or not the
 * submitted account is real — a rate limit response is not the place to leak
 * account existence. */
function tooManyRequests(res, retryAfterSec) {
    res.setHeader('Retry-After', String(retryAfterSec));
    return sendJson(res, 429, { error: 'too many attempts, try again later', retryAfterSec });
}

const routes = {
    'GET /api/meta': ({ res }) => sendJson(res, 200, jobSearch.filterOptions()),

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
    'GET /api/session': ({ req, res }) =>
        sendJson(res, 200, {
            authRequired: auth.isEnabled(),
            authenticated: auth.isAuthorized(req),
            userId: auth.currentUserId(req),
            // Accounts being off already tells the client that login is
            // unavailable. This tells it *why*, which is a different question:
            // locally it means "you're the only user, no login needed", and on
            // the public demo it means "this host has no disk to keep an
            // account on". Same state, opposite explanations — and the setup
            // instructions that are helpful locally are noise to a visitor.
            demo: process.env.JT_DEMO === '1',
        }),

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
};

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
]);

async function handleApi(req, res, url) {
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];

    if (!handler) return sendJson(res, 404, { error: 'no such endpoint' });

    const signedIn = auth.currentUserId(req);
    if (!PUBLIC_ROUTES.has(key) && signedIn === null) {
        return sendJson(res, 401, { error: 'not logged in' });
    }

    // A public route with nobody signed in gets the guest sentinel rather than
    // null, so the repository layer never has to interpret "no id" — which is
    // exactly the ambiguity requireUser exists to reject.
    const userId = signedIn === null ? jobSearch.GUEST : signedIn;

    // Handlers get the caller's id rather than reaching for it themselves, so
    // no route can accidentally query without one.
    return handler({ req, res, url, userId });
}

module.exports = { handleApi, routes, PUBLIC_ROUTES };
