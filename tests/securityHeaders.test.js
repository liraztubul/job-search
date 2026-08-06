const test = require('node:test');
const assert = require('node:assert');
const { applySecurityHeaders, deploymentWarnings } = require('../server/web/middleware/securityHeaders');

/** Minimal stand-in for a ServerResponse. */
const fakeRes = () => {
    const headers = {};
    return { headers, setHeader: (k, v) => { headers[k] = v; } };
};

const withEnv = (env, fn) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        return fn();
    } finally {
        process.env = saved;
    }
};

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('always sets the headers that cost nothing', () => {
    const res = fakeRes();
    withEnv({ JT_BEHIND_HTTPS: '' }, () => applySecurityHeaders(res));

    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['X-Frame-Options'], 'DENY');
    assert.equal(res.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
});

test('HSTS only when actually behind HTTPS', () => {
    // Sending HSTS from localhost would poison every future plain-http project
    // on this machine's localhost until the max-age expires. Browsers honour it
    // even after the header stops being sent — that is the whole point of it.
    const local = fakeRes();
    withEnv({ JT_BEHIND_HTTPS: '' }, () => applySecurityHeaders(local));
    assert.equal(local.headers['Strict-Transport-Security'], undefined);

    const hosted = fakeRes();
    withEnv({ JT_BEHIND_HTTPS: '1' }, () => applySecurityHeaders(hosted));
    assert.match(hosted.headers['Strict-Transport-Security'], /max-age=31536000/);
});

// ---------------------------------------------------------------------------
// Startup warnings — each one is a silent failure otherwise
// ---------------------------------------------------------------------------

test('localhost with nothing configured is not a warning', () => {
    const warnings = withEnv({ JT_BEHIND_HTTPS: '' }, () =>
        deploymentWarnings({ host: '127.0.0.1', authEnabled: false })
    );
    assert.deepEqual(warnings, []);
});

test('exposed without accounts warns', () => {
    const warnings = withEnv({ JT_BEHIND_HTTPS: '1' }, () =>
        deploymentWarnings({ host: '0.0.0.0', authEnabled: false })
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no accounts configured/);
});

test('exposed without JT_BEHIND_HTTPS warns about the cookie', () => {
    // The failure this catches: the site works perfectly, and the session
    // cookie travels unprotected because one env var was forgotten.
    const warnings = withEnv({ JT_BEHIND_HTTPS: '' }, () =>
        deploymentWarnings({ host: '0.0.0.0', authEnabled: true })
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not be marked Secure/);
});

test('exposed with neither warns about both', () => {
    const warnings = withEnv({ JT_BEHIND_HTTPS: '' }, () =>
        deploymentWarnings({ host: '0.0.0.0', authEnabled: false })
    );
    assert.equal(warnings.length, 2);
});

test('JT_BEHIND_HTTPS on localhost warns too', () => {
    // Opposite mistake, and it presents as "login silently does nothing":
    // the browser drops a Secure cookie sent over http.
    const warnings = withEnv({ JT_BEHIND_HTTPS: '1' }, () =>
        deploymentWarnings({ host: '127.0.0.1', authEnabled: true })
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /login will appear to fail/);
});
