/**
 * The HTTP server: wiring only.
 *
 *   node server/web/server.js      then open http://localhost:3000
 *
 * Anything under /api/ goes to the route table; everything else is a file in
 * client/. That is the whole of this file's job — routing rules live in
 * web/routes/, business rules in services/, SQL in data/.
 *
 * Built on node:http with no framework. Seven routes and one user; Express
 * would be a dependency doing almost nothing.
 *
 *
 * PROTOCOL — why plain HTTP request/response
 *
 * The scrape runs on a schedule and the page is read, not watched, so there is
 * nothing for the server to push. WebSockets would add a persistent connection
 * and reconnection handling to deliver news that a refresh already delivers.
 * If you later want the page to update while a scrape runs, reach for
 * Server-Sent Events before WebSockets: one-way, built into the browser, plain
 * HTTP, no library.
 *
 *
 * HTTPS — where it belongs
 *
 * Locally this binds to 127.0.0.1, which never leaves the machine, so TLS would
 * only buy you a browser warning about a self-signed certificate.
 *
 * Hosting it for your phone is a different situation: set HOST=0.0.0.0, put a
 * TLS terminator in front (Fly, Railway, Caddy, or a Cloudflare Tunnel), and
 * set JT_BEHIND_HTTPS=1 so the session cookie is marked Secure. Do not
 * implement TLS inside Node — certificate renewal is a solved problem you don't
 * want to own.
 *
 * The moment it is reachable from outside, configure auth too: see
 * web/middleware/auth.js and `node tools/set-password.js`. The server prints a
 * warning at startup if it is listening on a public address without either —
 * both are otherwise silent failures.
 */

const http = require('http');
const { sendJson } = require('./http');
const { handleApi } = require('./routes');
const { serveStatic } = require('./middleware/staticFiles');
const auth = require('./middleware/auth');
const { applySecurityHeaders, deploymentWarnings } = require('./middleware/securityHeaders');
const data = require('../data');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    // Before routing, so every response carries them — including 404s and the
    // static files, which are the ones a browser caches longest.
    applySecurityHeaders(res);

    if (url.pathname.startsWith('/api/')) {
        handleApi(req, res, url).catch((err) => {
            console.error('API error:', err);
            sendJson(res, 500, { error: err.message });
        });
        return;
    }

    serveStatic(res, url.pathname);
});

if (require.main === module) {
    server.listen(PORT, HOST, () => {
        const { total } = data.filterOptions();
        console.log(`\nJob Tracker UI running at http://localhost:${PORT}`);
        console.log(`${total} jobs in the database.`);
        if (total === 0) console.log('Empty — run `node server/main.js` first to collect some.');

        console.log(auth.isEnabled() ? 'Accounts are on.' : 'Accounts are off — running as account 1.');

        const warnings = deploymentWarnings({ host: HOST, authEnabled: auth.isEnabled() });
        for (const warning of warnings) {
            console.error(`\n  WARNING: ${warning}`);
        }
        if (warnings.length) console.error('');

        console.log('\nCtrl+C to stop.\n');
    });
}

module.exports = { server };
