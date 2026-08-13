const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { hashPassword, verifyPassword, needsRehash } = require('../server/web/middleware/auth');

// ---------------------------------------------------------------------------
// New self-describing format
// ---------------------------------------------------------------------------

test('hashPassword produces a self-describing "scrypt$N$r$p$salt$hash" string', async () => {
    const stored = await hashPassword('correct horse battery staple');
    const parts = stored.split('$');
    assert.equal(parts.length, 6);
    assert.equal(parts[0], 'scrypt');
    assert.ok(Number.isInteger(Number(parts[1])) && Number(parts[1]) > 0, 'N is a positive integer');
});

test('a password verifies against its own hash, and a wrong one does not', async () => {
    const stored = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', stored), true);
    assert.equal(await verifyPassword('wrong password', stored), false);
});

test('two hashes of the same password use different random salts', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// Legacy "salt:hash" format — the change most likely to lock out every
// existing account if it silently breaks.
// ---------------------------------------------------------------------------

/** Reproduces exactly what the old `hashPassword` produced, pre-Task-2. */
function legacyHash(password, salt = crypto.randomBytes(16).toString('hex')) {
    return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

test('a legacy "salt:hash" password still verifies after the format change', async () => {
    const stored = legacyHash('an old account password');
    assert.equal(await verifyPassword('an old account password', stored), true);
    assert.equal(await verifyPassword('wrong guess', stored), false);
});

test('a legacy hash is flagged for rehashing; a current hash is not', async () => {
    const legacy = legacyHash('an old account password');
    const current = await hashPassword('a fresh account password');

    assert.equal(needsRehash(legacy), true);
    assert.equal(needsRehash(current), false);
});

test('a malformed stored hash fails closed rather than throwing', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-real-hash'), false);
    assert.equal(await verifyPassword('anything', ''), false);
    assert.equal(await verifyPassword('anything', 'scrypt$not$enough$parts'), false);
});
