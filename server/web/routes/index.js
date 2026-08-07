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
const jobSearch = require('../../services/jobSearchService');
const applications = require('../../services/applicationService');
const users = require('../../services/userService');

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
        }),

    'POST /api/register': async ({ req, res }) => {
        if (!auth.isEnabled()) return sendJson(res, 400, { error: 'accounts are not configured' });

        let payload;
        try {
            payload = await readJson(req);
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }

        const result = users.register(payload);
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

        const result = users.authenticate(payload);
        if (!result.ok) return sendJson(res, 401, { error: result.error });

        auth.startSession(res, result.userId);
        return sendJson(res, 200, { ok: true });
    },

    'POST /api/logout': ({ res }) => {
        auth.logout(res);
        return sendJson(res, 200, { ok: true });
    },
};

/** Routes reachable without a session. Everything else needs one. */
const PUBLIC_ROUTES = new Set([
    'GET /api/session',
    'POST /api/register',
    'POST /api/login',
    'POST /api/logout',
]);

async function handleApi(req, res, url) {
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];

    if (!handler) return sendJson(res, 404, { error: 'no such endpoint' });

    const userId = auth.currentUserId(req);
    if (!PUBLIC_ROUTES.has(key) && userId === null) {
        return sendJson(res, 401, { error: 'not logged in' });
    }

    // Handlers get the caller's id rather than reaching for it themselves, so
    // no route can accidentally query without one.
    return handler({ req, res, url, userId });
}

module.exports = { handleApi, routes, PUBLIC_ROUTES };
