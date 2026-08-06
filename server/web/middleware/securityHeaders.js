/**
 * Response headers that only matter once this is reachable from outside.
 *
 * HSTS is the one that needs explaining. Without it, the first request a
 * browser makes to your domain is plain `http://` — typed, bookmarked, or from
 * a link — and someone on the same network can answer it before the redirect
 * to https ever arrives. HSTS tells the browser "for this domain, never try
 * http again", so that one unprotected first request stops happening.
 *
 * It is deliberately sticky: once sent, browsers honour it for `max-age` even
 * if the header disappears. That is why it is tied to JT_BEHIND_HTTPS and never
 * sent locally — sending it from localhost would make every future plain-http
 * project on your machine's `localhost` unreachable until the cache expires.
 */

const ONE_YEAR = 31536000;

const behindHttps = () => process.env.JT_BEHIND_HTTPS === '1';

function applySecurityHeaders(res) {
    // Don't let a browser second-guess a Content-Type. Stops a text file that
    // happens to contain markup from being treated as HTML.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // This app is never meant to be framed. Blocks clickjacking outright.
    res.setHeader('X-Frame-Options', 'DENY');

    // Don't leak the page you came from to the career sites you click through
    // to — the URL can carry your filters.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (behindHttps()) {
        res.setHeader('Strict-Transport-Security', `max-age=${ONE_YEAR}; includeSubDomains`);
    }
}

/**
 * Shout when the server is reachable from the network but not configured as if
 * it were. Both of these are silent failures otherwise: the site works, and the
 * session cookie is simply travelling in the clear.
 *
 * @returns {string[]} warnings, empty when the configuration is coherent
 */
function deploymentWarnings({ host, authEnabled }) {
    const warnings = [];
    const exposed = host !== '127.0.0.1' && host !== 'localhost';

    if (exposed && !authEnabled) {
        warnings.push(
            `listening on ${host} with no accounts configured — anyone who finds the port ` +
                'gets in. Run: node tools/set-password.js'
        );
    }

    if (exposed && !behindHttps()) {
        warnings.push(
            `listening on ${host} without JT_BEHIND_HTTPS=1 — the session cookie will not be ` +
                'marked Secure, so a browser will send it over plain http. Set it once TLS ' +
                'terminates in front of this process.'
        );
    }

    if (!exposed && behindHttps()) {
        warnings.push(
            'JT_BEHIND_HTTPS=1 on localhost — the Secure cookie will be dropped over http ' +
                'and login will appear to fail for no reason.'
        );
    }

    return warnings;
}

module.exports = { applySecurityHeaders, deploymentWarnings, behindHttps };
