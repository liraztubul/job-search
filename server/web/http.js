/**
 * The three things every handler needs from raw node:http.
 *
 * Not a framework — just the boilerplate that would otherwise be copy-pasted
 * into each route.
 */

/** Send a JSON response with the right headers. */
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
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
