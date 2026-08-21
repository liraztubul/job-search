process.env.JT_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../server/data/connection');
const {
    addCompany,
    setKnownIssue,
    clearKnownIssue,
    resetRefusalStreak,
    recordRefusal,
} = require('../server/data/companies');

function seedCompany(name) {
    return addCompany({ name: `${name} ${Math.random()}`, careerUrl: '', adapterType: 'manual', config: {} });
}

function readCompany(id) {
    return db.prepare('SELECT * FROM watched_companies WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// known_issue_* — a human's deliberate acknowledgment of a standing failure
// kind, set only through tools/acknowledge-issue.js in practice.
// ---------------------------------------------------------------------------

test('a freshly added company has no known issue', () => {
    const id = seedCompany('Fresh');
    const row = readCompany(id);
    assert.equal(row.known_issue_kind, null);
    assert.equal(row.known_issue_reason, null);
    assert.equal(row.known_issue_at, null);
});

test('setKnownIssue records the kind, the reason, and a timestamp', () => {
    const id = seedCompany('Blocked Co');
    setKnownIssue(id, 'blocked', 'blocks the GitHub runner, confirmed manually');

    const row = readCompany(id);
    assert.equal(row.known_issue_kind, 'blocked');
    assert.equal(row.known_issue_reason, 'blocks the GitHub runner, confirmed manually');
    assert.ok(row.known_issue_at, 'known_issue_at must be stamped');
});

test('clearKnownIssue removes all three fields', () => {
    const id = seedCompany('Was Blocked Co');
    setKnownIssue(id, 'blocked', 'reason');
    clearKnownIssue(id);

    const row = readCompany(id);
    assert.equal(row.known_issue_kind, null);
    assert.equal(row.known_issue_reason, null);
    assert.equal(row.known_issue_at, null);
});

// ---------------------------------------------------------------------------
// refusal_streak / last_refused_count — the sanity gate's memory, per
// company. See server/domain/scrapeSanity.js and scrapeService.js.
// ---------------------------------------------------------------------------

test('a freshly added company starts at refusal_streak 0 with no last_refused_count', () => {
    const id = seedCompany('Fresh Streak');
    const row = readCompany(id);
    assert.equal(row.refusal_streak, 0);
    assert.equal(row.last_refused_count, null);
});

test('recordRefusal increments the streak each call and records what was refused', () => {
    const id = seedCompany('Refused Co');

    assert.equal(recordRefusal(id, 40), 1);
    assert.equal(readCompany(id).last_refused_count, 40);

    assert.equal(recordRefusal(id, 55), 2);
    assert.equal(readCompany(id).last_refused_count, 55);

    assert.equal(recordRefusal(id, 60), 3);
    assert.equal(readCompany(id).refusal_streak, 3);
    assert.equal(readCompany(id).last_refused_count, 60);
});

test('resetRefusalStreak zeroes the streak and clears last_refused_count', () => {
    const id = seedCompany('Recovered Co');
    recordRefusal(id, 40);
    recordRefusal(id, 45);

    resetRefusalStreak(id);

    const row = readCompany(id);
    assert.equal(row.refusal_streak, 0);
    assert.equal(row.last_refused_count, null);
});

test('refusal streaks are per-company, not global', () => {
    const a = seedCompany('Streak A');
    const b = seedCompany('Streak B');

    recordRefusal(a, 10);
    recordRefusal(a, 11);
    recordRefusal(b, 99);

    assert.equal(readCompany(a).refusal_streak, 2);
    assert.equal(readCompany(b).refusal_streak, 1);
});
