const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { evaluateAvailability, bodyIndicatesGone, looksLikeBotProtection, GONE_PHRASES } = require('../server/domain/jobAvailability');

/**
 * Every fixture here is real markup, fetched live on 2026-08-19 from an
 * actual job URL already known (from job_snapshots.closed_at, or from being
 * currently open in the database) to be closed or open — not hand-written.
 * See the header comment in server/domain/jobAvailability.js for how each
 * phrase in GONE_PHRASES was chosen and what was rejected along the way.
 */
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// ---------------------------------------------------------------------------
// Status codes — the clean case
// ---------------------------------------------------------------------------

test('a genuine 404 is gone', () => {
    // Amazon (amazon.jobs) returns a real 404 for an expired posting —
    // confirmed live against a job the database already had marked closed.
    assert.equal(evaluateAvailability({ status: 404 }), 'gone');
});

test('410 Gone is gone', () => {
    assert.equal(evaluateAvailability({ status: 410 }), 'gone');
});

test('a plain 200 with no body is open', () => {
    assert.equal(evaluateAvailability({ status: 200 }), 'open');
});

test('a redirect-range or unexpected status is unknown, not gone', () => {
    assert.equal(evaluateAvailability({ status: 500 }), 'unknown');
    assert.equal(evaluateAvailability({ status: 302 }), 'unknown');
    assert.equal(evaluateAvailability({ status: 403 }), 'unknown', '403 is bot protection, not confirmation the job is gone');
});

// ---------------------------------------------------------------------------
// Mobileye — real captured "no longer available" page vs. a real open one
// ---------------------------------------------------------------------------

test('Mobileye: a real closed posting\'s page is detected as gone', () => {
    const body = fixture('mobileye-job-closed.html');
    assert.equal(evaluateAvailability({ status: 200, body }), 'gone');
});

test('Mobileye: a real, currently-open posting is NOT flagged gone', () => {
    const body = fixture('mobileye-job-open.html');
    assert.equal(evaluateAvailability({ status: 200, body }), 'open');
});

// ---------------------------------------------------------------------------
// Google — same pair
// ---------------------------------------------------------------------------

test('Google: a real closed posting\'s page is detected as gone', () => {
    const body = fixture('google-job-closed.html');
    assert.equal(evaluateAvailability({ status: 200, body }), 'gone');
});

test('Google: a real, currently-open posting is NOT flagged gone', () => {
    const body = fixture('google-job-open.html');
    assert.equal(evaluateAvailability({ status: 200, body }), 'open');
});

// ---------------------------------------------------------------------------
// The false-positive trap this list deliberately avoids
// ---------------------------------------------------------------------------

test('Apple\'s "this role does not exist" i18n string never triggers a false "gone" — it ships on every page, closed or not', () => {
    // A REAL, currently-open Apple posting. Its raw HTML contains the exact
    // phrase a closed Apple page also shows, buried in a generic client-side
    // translation bundle present on every jobs.apple.com page. This is
    // exactly why Apple has no entry in GONE_PHRASES — see the header
    // comment in server/domain/jobAvailability.js.
    const body = fixture('apple-job-open-with-misleading-i18n-bundle.html');
    assert.ok(body.toLowerCase().includes('this role does not exist'), 'sanity check: the trap phrase really is in this fixture');
    assert.equal(bodyIndicatesGone(body), false);
    assert.equal(evaluateAvailability({ status: 200, body }), 'open');
});

// ---------------------------------------------------------------------------
// Bot protection — must never read as "gone," no matter what shape it takes
// ---------------------------------------------------------------------------

test('Rafael\'s real Reblaze challenge page is unknown, not gone — and it does NOT even use a standard status code', () => {
    // Fetched live on 2026-08-19 from career.rafael.co.il. The status line
    // was literally "HTTP/1.1 247" — an unassigned code in the 2xx range,
    // not 403/429. If the bot-protection check didn't run before the plain
    // "200 <= status < 300 => open" fallback, this exact page would have
    // been misread as open. The body itself carries Reblaze's own markers
    // (kramericaindustries.ac_v2.lib.js, window.rbzns) — the same signature
    // CLAUDE.md records for both Rafael and Israel Aerospace Industries.
    const body = fixture('rafael-reblaze-challenge.html');
    assert.ok(/rbzns/.test(body), 'sanity check: the real marker is really in this fixture');
    assert.equal(looksLikeBotProtection({ status: 247, body }), true);
    assert.equal(evaluateAvailability({ status: 247, body }), 'unknown');
});

test('a 403 is unknown, never gone — it is a block, not a confirmation', () => {
    assert.equal(looksLikeBotProtection({ status: 403 }), true);
    assert.equal(evaluateAvailability({ status: 403, body: '' }), 'unknown');
});

test('a 429 is unknown, never gone', () => {
    assert.equal(looksLikeBotProtection({ status: 429 }), true);
    assert.equal(evaluateAvailability({ status: 429 }), 'unknown');
});

test('a generic CAPTCHA/challenge page on an otherwise-200 response is unknown, never gone', () => {
    const captchaBody = '<html><body>Please complete the CAPTCHA to continue.</body></html>';
    assert.equal(looksLikeBotProtection({ status: 200, body: captchaBody }), true);
    assert.equal(evaluateAvailability({ status: 200, body: captchaBody }), 'unknown');
});

test('bot protection is checked before the gone-phrase check — it wins even if a gone phrase were also present', () => {
    // Contrived, but proves the ordering: even a body that would otherwise
    // read as a confirmed closure must not override an active bot-protection
    // signal — the site never actually answered the question.
    const body = 'this job may have been taken down, says the rbzns challenge script';
    assert.equal(evaluateAvailability({ status: 200, body }), 'unknown');
});

test('a normal open job page triggers no bot-protection false positive', () => {
    const body = fixture('mobileye-job-open.html');
    assert.equal(looksLikeBotProtection({ status: 200, body }), false);
});

// ---------------------------------------------------------------------------
// bodyIndicatesGone — pure function edge cases
// ---------------------------------------------------------------------------

test('bodyIndicatesGone is case-insensitive', () => {
    assert.equal(bodyIndicatesGone('THIS JOB MAY HAVE BEEN TAKEN DOWN'), true);
    assert.equal(bodyIndicatesGone('ThIs PoSiTiOn Is No LoNgEr open to applicants'), true);
});

test('bodyIndicatesGone never throws on garbage input', () => {
    for (const bad of [null, undefined, 123, {}, [], '']) {
        assert.doesNotThrow(() => bodyIndicatesGone(bad));
        assert.equal(bodyIndicatesGone(bad), false);
    }
});

test('the phrase list has no Hebrew entries — none were verified against a real page', () => {
    // A guessed-but-unverified phrase is exactly the risk this module exists
    // to avoid; see the header comment for what was actually checked and
    // came back with no reliable signal.
    assert.ok(GONE_PHRASES.every((phrase) => !/[֐-׿]/.test(phrase)));
});
