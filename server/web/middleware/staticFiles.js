/**
 * Serves everything in client/.
 *
 * The only rule that matters here: a URL must never escape the client folder.
 * `/../server/data/schema.sql` is a request someone will eventually make.
 */

const fs = require('fs');
const path = require('path');

const CLIENT_DIR = path.join(__dirname, '..', '..', '..', 'client');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    // Without these two, robots.txt and sitemap.xml fall through to
    // application/octet-stream — which makes a browser download them instead of
    // showing them, and makes crawlers skip them. A silent SEO failure: the
    // files exist, the URLs answer 200, and nothing indexes.
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
};

function serveStatic(res, urlPath) {
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.join(CLIENT_DIR, relative);

    if (!filePath.startsWith(CLIENT_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
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

module.exports = { serveStatic, CLIENT_DIR };
