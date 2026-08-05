/**
 * server.js — the local web UI.
 *
 *   node src/server.js          then open http://localhost:3000
 *
 * Built on node:http with no framework. This app has four routes and one user;
 * Express would be a dependency doing almost nothing.
 *
 * NO LOGIN, ON PURPOSE. It binds to 127.0.0.1, so it is only reachable from
 * this machine — the same protection your files already have. Adding accounts
 * would mean password hashing, sessions and a users table to guard data that
 * is already sitting unencrypted in jobtracker.db next to this file. It would
 * be security theatre, and it's the kind of complexity that never comes back
 * out. If you ever host this on a real server, that's the moment to add auth —
 * and then it's a genuinely different piece of work.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1'; // not 0.0.0.0 — see the note above
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'rejected'];

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            // A request body this large is either a bug or an attack.
            if (data.length > 1e6) reject(new Error('body too large'));
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function serveStatic(res, urlPath) {
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.join(PUBLIC_DIR, relative);

    // Never let a URL escape the public directory.
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(content);
    });
}

async function handleApi(req, res, url) {
    if (url.pathname === '/api/meta' && req.method === 'GET') {
        return sendJson(res, 200, { ...db.filterOptions(), statusVocabulary: STATUSES });
    }

    if (url.pathname === '/api/jobs' && req.method === 'GET') {
        const p = url.searchParams;
        return sendJson(res, 200, {
            jobs: db.queryJobs({
                companyId: p.get('company') || null,
                employmentType: p.get('employment') || null,
                experienceLevel: p.get('experience') || null,
                location: p.get('location') || null,
                q: p.get('q') || null,
                status: p.get('status') || null,
                openOnly: p.get('open') === '1',
                sort: p.get('sort') || null,
                limit: p.get('limit') || null,
            }),
        });
    }

    if (url.pathname === '/api/applications' && req.method === 'GET') {
        const applications = db.listApplications();
        const counts = applications.reduce((acc, a) => ({ ...acc, [a.status]: (acc[a.status] || 0) + 1 }), {});
        return sendJson(res, 200, { applications, counts, statusVocabulary: STATUSES });
    }

    if (url.pathname === '/api/application' && req.method === 'POST') {
        let payload;
        try {
            payload = JSON.parse(await readBody(req));
        } catch {
            return sendJson(res, 400, { error: 'invalid JSON body' });
        }

        const jobId = Number(payload.jobId);
        if (!Number.isInteger(jobId) || jobId <= 0) {
            return sendJson(res, 400, { error: 'jobId must be a positive integer' });
        }

        // '' from a cleared <select> means "remove this application"; a key
        // that isn't sent at all means "leave that field alone".
        const status = 'status' in payload ? payload.status || null : undefined;
        if (status && !STATUSES.includes(status)) {
            return sendJson(res, 400, { error: `status must be one of: ${STATUSES.join(', ')}` });
        }

        const appliedAt = 'appliedAt' in payload ? payload.appliedAt || null : undefined;
        if (appliedAt && !/^\d{4}-\d{2}-\d{2}$/.test(appliedAt)) {
            return sendJson(res, 400, { error: 'appliedAt must be YYYY-MM-DD' });
        }

        try {
            const application = db.setApplication({
                jobSnapshotId: jobId,
                status,
                appliedAt,
                notes: 'notes' in payload ? payload.notes : undefined,
            });
            return sendJson(res, 200, { application });
        } catch (err) {
            // Most likely a jobId that doesn't exist — the FK rejects it.
            return sendJson(res, 400, { error: err.message });
        }
    }

    return sendJson(res, 404, { error: 'no such endpoint' });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

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
        const { total } = db.filterOptions();
        console.log(`\nJob Tracker UI running at http://localhost:${PORT}`);
        console.log(`${total} jobs in the database.`);
        if (total === 0) console.log('Empty — run `node src/main.js` first to collect some.');
        console.log('\nCtrl+C to stop.\n');
    });
}

module.exports = { server, STATUSES };
