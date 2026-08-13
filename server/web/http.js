/**
 * The three things every handler needs from raw node:http.
 *
 * Not a framework — just the boilerplate that would otherwise be copy-pasted
 * into each route.
 */

/**
 * Send a JSON response with the right headers.
 *
 * `Cache-Control: no-store` on every response, not just the personal ones —
 * `GET /api/applications` and `GET /api/jobs` are both handled by this same
 * function, and a browser is free to serve a GET response out of its disk
 * cache with no revalidation once a page navigates back to it. Session state
 * changes who a request is allowed to see; a cached response from before a
 * logout doesn't know that. One flag here is simpler than deciding per route
 * which JSON is personal enough to need it.
 */
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

/** Read a request body, refusing anything absurdly large. */
function readBody(req, limitBytes = 1e6) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            // A body this large is either a bug or an attack.
            if (data.length > limitBytes) reject(new Error('body too large'));
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

/** Read and parse a JSON body, or throw a message worth showing the caller. */
async function readJson(req) {
    try {
        return JSON.parse(await readBody(req));
    } catch {
        throw new Error('invalid JSON body');
    }
}

module.exports = { sendJson, readBody, readJson };
