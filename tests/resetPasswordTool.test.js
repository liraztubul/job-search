// A real file-backed database, not :memory: — tools/reset-password.js runs
// as its own child process and needs a database this test process can read
// back from afterward to prove what actually got written. Each test file
// runs in its own node --test process, so setting JT_DB_PATH here has no
// effect on any other test file.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = path.join(os.tmpdir(), `jobtrail-reset-tool-test-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.JT_DB_PATH = dbPath;
process.env.JT_SESSION_SECRET = 'test-secret-not-for-production';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const users = require('../server/data/users');
const userService = require('../server/services/userService');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'reset-password.js');

test.after(() => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* fine if it never existed */ }
    }
});

test("reset-password.js's hash is accepted by the real login path, and it bumps session_epoch", async () => {
    const email = 'reset-tool@example.com';
    const registered = await userService.register({ email, password: 'original-password-1' });
    assert.ok(registered.ok);

    const epochBefore = users.findUserByEmail(email).session_epoch;

    // Runs as a genuinely separate process against the same file — this is
    // the actual CLI a person would type, not a function call standing in
    // for it.
    execFileSync(process.execPath, [TOOL, '--email', email, '--password', 'brand-new-password-2'], {
        cwd: ROOT,
        env: { ...process.env, JT_DB_PATH: dbPath },
    });

    // Verified through userService.authenticate — the exact function
    // POST /api/login calls — not by inspecting the stored hash's shape,
    // which could look right and still fail to verify.
    const oldStillWorks = await userService.authenticate({ email, password: 'original-password-1' });
    assert.equal(oldStillWorks.ok, false, 'the old password must stop working');

    const newWorks = await userService.authenticate({ email, password: 'brand-new-password-2' });
    assert.equal(newWorks.ok, true, "the tool's hash must be accepted by the real login path");

    const epochAfter = users.findUserByEmail(email).session_epoch;
    assert.ok(epochAfter > epochBefore, 'session_epoch must be bumped, exactly as a mailed reset link does');
});

test('reset-password.js refuses a password shorter than registration\'s own minimum', () => {
    assert.throws(() => {
        execFileSync(process.execPath, [TOOL, '--email', 'whoever@example.com', '--password', 'short'], {
            cwd: ROOT,
            env: { ...process.env, JT_DB_PATH: dbPath },
            stdio: 'pipe',
        });
    }, /Command failed/);
});

test('reset-password.js exits with an error for an email that does not exist, without crashing', () => {
    assert.throws(() => {
        execFileSync(
            process.execPath,
            [TOOL, '--email', 'never-registered-anywhere@example.com', '--password', 'a-fine-password-123'],
            { cwd: ROOT, env: { ...process.env, JT_DB_PATH: dbPath }, stdio: 'pipe' }
        );
    }, /Command failed/);
});

test('reset-password.js prints usage and exits non-zero with no arguments', () => {
    assert.throws(() => {
        execFileSync(process.execPath, [TOOL], { cwd: ROOT, env: { ...process.env, JT_DB_PATH: dbPath }, stdio: 'pipe' });
    }, /Command failed/);
});
